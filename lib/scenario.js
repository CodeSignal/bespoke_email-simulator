import path from 'path';
import { readJsonFile } from './helpers.js';
import { normalizeCharacters, validateCharacters, normalizeAvatar, AVATAR_COUNT, EMPTY_AVATAR } from './characters.js';
import { normalizeWorld } from './character-replies.js';
import {
  VALID_AUDIENCES,
  VALID_CAPABILITIES,
  DEFAULT_CAPABILITIES,
  applyAudienceDefaults,
} from './assistant.js';

/**
 * Scenario loading & normalization.
 *
 * A scenario config (scenario.json) drives one CMail exercise. Seed email data
 * (`seed.inbox`) is an inline `{ threads }` object by default. For a large
 * mailbox it may instead be a string path to a JSON file of the same shape,
 * relative to the project root.
 */

export const DEFAULT_SCENARIO = {
  id: 'untitled',
  title: 'CosmoMail',
  brief: '',
  primarySkill: 'both', // writing | prompting | both
  scenarioType: 'reply', // compose_new | reply | reply_chain
  audience: 'learner', // learner | candidate (candidate = assessed; pinned, low-temperature assistant)
  learner: { displayName: 'You', avatar: EMPTY_AVATAR },
  characters: [],
  world: '',
  seed: { inbox: { threads: [] }, activeThreadId: null, focusedEmailId: null },
  initialDraft: null,
  assistant: {
    enabled: true,
    capabilities: [...DEFAULT_CAPABILITIES],
    systemPromptExtra: '',
    initialMessage: '',
    allowCustomInstructions: false,
  },
  generation: { model: undefined, temperature: 0.7, thinking: 'off', language: 'English' },
  attachments: { enabled: true, allowedTypes: ['.pdf', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.txt', '.doc', '.docx'] },
  ui: { hideHistory: false, strings: {} },
  rubricHints: {},
};

const VALID_PRIMARY_SKILLS = ['writing', 'prompting', 'both'];
const VALID_SCENARIO_TYPES = ['compose_new', 'reply', 'reply_chain'];

// Shallow-merge a config over the defaults, one level deep for known objects so
// authors only specify what they want to override.
export function withScenarioDefaults(config = {}) {
  const merged = { ...DEFAULT_SCENARIO, ...config };
  for (const key of [
    'learner',
    'seed',
    'assistant',
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
  merged.world = normalizeWorld(config.world ?? DEFAULT_SCENARIO.world);
  merged.learner.avatar = normalizeAvatar(merged.learner?.avatar) ?? EMPTY_AVATAR;
  delete merged.simulatedRecipient;
  return applyAudienceDefaults(merged, config);
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
  if (!VALID_AUDIENCES.includes(config.audience)) {
    errors.push(`audience must be one of: ${VALID_AUDIENCES.join(', ')}`);
  }
  const capabilities = config.assistant?.capabilities;
  if (!Array.isArray(capabilities)) {
    errors.push('assistant.capabilities must be an array');
  } else {
    for (const id of capabilities) {
      if (!VALID_CAPABILITIES.includes(id)) {
        errors.push(
          `assistant.capabilities has unknown capability "${id}" (valid: ${VALID_CAPABILITIES.join(', ')})`,
        );
      }
    }
  }
  errors.push(...validateCharacters(config.characters));
  if (config.learner?.avatar != null && normalizeAvatar(config.learner.avatar) == null) {
    errors.push(`learner.avatar must be 0–${AVATAR_COUNT} (0 is the empty face)`);
  }
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
 * `seed.inbox` is an inline object/array, or optionally a string path (relative
 * to rootDir) to a JSON file of the same shape.
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
  if (raw.learner?.avatar != null && raw.learner.avatar !== '' && normalizeAvatar(raw.learner.avatar) == null) {
    characterErrors.push(`learner.avatar must be 0–${AVATAR_COUNT} (0 is the empty face)`);
  }
  const config = withScenarioDefaults(raw);
  const inbox = await resolveInbox(config.seed, rootDir);
  const errors = [...validateScenario(config), ...characterErrors];
  if (config.audience === 'candidate' && raw.assistant?.allowCustomInstructions) {
    errors.push('assistant.allowCustomInstructions is ignored when audience is "candidate"');
  }
  return { config, inbox, errors };
}
