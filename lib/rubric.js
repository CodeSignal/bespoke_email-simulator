import path from 'path';
import { readJsonFile } from './helpers.js';

/**
 * Rubric / grading notes live outside the scenario so the exercise definition
 * (and Cosmo / the learner UI) never see assessment guidance.
 *
 * Default sidecar paths:
 *   scenario.json              → rubric.json
 *   scenario.example.json      → rubric.example.json
 *   foo.scenario.json          → foo.rubric.json
 */

export function defaultRubricPath(scenarioPath) {
  const resolved = path.resolve(scenarioPath);
  const dir = path.dirname(resolved);
  const base = path.basename(resolved);
  if (base.toLowerCase().endsWith('.scenario.json')) {
    return path.join(dir, base.replace(/\.scenario\.json$/i, '.rubric.json'));
  }
  if (/^scenario(\..+)?\.json$/i.test(base)) {
    return path.join(dir, base.replace(/^scenario/i, 'rubric'));
  }
  return path.join(dir, 'rubric.json');
}

/**
 * Load optional rubric sidecar. Returns null when the file is missing.
 * Accepts either `{ notes: "..." }` / arbitrary object, or a bare string.
 */
export async function loadRubric(rubricPath) {
  if (!rubricPath) return null;
  return readJsonFile(rubricPath, null);
}

/** Normalize rubric JSON into Markdown lines for extract reports. */
export function rubricLines(rubric) {
  if (rubric == null) return [];
  const lines = ['### Rubric hints', ''];
  if (typeof rubric === 'string') {
    lines.push(rubric, '');
    return lines;
  }
  if (typeof rubric !== 'object') {
    lines.push(String(rubric), '');
    return lines;
  }
  if (typeof rubric.notes === 'string' && Object.keys(rubric).length === 1) {
    lines.push(rubric.notes, '');
    return lines;
  }
  for (const [key, value] of Object.entries(rubric)) {
    if (typeof value === 'string') {
      lines.push(`- **${key}:** ${value}`);
    } else {
      lines.push(`- **${key}:** ${JSON.stringify(value)}`);
    }
  }
  lines.push('');
  return lines;
}
