import path from 'path';
import { readJsonFile } from './helpers.js';
import { normalizeCharacters, validateCharacters } from './characters.js';

/**
 * Scenario loading & normalization.
 *
 * A scenario config (scenario.json) drives one CMail exercise. Seed email data
 * (`seed.inbox`) may be provided inline as an object, or as a string path to a
 * fixture file relative to the project root. Both are supported.
 */

export const DEFAULT_SCENARIO = {
  id: 'untitled',
  title: 'CosmoMail',
  brief: '',
  primarySkill: 'both', // writing | prompting | both
  scenarioType: 'reply', // compose_new | reply | reply_chain
  learner: { displayName: 'You' },
  characters: [],
  seed: { inbox: { threads: [] }, activeThreadId: null, focusedEmailId: null },
  initialDraft: null,
  assistant: {
    enabled: true,
    capabilities: ['compose', 'qa_search', 'summarize', 'extract'],
    systemPromptExtra: '',
    initialMessage: '',
    allowCustomInstructions: false,
  },
  simulatedRecipient: {
    enabled: false,
    threadBehavior: 'one_reply', // one_reply | multi_turn | scripted
    maxTurns: 1,
    personas: [],
    scriptedBeats: [],
  },
  generation: { model: undefined, temperature: 0.7, thinking: 'off', language: 'English' },
  attachments: { enabled: true, allowedTypes: ['.pdf', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.txt', '.doc', '.docx'] },
  ui: { hideHistory: false, strings: {} },
  rubricHints: {},
};

const VALID_PRIMARY_SKILLS = ['writing', 'prompting', 'both'];
const VALID_SCENARIO_TYPES = ['compose_new', 'reply', 'reply_chain'];
const VALID_THREAD_BEHAVIORS = ['one_reply', 'multi_turn', 'scripted'];

// Shallow-merge a config over the defaults, one level deep for known objects so
// authors only specify what they want to override.
export function withScenarioDefaults(config = {}) {
  const merged = { ...DEFAULT_SCENARIO, ...config };
  for (const key of [
    'learner',
    'seed',
    'assistant',
    'simulatedRecipient',
    'generation',
    'attachments',
    'ui',
    'rubricHints',
  ]) {
    merged[key] = { ...DEFAULT_SCENARIO[key], ...(config[key] ?? {}) };
  }
  merged.characters = normalizeCharacters(
    Array.isArray(config.characters) ? config.characters : DEFAULT_SCENARIO.characters,
  );
  return merged;
}

// Validates a normalized scenario config. Returns an array of error strings
// (empty when valid) so callers can surface authoring mistakes clearly.
export function validateScenario(config) {
  const errors = [];
  if (!config.id) errors.push('scenario.id is required');
  if (!VALID_PRIMARY_SKILLS.includes(config.primarySkill)) {
    errors.push(`primarySkill must be one of: ${VALID_PRIMARY_SKILLS.join(', ')}`);
  }
  if (!VALID_SCENARIO_TYPES.includes(config.scenarioType)) {
    errors.push(`scenarioType must be one of: ${VALID_SCENARIO_TYPES.join(', ')}`);
  }
  const sr = config.simulatedRecipient;
  if (sr?.enabled) {
    if (!VALID_THREAD_BEHAVIORS.includes(sr.threadBehavior)) {
      errors.push(`simulatedRecipient.threadBehavior must be one of: ${VALID_THREAD_BEHAVIORS.join(', ')}`);
    }
    if (!Array.isArray(sr.personas) || sr.personas.length === 0) {
      errors.push('simulatedRecipient.personas must have at least one persona when enabled');
    }
  }
  errors.push(...validateCharacters(config.characters));
  return errors;
}

// Normalizes an inbox object into { threads: [...] }, tolerating either a bare
// array of threads or the { threads: [...] } shape.
export function normalizeInbox(inbox) {
  if (!inbox) return { threads: [] };
  if (Array.isArray(inbox)) return { threads: inbox };
  if (Array.isArray(inbox.threads)) return { threads: inbox.threads };
  return { threads: [] };
}

/**
 * Resolves the scenario's seed inbox into a concrete { threads } object.
 * `seed.inbox` is either an inline object/array or a string path (relative to
 * rootDir) to a fixture JSON file.
 */
export async function resolveInbox(seed, rootDir) {
  const inbox = seed?.inbox;
  if (typeof inbox === 'string') {
    const fixturePath = path.resolve(rootDir, inbox);
    const parsed = await readJsonFile(fixturePath, null);
    return normalizeInbox(parsed);
  }
  return normalizeInbox(inbox);
}

/**
 * Loads and normalizes the scenario config + resolved inbox from disk.
 * Returns { config, inbox, errors }.
 */
export async function loadScenario(configPath, rootDir) {
  const raw = await readJsonFile(configPath, {});
  const characterErrors = validateCharacters(raw.characters);
  const config = withScenarioDefaults(raw);
  const inbox = await resolveInbox(config.seed, rootDir);
  const errors = [...validateScenario(config), ...characterErrors];
  return { config, inbox, errors };
}
