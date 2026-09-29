/**
 * Cosmo quick-action chips: product affordances that call a separate Octavus
 * trigger (no chat history) and log as provenance events — not as learner turns.
 */

import { normalizeCapabilities } from './assistant.js';
import { normalizeDraftFields } from './provenance.js';

export const QUICK_ACTION_SOURCE = 'quick-action';

/** Actions Cosmo can run via the quick-action trigger. */
export const QUICK_ACTIONS = {
  suggested_replies: {
    id: 'suggested_replies',
    label: 'Suggest replies',
    requires: ['compose'],
    /** Show when viewing a thread (inbound context to reply to). */
    needsThread: true,
    needsComposer: false,
  },
  rewrite: {
    id: 'rewrite',
    label: 'Rewrite',
    requires: ['compose'],
    needsThread: false,
    needsComposer: true,
  },
  shorten: {
    id: 'shorten',
    label: 'Shorten',
    requires: ['compose'],
    needsThread: false,
    needsComposer: true,
  },
  tone: {
    id: 'tone',
    label: 'Professional tone',
    requires: ['compose'],
    needsThread: false,
    needsComposer: true,
  },
  proofread: {
    id: 'proofread',
    label: 'Proofread',
    requires: ['compose'],
    needsThread: false,
    needsComposer: true,
  },
  subject_recipients: {
    id: 'subject_recipients',
    label: 'Suggest subject & recipients',
    requires: ['compose'],
    needsThread: false,
    needsComposer: true,
  },
};

export const VALID_QUICK_ACTIONS = Object.keys(QUICK_ACTIONS);

/** Default model for one-shot quick-action sessions (cheaper/faster than chat). */
export const QUICK_ACTION_MODEL = 'anthropic/claude-haiku-4-5';

export const QUICK_ACTION_TOOLS = {
  PROPOSE_SUGGESTED_REPLIES: 'propose-suggested-replies',
  PROPOSE_HEADERS: 'propose-headers',
};

/**
 * Normalize `assistant.quickActions`:
 * - undefined / true → all valid actions
 * - false → none
 * - string[] → those ids (unknown dropped)
 */
export function normalizeQuickActionsConfig(value) {
  if (value === false) return [];
  if (value === undefined || value === true) return [...VALID_QUICK_ACTIONS];
  if (!Array.isArray(value)) return [...VALID_QUICK_ACTIONS];
  const seen = new Set();
  const out = [];
  for (const entry of value) {
    const id = String(entry ?? '').trim();
    if (QUICK_ACTIONS[id] && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/**
 * Chips the UI may show, given capabilities + quickActions author config.
 * Context filters (thread open / composer open) are applied by the caller.
 */
export function resolveQuickActionChips({
  capabilities,
  quickActions,
} = {}) {
  const enabledCaps = new Set(normalizeCapabilities(capabilities));
  const allowed = normalizeQuickActionsConfig(quickActions);
  return allowed
    .map((id) => QUICK_ACTIONS[id])
    .filter((def) => def && def.requires.every((cap) => enabledCaps.has(cap)));
}

export function isValidQuickAction(action) {
  return Boolean(QUICK_ACTIONS[String(action ?? '').trim()]);
}

/** Pull 2–3 reply body strings from tool args (reply1/2/3 or replies JSON). */
export function normalizeSuggestedReplies(raw = {}) {
  const fromFields = [raw.reply1, raw.reply2, raw.reply3]
    .map((s) => String(s ?? '').trim())
    .filter(Boolean);
  if (fromFields.length) return fromFields.slice(0, 3);

  if (Array.isArray(raw.replies)) {
    return raw.replies
      .map((entry) => {
        if (typeof entry === 'string') return entry.trim();
        if (entry && typeof entry === 'object') {
          return String(entry.body ?? entry.text ?? entry.label ?? '').trim();
        }
        return '';
      })
      .filter(Boolean)
      .slice(0, 3);
  }

  if (typeof raw.replies === 'string' && raw.replies.trim()) {
    try {
      const parsed = JSON.parse(raw.replies);
      return normalizeSuggestedReplies({ replies: parsed });
    } catch {
      return raw.replies
        .split(/\n{2,}/)
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, 3);
    }
  }
  return [];
}

export function normalizeHeaderSuggestion(raw = {}) {
  const fields = normalizeDraftFields({ ...raw, body: '' });
  return {
    to: fields.to,
    cc: fields.cc,
    subject: fields.subject,
  };
}

/** Short instruction block injected into the quick-action user prompt. */
export function actionInstruction(action, detail = '') {
  const extra = String(detail ?? '').trim();
  switch (action) {
    case 'suggested_replies':
      return [
        'Suggest 2 or 3 short reply options the user could send as a reply to the focused email.',
        'Call propose-suggested-replies with reply1, reply2, and optionally reply3.',
        'Each reply is a complete short email body the user can send as-is (include a brief greeting and sign-off).',
        'Keep each option to about 2–4 short sentences. Make them distinct in intent.',
        'Do not wrap replies in quotes or label them.',
        extra ? `Extra guidance: ${extra}` : '',
      ]
        .filter(Boolean)
        .join(' ');
    case 'rewrite':
      return [
        'Rewrite the current draft as a full ready-to-send email.',
        'Call propose-draft with to, optional cc, subject, and body.',
        'Preserve the user’s intent; improve clarity and flow. Do not coach.',
        extra ? `Extra guidance: ${extra}` : '',
      ]
        .filter(Boolean)
        .join(' ');
    case 'shorten':
      return [
        'Shorten the current draft while keeping the same meaning and recipients/subject when possible.',
        'Call propose-draft with the shortened email.',
        extra ? `Extra guidance: ${extra}` : '',
      ]
        .filter(Boolean)
        .join(' ');
    case 'tone':
      return [
        'Rewrite the current draft in a clear, professional tone.',
        'Call propose-draft with the revised email. Do not change the factual content.',
        extra ? `Extra guidance: ${extra}` : '',
      ]
        .filter(Boolean)
        .join(' ');
    case 'proofread':
      return [
        'Proofread the current draft: fix grammar, spelling, and small clarity issues only.',
        'Call propose-draft with the corrected email. Do not change meaning or tone.',
        extra ? `Extra guidance: ${extra}` : '',
      ]
        .filter(Boolean)
        .join(' ');
    case 'subject_recipients':
      return [
        'Suggest To, optional Cc, and Subject for the email the user is writing,',
        'based on the mailbox and current draft.',
        'Call propose-headers with to, optional cc, and subject (real addresses from the mailbox).',
        'Do not write a body.',
        extra ? `Extra guidance: ${extra}` : '',
      ]
        .filter(Boolean)
        .join(' ');
    default:
      return 'Perform the requested quick action using the appropriate tool.';
  }
}
