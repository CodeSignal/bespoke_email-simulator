import { describe, it, expect } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  withScenarioDefaults,
  validateScenario,
  normalizeInbox,
  resolveInbox,
} from '../lib/scenario.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

describe('withScenarioDefaults', () => {
  it('fills defaults and deep-merges known objects', () => {
    const cfg = withScenarioDefaults({ id: 'x', assistant: { enabled: false } });
    expect(cfg.id).toBe('x');
    expect(cfg.primarySkill).toBe('both');
    expect(cfg.assistant.enabled).toBe(false);
    // untouched keys keep their defaults
    expect(cfg.assistant.capabilities).toContain('compose');
  });
});

describe('validateScenario', () => {
  it('accepts a minimal valid scenario', () => {
    const cfg = withScenarioDefaults({ id: 'ok' });
    expect(validateScenario(cfg)).toEqual([]);
  });

  it('flags bad enums and missing id', () => {
    const cfg = withScenarioDefaults({ id: '', primarySkill: 'nope', scenarioType: 'bad' });
    const errors = validateScenario(cfg);
    expect(errors.some((e) => e.includes('id'))).toBe(true);
    expect(errors.some((e) => e.includes('primarySkill'))).toBe(true);
    expect(errors.some((e) => e.includes('scenarioType'))).toBe(true);
  });

  it('requires a persona when the recipient is enabled', () => {
    const cfg = withScenarioDefaults({
      id: 'r',
      simulatedRecipient: { enabled: true, threadBehavior: 'one_reply', personas: [] },
    });
    expect(validateScenario(cfg).some((e) => e.includes('personas'))).toBe(true);
  });
});

describe('normalizeInbox', () => {
  it('accepts an array or a {threads} object', () => {
    expect(normalizeInbox([{ id: 't' }]).threads).toHaveLength(1);
    expect(normalizeInbox({ threads: [{ id: 't' }] }).threads).toHaveLength(1);
    expect(normalizeInbox(null).threads).toHaveLength(0);
  });
});

describe('resolveInbox', () => {
  it('resolves an inline inbox object', async () => {
    const inbox = await resolveInbox({ inbox: { threads: [{ id: 'inline' }] } }, ROOT);
    expect(inbox.threads[0].id).toBe('inline');
  });

  it('resolves an inbox from a fixture file path', async () => {
    const inbox = await resolveInbox({ inbox: 'fixtures/vendor-thread.json' }, ROOT);
    expect(inbox.threads).toHaveLength(1);
    expect(inbox.threads[0].emails).toHaveLength(3);
  });
});
