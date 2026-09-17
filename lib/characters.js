/**
 * Simulation characters — the people a learner may put on To / Cc.
 *
 * Extra fields (`role`, `persona`, `prompt`, `responds`, `avatar`, …) are
 * preserved. Live vs directory-only is decided in `lib/character-replies.js`.
 */

export const AVATAR_COUNT = 12;
export const EMPTY_AVATAR = 0;

export function normalizeAvatar(value) {
  if (value == null || value === '') return null;
  const raw = String(value).trim().toLowerCase().replace(/^avatar-/, '');
  if (raw === 'empty' || raw === '00') return EMPTY_AVATAR;
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n < EMPTY_AVATAR || n > AVATAR_COUNT) return null;
  return n;
}

export function avatarPath(value) {
  const id = normalizeAvatar(value);
  if (id == null) return null;
  if (id === EMPTY_AVATAR) return '/avatars/avatar-00.svg';
  return `/avatars/avatar-${String(id).padStart(2, '0')}.png`;
}

export function initialsFromName(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
}

function slugFromEmail(email) {
  const local = String(email).split('@')[0] || '';
  const slug = local
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'character';
}

export function emailsFromAddresses(value) {
  if (value == null || value === '') return [];
  if (typeof value === 'string') {
    return value.split(',').map((part) => part.trim()).filter(Boolean);
  }
  const list = Array.isArray(value) ? value : [value];
  return list
    .map((entry) => {
      if (typeof entry === 'string') return entry.trim();
      return String(entry?.email || '').trim();
    })
    .filter(Boolean);
}

export function uniqueEmails(emails) {
  const seen = new Set();
  const out = [];
  for (const email of emails || []) {
    const value = String(email || '').trim();
    const key = value.toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

export function normalizeCharacter(raw, index = 0) {
  if (!raw || typeof raw !== 'object') return null;
  const email = String(raw.email || '').trim();
  const name = String(raw.name || '').trim();
  if (!email || !name) return null;
  const id = String(raw.id || '').trim() || slugFromEmail(email) || `character-${index + 1}`;
  const avatar = normalizeAvatar(raw.avatar);
  const character = { ...raw, id, name, email };
  if (avatar != null) character.avatar = avatar;
  else delete character.avatar;
  if (typeof raw.responds === 'boolean') character.responds = raw.responds;
  else delete character.responds;
  return character;
}

export function normalizeCharacters(list) {
  if (!Array.isArray(list)) return [];
  const seenIds = new Set();
  const seenEmails = new Set();
  const out = [];
  list.forEach((raw, index) => {
    const character = normalizeCharacter(raw, index);
    if (!character) return;
    const emailKey = character.email.toLowerCase();
    if (seenEmails.has(emailKey)) return;
    let { id } = character;
    if (seenIds.has(id)) id = `${id}-${index + 1}`;
    seenIds.add(id);
    seenEmails.add(emailKey);
    out.push({ ...character, id });
  });
  return out;
}

export function characterByEmail(characters, email) {
  const key = String(email || '').trim().toLowerCase();
  if (!key) return null;
  return (characters || []).find((character) => character.email.toLowerCase() === key) ?? null;
}

export function constrainToCharacters(emails, characters) {
  const unique = uniqueEmails(emailsFromAddresses(emails));
  if (!characters?.length) return unique;
  const allowed = new Set(characters.map((character) => character.email.toLowerCase()));
  return unique
    .map((email) => characterByEmail(characters, email)?.email || email)
    .filter((email) => allowed.has(email.toLowerCase()));
}

export function availableCharacters(characters, { selected = [], exclude = [] } = {}) {
  const skip = new Set(
    uniqueEmails([...selected, ...exclude]).map((email) => email.toLowerCase()),
  );
  return (characters || []).filter((character) => !skip.has(character.email.toLowerCase()));
}

export function characterLabel(character) {
  if (!character) return '';
  return character.name || character.email;
}

export function toCharacterAddress(email, characters) {
  const character = characterByEmail(characters, email);
  return character ? { name: character.name, email: character.email } : { email };
}

export function validateCharacters(list) {
  if (list == null) return [];
  if (!Array.isArray(list)) return ['characters must be an array'];
  const errors = [];
  const ids = new Set();
  const emails = new Set();
  list.forEach((character, index) => {
    if (!character || typeof character !== 'object') {
      errors.push(`characters[${index}] must be an object`);
      return;
    }
    if (!String(character.name || '').trim()) {
      errors.push(`characters[${index}].name is required`);
    }
    if (!String(character.email || '').trim()) {
      errors.push(`characters[${index}].email is required`);
    }
    if (character.avatar != null && character.avatar !== '' && normalizeAvatar(character.avatar) == null) {
      errors.push(`characters[${index}].avatar must be 0–${AVATAR_COUNT} (0 is the empty face)`);
    }
    if (character.responds != null && typeof character.responds !== 'boolean') {
      errors.push(`characters[${index}].responds must be a boolean when set`);
    }
    const id = String(character.id || '').trim();
    if (id) {
      if (ids.has(id)) errors.push(`characters[${index}].id is not unique`);
      ids.add(id);
    }
    const email = String(character.email || '').trim().toLowerCase();
    if (email) {
      if (emails.has(email)) errors.push(`characters[${index}].email is not unique`);
      emails.add(email);
    }
  });
  return errors;
}
