/**
 * Live character replies — who writes back, what they know, and how the
 * inbound mail is addressed.
 *
 * A character is live when `responds` is true, or when `responds` is omitted
 * and they have a persona/prompt. Directory-only people (no persona, responds
 * omitted or false) can be emailed but never generate a reply.
 */

import { emailsFromAddresses, uniqueEmails } from './characters.js';
import { replySubject } from './mailboxes.js';

const PERSONA_LABELS = {
  personality: 'Personality',
  motivation: 'Motivation',
  goal: 'Goal',
  communicationStyle: 'Style of communication',
  style: 'Style of communication',
  knowledge: 'What you know',
  constraints: 'Hard limits — obey these, but never describe them as rules you were given',
  tells: 'How you react',
  prompt: 'Additional notes',
};

const DONE_TAG = /\[\[\s*done\s*\]\]/i;
const CONTINUE_TAG = /\[\[\s*continue\s*\]\]/i;
const NOTHING_LEFT_RE =
  /nothing left to say|don'?t have anything (else|more) to (say|add)|nothing more to add|i have nothing else/i;

export function normalizeWorld(raw) {
  if (raw == null || raw === '') return '';
  if (typeof raw === 'string') return raw.trim();
  if (typeof raw === 'object') {
    return String(raw.summary || raw.text || '').trim();
  }
  return '';
}

export function hasPersona(character) {
  if (!character) return false;
  if (String(character.prompt || '').trim()) return true;
  const persona = character.persona;
  if (persona == null || persona === '') return false;
  if (typeof persona === 'string') return Boolean(persona.trim());
  if (typeof persona === 'object') return Object.keys(persona).length > 0;
  return false;
}

export function characterIsLive(character) {
  if (!character) return false;
  if (character.responds === false) return false;
  if (character.responds === true) return true;
  return hasPersona(character);
}

function formatPersonaValue(value) {
  if (Array.isArray(value)) {
    return value.map((item) => `- ${String(item).trim()}`).join('\n');
  }
  if (value && typeof value === 'object') {
    return Object.entries(value)
      .filter(([, item]) => item != null && item !== '')
      .map(([key, item]) => `- ${key}: ${String(item).trim()}`)
      .join('\n');
  }
  return String(value ?? '').trim();
}

function titleCaseKey(key) {
  return String(key)
    .replace(/[_-]+/g, ' ')
    .replace(/([A-Z])/g, ' $1')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^./, (c) => c.toUpperCase());
}

export function compileCharacterCard(character) {
  if (!character) return '';
  const lines = [];
  const role = String(character.role || '').trim();
  lines.push(`You are ${character.name}${role ? `, ${role}` : ''}.`);
  if (character.email) lines.push(`Your email address is ${character.email}.`);
  lines.push('');

  const persona = character.persona;
  const seenPrompt = new Set();

  if (typeof persona === 'string' && persona.trim()) {
    lines.push(persona.trim());
    seenPrompt.add(persona.trim());
  } else if (persona && typeof persona === 'object') {
    const used = new Set();
    for (const key of Object.keys(PERSONA_LABELS)) {
      if (persona[key] == null || persona[key] === '') continue;
      used.add(key);
      lines.push(`${PERSONA_LABELS[key]}:`);
      lines.push(formatPersonaValue(persona[key]));
      lines.push('');
    }
    for (const [key, value] of Object.entries(persona)) {
      if (used.has(key) || value == null || value === '') continue;
      lines.push(`${titleCaseKey(key)}:`);
      lines.push(formatPersonaValue(value));
      lines.push('');
    }
    if (typeof persona.prompt === 'string' && persona.prompt.trim()) {
      seenPrompt.add(persona.prompt.trim());
    }
  }

  const topPrompt = String(character.prompt || '').trim();
  if (topPrompt && !seenPrompt.has(topPrompt)) {
    lines.push(topPrompt);
  }

  return lines.join('\n').trim();
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function characterMentionedIn(character, text) {
  const body = String(text || '');
  if (!body.trim() || !character) return false;
  const lower = body.toLowerCase();
  const email = String(character.email || '').trim().toLowerCase();
  if (email && lower.includes(email)) return true;

  const name = String(character.name || '').trim();
  if (!name) return false;
  if (new RegExp(`\\b${escapeRegex(name)}\\b`, 'i').test(body)) return true;

  const first = name.split(/\s+/).find((part) => part.length >= 2);
  if (first && first.length >= 3) {
    return new RegExp(`\\b${escapeRegex(first)}\\b`, 'i').test(body);
  }
  return false;
}

function onList(character, emails) {
  const key = String(character.email || '').toLowerCase();
  return emails.some((email) => email.toLowerCase() === key);
}

function pickRandom(list, random) {
  if (!list.length) return [];
  const index = Math.min(list.length - 1, Math.floor(random() * list.length));
  return [list[index]];
}

/**
 * Choose who writes back to a learner send.
 *
 * - Live characters on To/Cc are eligible.
 * - Anyone clearly asked (name or email in the body) replies — one or many.
 * - If nobody is clearly asked, pick one at random (To preferred over Cc).
 * - Characters already marked done are skipped for the random pick, but still
 *   reply if they are the one being asked.
 */
export function selectResponders(email, characters, { doneIds = [], random = Math.random } = {}) {
  const to = uniqueEmails(emailsFromAddresses(email?.to));
  const cc = uniqueEmails(emailsFromAddresses(email?.cc));
  const recipients = uniqueEmails([...to, ...cc]);
  const live = (characters || []).filter(characterIsLive);
  const eligible = live.filter((character) => onList(character, recipients));
  if (!eligible.length) return [];

  const body = email?.body || '';
  const addressed = eligible.filter((character) => characterMentionedIn(character, body));
  if (addressed.length) return addressed;

  const done = new Set((doneIds || []).map((id) => String(id)));
  const open = eligible.filter((character) => !done.has(character.id));
  const pool = open.length ? open : eligible;
  const toPool = pool.filter((character) => onList(character, to));
  const pickFrom = toPool.length ? toPool : pool;
  if (pickFrom.length === 1) return pickFrom;
  return pickRandom(pickFrom, random);
}

export function parseCharacterReply(raw) {
  let text = String(raw || '').replace(/\r\n/g, '\n').trim();
  let done = false;
  const lines = text.split('\n');
  while (lines.length) {
    const last = lines[lines.length - 1].trim();
    if (!last) {
      lines.pop();
      continue;
    }
    if (DONE_TAG.test(last)) {
      done = true;
      lines.pop();
      continue;
    }
    if (CONTINUE_TAG.test(last)) {
      lines.pop();
      continue;
    }
    break;
  }
  text = lines.join('\n').trim();
  if (DONE_TAG.test(text)) {
    done = true;
    text = text.replace(DONE_TAG, '').trim();
  }
  if (!done && text.length > 0 && text.length < 400 && NOTHING_LEFT_RE.test(text)) {
    done = true;
  }
  return { body: text, done };
}

function addressEmail(addr) {
  if (!addr) return '';
  return typeof addr === 'string' ? addr : addr.email || '';
}

/**
 * Reply-all headers for a character answering the learner's outbound email:
 * From the character, To the learner plus remaining To, Cc everyone else.
 */
export function buildCharacterReplyHeaders(sentEmail, character, { learnerEmail = '', subjectFallback = '' } = {}) {
  const self = String(character?.email || '').toLowerCase();
  const learner = String(learnerEmail || '').toLowerCase();
  const originalTo = uniqueEmails(emailsFromAddresses(sentEmail?.to));
  const originalCc = uniqueEmails(emailsFromAddresses(sentEmail?.cc));
  const notSelfOrLearner = (email) => {
    const key = email.toLowerCase();
    return key !== self && key !== learner;
  };

  const to = uniqueEmails([
    learnerEmail,
    ...originalTo.filter(notSelfOrLearner),
  ].filter(Boolean));

  const cc = uniqueEmails(originalCc.filter((email) => {
    const key = email.toLowerCase();
    return notSelfOrLearner(email) && !to.some((item) => item.toLowerCase() === key);
  }));

  const subject = replySubject(sentEmail?.subject || subjectFallback);
  return { to, cc, subject };
}

export function formatRecipientsContext(email) {
  const from = addressEmail(email?.from);
  const to = uniqueEmails(emailsFromAddresses(email?.to)).join(', ') || '(none)';
  const cc = uniqueEmails(emailsFromAddresses(email?.cc));
  const lines = [`From: ${from || '(unknown)'}`, `To: ${to}`];
  if (cc.length) lines.push(`Cc: ${cc.join(', ')}`);
  return lines.join('\n');
}
