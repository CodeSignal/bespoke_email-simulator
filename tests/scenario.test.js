import { describe, it, expect } from 'vitest';
import path from 'path';
import os from 'os';
import { mkdtemp, writeFile, rm } from 'fs/promises';
import { fileURLToPath } from 'url';
import {
  withScenarioDefaults,
  validateScenario,
  normalizeInbox,
  resolveInbox,
  loadScenario,
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
    expect(cfg.ui.hideAssistant).toBeUndefined();
    expect(cfg.characters).toEqual([]);
    expect(cfg.learner.avatar).toBe(0);
  });

  it('normalizes characters and keeps extra persona fields', () => {
    const cfg = withScenarioDefaults({
      id: 'cast',
      characters: [
        { name: 'Priya Nair', email: 'priya@brightlabs.io', role: 'Partner', prompt: 'Stay warm.' },
      ],
    });
    expect(cfg.characters).toEqual([
      {
        name: 'Priya Nair',
        email: 'priya@brightlabs.io',
        role: 'Partner',
        prompt: 'Stay warm.',
        id: 'priya',
      },
    ]);
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

  it('drops leftover grading fields so they cannot reach the runtime config', () => {
    const cfg = withScenarioDefaults({
      id: 'r',
      rubricHints: 'Reward a clear ask.',
      rubric: { notes: 'Reward a clear ask.' },
    });
    expect(cfg.rubricHints).toBeUndefined();
    expect(cfg.rubric).toBeUndefined();
  });

  it('warns when a scenario file still contains grading fields and drops them', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'cmail-rubric-'));
    const scenarioPath = path.join(dir, 'scenario.json');
    await writeFile(
      scenarioPath,
      JSON.stringify({
        id: 'graded',
        rubricHints: { notes: 'Reward a clear ask.' },
        rubric: { notes: 'Reward a clear ask.' },
      }),
    );
    try {
      const { config, errors } = await loadScenario(scenarioPath, dir);
      expect(config.rubricHints).toBeUndefined();
      expect(config.rubric).toBeUndefined();
      expect(JSON.stringify(config)).not.toContain('Reward a clear ask.');
      expect(errors).toEqual([
        'rubricHints is not part of the scenario and is ignored',
        'rubric is not part of the scenario and is ignored',
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('drops a leftover simulatedRecipient block and keeps world', () => {
    const cfg = withScenarioDefaults({
      id: 'r',
      world: { summary: 'Acme is negotiating a license.' },
      simulatedRecipient: { enabled: true, personas: [] },
    });
    expect(cfg.simulatedRecipient).toBeUndefined();
    expect(cfg.world).toBe('Acme is negotiating a license.');
    expect(validateScenario(cfg)).toEqual([]);
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
    const dir = await mkdtemp(path.join(os.tmpdir(), 'cmail-inbox-'));
    const fixturePath = path.join(dir, 'thread.json');
    await writeFile(
      fixturePath,
      JSON.stringify({
        threads: [{ id: 'from-file', emails: [{ id: 'e1' }, { id: 'e2' }, { id: 'e3' }] }],
      }),
    );
    try {
      const inbox = await resolveInbox({ inbox: fixturePath }, ROOT);
      expect(inbox.threads).toHaveLength(1);
      expect(inbox.threads[0].id).toBe('from-file');
      expect(inbox.threads[0].emails).toHaveLength(3);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
