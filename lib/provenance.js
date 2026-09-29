/**
 * AI draft provenance helpers for CosmoMail assessment.
 *
 * Session events track when Cosmo proposes a draft, when the learner inserts
 * it into the composer, and how much they edited before sending.
 */

export const PROPOSE_DRAFT_TOOL = 'propose-draft';

export const EVENT_TYPES = {
  DRAFT_PROPOSED: 'draft_proposed',
  DRAFT_INSERTED: 'draft_inserted',
  DRAFT_SENT: 'draft_sent',
  /** Chip / one-shot Cosmo action (not a learner chat turn). */
  QUICK_ACTION: 'quick_action',
};

// Works in Node and the browser bundle (no node:crypto import).
function randomId() {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function asString(value) {
  return String(value ?? '').trim();
}

function splitAddressList(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => asString(entry)).filter(Boolean);
  }
  return asString(value)
    .split(/,(?![^<]*>)/)
    .map((part) => part.trim())
    .filter(Boolean);
}

/** Normalize a propose_draft payload (tool args or fence parse) into composer fields. */
export function normalizeDraftFields(raw = {}) {
  return {
    to: splitAddressList(raw.to),
    cc: splitAddressList(raw.cc),
    subject: asString(raw.subject),
    body: String(raw.body ?? '').replace(/^\n+/, '').trimEnd(),
  };
}

/** Serialize draft fields back into the header-block form parseInsertedDraft understands. */
export function draftFieldsToMarkdown(draft) {
  const fields = normalizeDraftFields(draft);
  const lines = [];
  if (fields.to.length) lines.push(`To: ${fields.to.join(', ')}`);
  if (fields.cc.length) lines.push(`Cc: ${fields.cc.join(', ')}`);
  if (fields.subject) lines.push(`Subject: ${fields.subject}`);
  if (lines.length) lines.push('');
  lines.push(fields.body);
  return lines.join('\n').trim();
}

export function newDraftId() {
  return `draft-${randomId()}`;
}

export function makeEvent(type, payload = {}) {
  return {
    type,
    timestamp: new Date().toISOString(),
    ...payload,
  };
}

export function makeDraftProposedEvent({
  draftId = newDraftId(),
  source = PROPOSE_DRAFT_TOOL,
  draft,
  toolCallId = null,
} = {}) {
  return makeEvent(EVENT_TYPES.DRAFT_PROPOSED, {
    draftId,
    source,
    toolCallId,
    draft: normalizeDraftFields(draft),
  });
}

export function makeDraftInsertedEvent({
  draftId,
  draft,
  scope = { scope: 'new' },
  source = PROPOSE_DRAFT_TOOL,
} = {}) {
  return makeEvent(EVENT_TYPES.DRAFT_INSERTED, {
    draftId: draftId || newDraftId(),
    source,
    scope,
    draft: normalizeDraftFields(draft),
  });
}

/** Classic Levenshtein distance for short email subjects/bodies. */
export function levenshtein(a, b) {
  const left = String(a ?? '');
  const right = String(b ?? '');
  if (left === right) return 0;
  if (!left.length) return right.length;
  if (!right.length) return left.length;

  const prev = new Array(right.length + 1);
  const curr = new Array(right.length + 1);
  for (let j = 0; j <= right.length; j += 1) prev[j] = j;

  for (let i = 1; i <= left.length; i += 1) {
    curr[0] = i;
    for (let j = 1; j <= right.length; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= right.length; j += 1) prev[j] = curr[j];
  }
  return prev[right.length];
}

function addressKeySet(list) {
  return new Set(splitAddressList(list).map((email) => email.toLowerCase()));
}

function setDistance(a, b) {
  const left = addressKeySet(a);
  const right = addressKeySet(b);
  let added = 0;
  let removed = 0;
  for (const email of right) if (!left.has(email)) added += 1;
  for (const email of left) if (!right.has(email)) removed += 1;
  return { added, removed, total: added + removed };
}

/** Compare an Inserted AI draft to the email the learner actually sent. */
export function draftEditDistance(inserted, sent) {
  const before = normalizeDraftFields(inserted);
  const after = normalizeDraftFields(sent);
  const body = levenshtein(before.body, after.body);
  const subject = levenshtein(before.subject, after.subject);
  const to = setDistance(before.to, after.to);
  const cc = setDistance(before.cc, after.cc);
  return {
    body,
    subject,
    to,
    cc,
    total: body + subject + to.total + cc.total,
  };
}

export function makeDraftSentEvent({
  draftId = null,
  emailId = null,
  threadId = null,
  inserted = null,
  sent,
} = {}) {
  const sentFields = normalizeDraftFields(sent);
  const insertedFields = inserted ? normalizeDraftFields(inserted) : null;
  return makeEvent(EVENT_TYPES.DRAFT_SENT, {
    draftId,
    emailId,
    threadId,
    inserted: insertedFields,
    sent: sentFields,
    editDistance: insertedFields ? draftEditDistance(insertedFields, sentFields) : null,
  });
}

/**
 * Log a chip / one-shot quick action. Kept separate from assistant transcript
 * so prompting assessments are not polluted by product affordances.
 */
export function makeQuickActionEvent({
  action,
  source = 'quick-action',
  draftId = null,
  draft = null,
  replies = null,
  headers = null,
  detail = null,
  threadId = null,
} = {}) {
  return makeEvent(EVENT_TYPES.QUICK_ACTION, {
    action: String(action ?? '').trim(),
    source,
    draftId,
    ...(draft ? { draft: normalizeDraftFields(draft) } : {}),
    ...(Array.isArray(replies) && replies.length ? { replies } : {}),
    ...(headers
      ? {
          headers: (({ to, cc, subject }) => ({ to, cc, subject }))(
            normalizeDraftFields({ ...headers, body: '' }),
          ),
        }
      : {}),
    ...(detail ? { detail: String(detail) } : {}),
    ...(threadId ? { threadId } : {}),
  });
}

/**
 * Pull structured drafts from Octavus UI message parts (propose-draft tool calls).
 * Returns { drafts, events } ready to persist alongside the assistant transcript.
 *
 * `seenToolCallIds` only suppresses duplicate *events* — drafts are always
 * returned so re-persisting a transcript does not wipe card data.
 */
export function draftsFromMessageParts(parts = [], { seenToolCallIds = new Set() } = {}) {
  const drafts = [];
  const events = [];
  for (const part of parts) {
    if (part?.type !== 'tool-call') continue;
    const name = part.toolName || part.name;
    if (name !== PROPOSE_DRAFT_TOOL) continue;
    if (part.status && part.status !== 'done' && part.status !== 'running' && part.status !== 'pending') {
      continue;
    }
    const toolCallId = part.toolCallId || part.id || null;
    const args = part.args || part.input || part.result || {};
    const draft = normalizeDraftFields(args);
    if (!draft.body && !draft.subject && !draft.to.length) continue;

    const alreadySeen = toolCallId && seenToolCallIds.has(toolCallId);
    // Stable id so re-persisting the same tool call does not orphan insert/sent events.
    const draftId = toolCallId ? `draft-${toolCallId}` : newDraftId();
    drafts.push({
      draftId,
      toolCallId,
      source: PROPOSE_DRAFT_TOOL,
      ...draft,
    });
    if (alreadySeen) continue;
    if (toolCallId) seenToolCallIds.add(toolCallId);
    events.push(
      makeDraftProposedEvent({
        draftId,
        source: PROPOSE_DRAFT_TOOL,
        toolCallId,
        draft,
      }),
    );
  }
  return { drafts, events };
}

/** Append events, skipping draft_proposed duplicates for the same toolCallId. */
export function appendSessionEvents(existing = [], next = []) {
  const out = [...(existing ?? [])];
  const seenToolCalls = new Set(
    out
      .filter((event) => event.type === EVENT_TYPES.DRAFT_PROPOSED && event.toolCallId)
      .map((event) => event.toolCallId),
  );
  for (const event of next) {
    if (
      event?.type === EVENT_TYPES.DRAFT_PROPOSED
      && event.toolCallId
      && seenToolCalls.has(event.toolCallId)
    ) {
      continue;
    }
    if (event?.type === EVENT_TYPES.DRAFT_PROPOSED && event.toolCallId) {
      seenToolCalls.add(event.toolCallId);
    }
    out.push(event);
  }
  return out;
}
