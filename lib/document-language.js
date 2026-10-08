// Browser-safe locale helpers. No Node imports: public/app.js bundles this file.

// Normalizes a language name for case-insensitive matching (e.g. "Spanish" -> "spanish").
export function normalizeLanguageName(name) {
  return String(name ?? '').trim().toLowerCase();
}

// A BCP 47 language tag (for html[lang]). Full language names such as "english" are not tags.
const DOCUMENT_LANGUAGE_TAG = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;

export function isDocumentLanguageTag(value) {
  return DOCUMENT_LANGUAGE_TAG.test(String(value ?? '').trim());
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
