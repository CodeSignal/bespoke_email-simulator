import fs from 'fs/promises';
import path from 'path';
import { readJsonFile, matchLocaleStrings, mergeStrings, resolveDocumentLanguage } from './helpers.js';

/**
 * Loads every i18n/*.json locale catalog. Each file is
 * { languageNames: string[], strings: { [english]: translation } }.
 * Malformed files are skipped so one bad catalog can't break config loading.
 */
export async function readLocales(i18nDir) {
  let files;
  try {
    files = await fs.readdir(i18nDir);
  } catch {
    return [];
  }
  const locales = [];
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    const parsed = await readJsonFile(path.join(i18nDir, file), null);
    if (parsed) locales.push(parsed);
  }
  return locales;
}

/**
 * Resolves the effective UI strings for a language: the matching i18n catalog is
 * the base, and any per-key `overrides` (from the scenario's ui.strings) win.
 */
// Resolved UI strings plus the catalog's html[lang] tag ('' when the catalog
// does not identify one).
export async function resolveClientLocale(language, overrides, i18nDir) {
  const locales = await readLocales(i18nDir);
  return {
    strings: mergeStrings(matchLocaleStrings(language, locales), overrides),
    documentLanguage: resolveDocumentLanguage(language, locales),
  };
}

export async function resolveStrings(language, overrides, i18nDir) {
  const { strings } = await resolveClientLocale(language, overrides, i18nDir);
  return strings;
}
