import fs from 'fs/promises';

export {
  normalizeLanguageName,
  isDocumentLanguageTag,
  documentLanguageTag,
  matchLocale,
  matchLocaleStrings,
  resolveDocumentLanguage,
} from './document-language.js';

// ── JSON file IO ──────────────────────────────────────────────
export async function readJsonFile(filePath, fallback = {}) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export async function writeJsonFile(filePath, data) {
  await fs.writeFile(filePath, JSON.stringify(data, null, 2));
}

// ── Models ────────────────────────────────────────────────────
// Parses current-models.txt (provider/model-id per line, `#` comments allowed)
// and applies the scenario's allow-lists.
export function filterModels(rawText, allowedModels, allowedModelFamilies) {
  let models = String(rawText ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  if (Array.isArray(allowedModels) && allowedModels.length > 0) {
    const allowed = new Set(allowedModels);
    models = models.filter((m) => allowed.has(m));
  }
  if (Array.isArray(allowedModelFamilies) && allowedModelFamilies.length > 0) {
    models = models.filter((m) =>
      allowedModelFamilies.some((fam) => m.startsWith(fam + '/') || m === fam),
    );
  }
  return models;
}

// ── i18n ──────────────────────────────────────────────────────
// Merges i18n base strings with per-key config overrides (config wins).
export function mergeStrings(base = {}, overrides = {}) {
  return { ...base, ...(overrides && typeof overrides === 'object' ? overrides : {}) };
}
