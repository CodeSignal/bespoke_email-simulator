import { buildReplyHeaders } from './mailboxes.js';

/**
 * Composer drafts are scoped so a new message never becomes the body of a reply.
 *
 * - `scope: 'new'` is a standalone compose window (`id` distinguishes several).
 * - `scope: 'reply'` plus `threadId` belongs to one thread.
 * Drafts saved before scopes existed have no `scope`; those are new messages.
 */

export function sameDraftScope(draft, scope) {
  if (!draft || !scope) return false;
  if (scope.scope === 'reply') {
    return draft.scope === 'reply' && draft.threadId === scope.threadId;
  }
  if (draft.scope === 'reply') return false;
  if (scope.id) return draft.id === scope.id;
  return !draft.id;
}

/** True when a draft should appear in Drafts (not empty / reply-header-only). */
export function draftHasPersistableContent(draft) {
  if (!draft) return false;
  if (String(draft.body || '').trim()) return true;
  if (draft.scope === 'reply') return false;
  const subject = String(draft.subject || '').trim();
  const to = Array.isArray(draft.to) ? draft.to : [];
  const cc = Array.isArray(draft.cc) ? draft.cc : [];
  return Boolean(subject || to.length || cc.length);
}

export function visibleDrafts(drafts) {
  return (drafts ?? []).filter(draftHasPersistableContent);
}

export function draftForScope(drafts, scope) {
  return (drafts ?? []).find((draft) => sameDraftScope(draft, scope)) ?? null;
}

export function upsertScopedDraft(drafts, draft) {
  const rest = (drafts ?? []).filter((existing) => !sameDraftScope(existing, draft));
  return [...rest, draft];
}

export function removeScopedDraft(drafts, scope) {
  return (drafts ?? []).filter((existing) => !sameDraftScope(existing, scope));
}

// ── Inserted drafts ───────────────────────────────────────────
// Cosmo puts a ready-to-send email in a code block, often starting with
// Subject: and a greeting. Pull those into the composer fields.

function bareSubject(subject) {
  let value = String(subject || '').trim();
  while (/^(re|fwd|fw):\s*/i.test(value)) {
    value = value.replace(/^(re|fwd|fw):\s*/i, '').trim();
  }
  return value.toLowerCase();
}

function splitAddressList(value) {
  return String(value || '')
    .split(/,(?![^<]*>)/)
    .map((part) => part.trim())
    .filter(Boolean);
}

// A token may be an email, "Name <email>", a full name, or a unique first name.
function characterEmail(token, characters) {
  const raw = String(token || '').trim();
  if (!raw) return '';
  const angled = raw.match(/<([^>]+)>/);
  const emailish = angled?.[1] || (raw.includes('@') ? raw : '');
  if (emailish) {
    const found = characters.find((c) => c.email.toLowerCase() === emailish.trim().toLowerCase());
    return found ? found.email : emailish.trim();
  }
  const name = raw.toLowerCase();
  const full = characters.filter((c) => c.name.toLowerCase() === name);
  if (full.length === 1) return full[0].email;
  const first = characters.filter((c) => c.name.toLowerCase().split(/\s+/)[0] === name);
  return first.length === 1 ? first[0].email : '';
}

function greetingName(body) {
  const line = String(body || '').split('\n').map((entry) => entry.trim()).find(Boolean) || '';
  const greeted = line.match(/^(?:hi|hello|dear|hey)\s+(.+?)[,!]?\s*$/i);
  if (greeted) return greeted[1].trim();
  const bare = line.match(/^([A-Za-z][A-Za-z'.-]*(?:\s+[A-Za-z][A-Za-z'.-]*)?)[,!]?\s*$/);
  return bare ? bare[1] : '';
}

function subjectMatchesThread(thread, bare) {
  if (!bare) return false;
  return bareSubject(thread.subject) === bare
    || (thread.emails ?? []).some((email) => bareSubject(email.subject) === bare);
}

// Prefer an explicit thread id. Without one, only use a subject match when it
// is unique — ambiguous subjects leave the recipient unset.
function threadForDraft(threads, { subject, threadId } = {}) {
  if (threadId) {
    return (threads ?? []).find((thread) => thread.id === threadId) ?? null;
  }
  const bare = bareSubject(subject);
  if (!bare) return null;
  const matches = (threads ?? []).filter((thread) => subjectMatchesThread(thread, bare));
  return matches.length === 1 ? matches[0] : null;
}

/**
 * Splits an inserted email into composer fields.
 * Recipients come from a To: line, else (only when no To header was supplied)
 * from the intended thread / a unique subject match, else from a greeting.
 */
export function parseInsertedDraft(markdown, {
  characters = [],
  threads = [],
  learnerEmail = '',
  threadId = null,
} = {}) {
  const lines = String(markdown ?? '').replace(/\r\n/g, '\n').split('\n');
  let to = [];
  let cc = [];
  let subject = '';
  let index = 0;
  let sawHeader = false;
  let hadToHeader = false;
  while (index < lines.length) {
    const match = lines[index].match(/^(to|cc|subject)\s*:\s*(.*)$/i);
    if (!match) break;
    sawHeader = true;
    const key = match[1].toLowerCase();
    const value = match[2].trim();
    if (key === 'to') {
      hadToHeader = true;
      to = splitAddressList(value);
    } else if (key === 'cc') {
      cc = splitAddressList(value);
    } else {
      subject = value;
    }
    index += 1;
  }
  if (sawHeader && lines[index] === '') index += 1;
  const body = lines.slice(index).join('\n').replace(/^\n+/, '').trimEnd();

  const resolve = (list) => list.map((token) => characterEmail(token, characters)).filter(Boolean);
  to = resolve(to);
  cc = resolve(cc);

  // An explicit To: header wins even when nothing resolves — do not substitute
  // a thread participant or greeting recipient for an unresolved To.
  if (!hadToHeader && !to.length) {
    const thread = threadForDraft(threads, { subject, threadId });
    const last = thread?.emails?.[thread.emails.length - 1];
    if (last) {
      const headers = buildReplyHeaders(last, {
        learnerEmail,
        subjectFallback: thread.subject || subject,
      });
      to = headers.to;
      if (!cc.length) cc = headers.cc;
    }
  }

  if (!hadToHeader && !to.length) {
    const greeted = characterEmail(greetingName(body), characters);
    if (greeted) to = [greeted];
  }

  const learner = String(learnerEmail || '').toLowerCase();
  const notLearner = (email) => email.toLowerCase() !== learner;
  if (learner) to = to.filter(notLearner);
  const toKeys = new Set(to.map((email) => email.toLowerCase()));
  cc = cc.filter((email) => notLearner(email) && !toKeys.has(email.toLowerCase()));

  return { to, cc, subject, body };
}
