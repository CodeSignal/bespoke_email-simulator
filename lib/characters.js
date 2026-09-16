/**
 * Simulation characters — the people a learner may put on To / Cc.
 *
 * Extra fields (`role`, `prompt`, `avatar`, …) are preserved so authors can
 * grow these records into full personas later without a schema break.
 */

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
  return { ...raw, id, name, email };
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
