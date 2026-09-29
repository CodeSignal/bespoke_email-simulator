import { mailboxForThread, emailIsOutbound } from './mailboxes.js';

/**
 * Cosmo (assistant) helpers shared by the server and the browser bundle.
 *
 * - Capability gating: `assistant.capabilities` is turned into a prompt block
 *   that lists what Cosmo may do and what it must politely decline.
 * - Audience defaults: `learner` vs `candidate` (see `applyAudienceDefaults`).
 * - Mailbox context: the whole mailbox is serialized for the agent each turn,
 *   sent in full only when it changed since the previous turn.
 */

// ── Capabilities ──────────────────────────────────────────────

export const CAPABILITY_DEFS = {
  compose: {
    label: 'Compose & revise',
    enabled:
      'Draft new emails and replies, and revise or improve the user\'s current draft.',
    disabled:
      'Do not write, rewrite, or edit email text for the user. That includes full drafts, suggested wording, sample sentences, and revised versions of their draft.',
  },
  qa_search: {
    label: 'Answer questions & search',
    enabled:
      'Answer questions about the mailbox (who said what, commitments, dates, open questions) and find specific emails or threads.',
    disabled:
      'Do not answer questions about the contents of the mailbox or search it for the user.',
  },
  summarize: {
    label: 'Summarize',
    enabled: 'Give a concise catch-up summary of a thread or the mailbox.',
    disabled: 'Do not summarize emails, threads, or the mailbox.',
  },
  extract: {
    label: 'Extract',
    enabled: 'Pull out action items, decisions, deadlines, and key facts.',
    disabled:
      'Do not pull out or list action items, decisions, deadlines, or key facts from the emails.',
  },
  triage: {
    label: 'Inbox triage',
    enabled:
      'Rank what needs the user\'s reply or attention first across the mailbox. Give a short ordered list with who, why, and urgency. Stay neutral: rank and reason only; do not coach how to reply unless asked. Treat Spam-folder mail and blatant phishing as low priority for real work unless the user asks about them.',
    disabled:
      'Do not prioritize, rank, or triage the inbox (no "what should I answer first" lists).',
  },
};

export const VALID_CAPABILITIES = Object.keys(CAPABILITY_DEFS);

export const DEFAULT_CAPABILITIES = [...VALID_CAPABILITIES];

// Returns the capabilities that are both recognized and de-duplicated. A
// non-array falls back to every capability; unknown names are ignored here
// (validateScenario reports them).
export function normalizeCapabilities(list) {
  if (!Array.isArray(list)) return [...DEFAULT_CAPABILITIES];
  const seen = new Set();
  const out = [];
  for (const entry of list) {
    const id = String(entry ?? '').trim();
    if (CAPABILITY_DEFS[id] && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

// Prompt block injected into Cosmo's system prompt as {{CAPABILITIES}}.
export function buildCapabilityInstructions(list) {
  const enabled = normalizeCapabilities(list);
  const disabled = VALID_CAPABILITIES.filter((id) => !enabled.includes(id));

  const lines = ['What you can do:'];
  if (enabled.length) {
    for (const id of enabled) {
      const def = CAPABILITY_DEFS[id];
      lines.push(`- **${def.label}** — ${def.enabled}`);
    }
  } else {
    lines.push('- Nothing. Every assistant feature is turned off in this workspace.');
  }

  if (disabled.length) {
    lines.push('', 'Turned off in this workspace (do not do these, even if asked):');
    for (const id of disabled) {
      const def = CAPABILITY_DEFS[id];
      lines.push(`- **${def.label}** — ${def.disabled}`);
    }
    lines.push(
      '',
      'If the user asks for something that is turned off, say briefly that you can\'t do that here, and mention what you can do. Do not do a partial or disguised version of it.',
    );
  }
  return lines.join('\n');
}

// ── Audience ──────────────────────────────────────────────────

export const VALID_AUDIENCES = ['learner', 'candidate'];

// Candidates are being assessed, so everyone should get the same assistant:
// a pinned model, low temperature, and no learner-authored instructions.
// (Keep the model in step with the default in agents/cosmo-mail/protocol.yaml.)
export const CANDIDATE_DEFAULTS = {
  model: 'anthropic/claude-opus-4-7',
  temperature: 0.2,
};

/**
 * Applies audience-specific defaults to a merged scenario config. `raw` is the
 * author's original config, used to tell "left unset" from "set on purpose".
 */
export function applyAudienceDefaults(merged, raw = {}) {
  if (merged.audience !== 'candidate') return merged;
  const authored = raw.generation ?? {};
  if (authored.model === undefined) merged.generation.model = CANDIDATE_DEFAULTS.model;
  if (authored.temperature === undefined) {
    merged.generation.temperature = CANDIDATE_DEFAULTS.temperature;
  }
  merged.assistant.allowCustomInstructions = false;
  return merged;
}

// ── Mailbox context ───────────────────────────────────────────

// Small, dependency-free 32-bit FNV-1a hash used to detect mailbox changes.
export function hashText(text) {
  let hash = 0x811c9dc5;
  const str = String(text ?? '');
  for (let i = 0; i < str.length; i += 1) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function formatAddress(addr) {
  if (!addr) return '';
  if (typeof addr === 'string') return addr;
  return addr.name ? `${addr.name} <${addr.email}>` : addr.email || '';
}

function formatAddressList(list) {
  if (!list) return '';
  return (Array.isArray(list) ? list : [list]).map(formatAddress).filter(Boolean).join(', ');
}

// ISO in UTC so the text does not depend on the browser's locale or time zone.
function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

const FOLDER_LABELS = { inbox: 'Inbox', sent: 'Sent', spam: 'Spam' };

/** Soft cap on THREAD_CONTEXT mailbox payload (chars). Oversized mailboxes are truncated. */
export const MAILBOX_CONTEXT_MAX_CHARS = 100_000;

/**
 * Fence seeded attachment text so embedded backticks cannot close the block.
 * Uses a backtick run one longer than any run in the text (CommonMark rule).
 */
export function fenceAttachmentText(text) {
  const runs = String(text).match(/`+/g) || [];
  const longest = runs.reduce((n, run) => Math.max(n, run.length), 2);
  const fence = '`'.repeat(longest + 1);
  return [fence, String(text), fence];
}

/**
 * Serialize attachment metadata for Cosmo's mailbox context.
 *
 * Seeded inbound attachments may include author-provided `text` (readable
 * contents for Q&A / summarize / extract). Name-only attachments have unknown
 * contents — do not invent them. Outbound / learner attachments never include
 * `text` here even if a field were present.
 */
export function serializeAttachments(attachments, { includeText = true } = {}) {
  const list = Array.isArray(attachments) ? attachments : [];
  if (!list.length) return [];

  const lines = ['Attachments:'];
  for (const a of list) {
    const name = a?.name || 'file';
    const text = includeText && typeof a?.text === 'string' ? a.text : null;
    if (text != null && text.length) {
      lines.push(`- ${name} (seeded text follows)`);
      lines.push(...fenceAttachmentText(text));
    } else {
      lines.push(`- ${name}`);
    }
  }
  return lines;
}

function serializeThread(thread, index, learnerEmail) {
  const folder = FOLDER_LABELS[mailboxForThread(thread, learnerEmail)] ?? 'Inbox';
  const lines = [
    `#### Thread ${index + 1}: ${thread.subject || '(no subject)'} [${folder}] (id: ${thread.id})`,
    '',
  ];
  const emails = thread.emails ?? [];
  if (!emails.length) {
    lines.push('(no emails)', '');
  }
  for (const email of emails) {
    const fromLearner = emailIsOutbound(email, learnerEmail);
    lines.push(`From: ${formatAddress(email.from)}${fromLearner ? ' (the user)' : ''}`);
    lines.push(`To: ${formatAddressList(email.to)}`);
    if (email.cc?.length) lines.push(`Cc: ${formatAddressList(email.cc)}`);
    if (email.date) lines.push(`Date: ${formatDate(email.date)}`);
    if (email.subject && email.subject !== thread.subject) lines.push(`Subject: ${email.subject}`);
    if (email.attachments?.length) {
      // Inbound seeds only: learner outbound attachments stay name-only.
      lines.push(...serializeAttachments(email.attachments, { includeText: !fromLearner }));
    }
    lines.push('', String(email.body ?? ''), '', '---', '');
  }
  return lines.join('\n');
}

// The full mailbox as Markdown. Used both to hash for change detection and as
// the body of a "full state" block.
export function serializeMailbox(threads, { learnerEmail = '' } = {}) {
  const list = threads ?? [];
  if (!list.length) return 'The mailbox is empty.';
  return list.map((thread, i) => serializeThread(thread, i, learnerEmail)).join('\n');
}

function describeViewing(threads, viewing = {}) {
  if (viewing.composingNew) return 'a new message in the composer';
  if (viewing.threadId) {
    const thread = (threads ?? []).find((th) => th.id === viewing.threadId);
    if (thread) return `thread "${thread.subject || '(no subject)'}" (id: ${thread.id})`;
  }
  const folder = FOLDER_LABELS[viewing.mailbox];
  return folder ? `the ${folder} list` : 'the mailbox list';
}

/**
 * Builds the per-turn mailbox context sent as THREAD_CONTEXT.
 *
 * The whole mailbox is included so Cosmo can search and triage across threads.
 * To keep long chats cheap (and to avoid stale copies confusing the model), the
 * full state is only sent when it differs from `previousHash`; otherwise a short
 * "unchanged" marker points back at the last full state.
 *
 * Oversized mailboxes (including seeded attachment text) are truncated to
 * `maxChars` (default {@link MAILBOX_CONTEXT_MAX_CHARS}) so the request can
 * still proceed. The hash is of the truncated payload so change detection
 * matches what Cosmo actually saw.
 *
 * Returns { text, hash, unchanged }.
 */
export function buildMailboxContext({
  threads,
  learnerEmail = '',
  viewing = {},
  previousHash = null,
  maxChars = MAILBOX_CONTEXT_MAX_CHARS,
} = {}) {
  let mailbox = serializeMailbox(threads, { learnerEmail });
  if (typeof maxChars === 'number' && maxChars > 0 && mailbox.length > maxChars) {
    mailbox =
      mailbox.slice(0, maxChars) +
      '\n\n[Mailbox truncated: exceeded context budget. Some emails or attachment text may be missing.]';
  }
  const hash = hashText(mailbox);
  const unchanged = previousHash != null && previousHash === hash;

  const lines = [`Currently viewing: ${describeViewing(threads, viewing)}`, ''];
  if (unchanged) {
    lines.push(
      `Mailbox state ${hash}: unchanged since the most recent full mailbox state earlier in this conversation. Use that one.`,
    );
  } else {
    lines.push(
      `### Mailbox state ${hash}`,
      'This replaces any earlier mailbox state in this conversation.',
      '',
      mailbox,
    );
  }
  return { text: lines.join('\n'), hash, unchanged };
}
