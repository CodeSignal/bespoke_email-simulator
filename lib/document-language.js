// Browser-safe locale helpers. No Node imports: public/app.js bundles this file.

// Normalizes a language name for case-insensitive matching (e.g. "Spanish" -> "spanish").
export function normalizeLanguageName(name) {
  return String(name ?? '').trim().toLowerCase();
}

// Well-formed BCP 47 langtag (RFC 5646), not a registered-subtag lookup.
// The primary language stays 2 or 3 letters, so a full name such as "english" is not a tag.
// An extension singleton such as "u" is one character and needs 2 to 8 character subtags.
// Private-use "x" subtags may be 1 to 8 characters.
const PRIMARY_LANGUAGE = /^[A-Za-z]{2,3}$/;
const EXTLANG = /^[A-Za-z]{3}$/;
const SCRIPT = /^[A-Za-z]{4}$/;
const REGION = /^([A-Za-z]{2}|\d{3})$/;
const VARIANT = /^([A-Za-z0-9]{5,8}|\d[A-Za-z0-9]{3})$/;
const EXTENSION_SINGLETON = /^[0-9A-WY-Za-wy-z]$/;
const EXTENSION_PART = /^[A-Za-z0-9]{2,8}$/;
const PRIVATE_USE = /^[Xx]$/;
const PRIVATE_PART = /^[A-Za-z0-9]{1,8}$/;

export function isDocumentLanguageTag(value) {
  const tag = String(value ?? '').trim();
  if (!tag) return false;
  const subtags = tag.split('-');
  if (subtags.some((part) => part.length === 0)) return false;
  if (!PRIMARY_LANGUAGE.test(subtags[0])) return false;

  let index = 1;
  let extlangs = 0;
  while (index < subtags.length && extlangs < 3 && EXTLANG.test(subtags[index])) {
    extlangs += 1;
    index += 1;
  }
  if (index < subtags.length && SCRIPT.test(subtags[index])) index += 1;
  if (index < subtags.length && REGION.test(subtags[index])) index += 1;
  while (index < subtags.length && VARIANT.test(subtags[index])) index += 1;

  while (index < subtags.length && EXTENSION_SINGLETON.test(subtags[index])) {
    index += 1;
    const start = index;
    while (index < subtags.length && EXTENSION_PART.test(subtags[index])) index += 1;
    if (index === start) return false;
  }

  if (index < subtags.length && PRIVATE_USE.test(subtags[index])) {
    index += 1;
    const start = index;
    while (index < subtags.length && PRIVATE_PART.test(subtags[index])) index += 1;
    if (index === start) return false;
  }

  return index === subtags.length;
}

// The catalog identifies the page language with a BCP 47 tag in `languageNames`.
// Returns '' when none of the names is a tag.
export function documentLanguageTag(languageNames) {
  const names = Array.isArray(languageNames) ? languageNames : [];
  for (const name of names) {
    const tag = String(name ?? '').trim();
    if (isDocumentLanguageTag(tag)) return tag;
  }
  return '';
}

// The locale whose `languageNames` includes `language` (case-insensitively), or null.
export function matchLocale(language, locales = []) {
  const target = normalizeLanguageName(language);
  if (!target) return null;
  for (const locale of locales) {
    const names = Array.isArray(locale?.languageNames) ? locale.languageNames : [];
    if (names.some((n) => normalizeLanguageName(n) === target)) return locale;
  }
  return null;
}

// Finds the first locale whose `languageNames` includes `language`
// (case-insensitively) and returns its `strings` map, or `{}` when none match.
export function matchLocaleStrings(language, locales = []) {
  const locale = matchLocale(language, locales);
  if (!locale?.strings || typeof locale.strings !== 'object') return {};
  return locale.strings;
}

// html[lang] for a scenario language. '' when no catalog matches or the
// catalog does not identify a language tag — callers must keep the existing lang.
export function resolveDocumentLanguage(language, locales = []) {
  const locale = matchLocale(language, locales);
  if (!locale) return '';
  return documentLanguageTag(locale.languageNames);
}
