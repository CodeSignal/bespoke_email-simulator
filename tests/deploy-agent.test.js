import { describe, it, expect } from 'vitest';
import {
  AGENTS,
  resolveTarget,
  resolveAgentKeys,
  rewriteSettings,
} from '../scripts/deploy-agent.mjs';

describe('resolveTarget', () => {
  it('prefers an explicit CLI target over AGENT_TARGET', () => {
    expect(resolveTarget(['prod', '--yes'], 'dev')).toBe('prod');
    expect(resolveTarget(['dev'], 'prod')).toBe('dev');
  });

  it('falls back to AGENT_TARGET, then prod', () => {
    expect(resolveTarget([], 'dev')).toBe('dev');
    expect(resolveTarget(['--yes'], 'PROD')).toBe('prod');
    expect(resolveTarget(['--agent', 'cosmo-mail'], 'dev')).toBe('dev');
    expect(resolveTarget([])).toBe('prod');
  });

  it('rejects an invalid CLI target or AGENT_TARGET', () => {
    expect(() => resolveTarget(['staging'])).toThrow(/Unknown target/);
    expect(() => resolveTarget([], 'staging')).toThrow(/Invalid AGENT_TARGET/);
  });
});

describe('resolveAgentKeys', () => {
  it('deploys both agents when --agent is omitted', () => {
    expect(resolveAgentKeys(['dev'])).toEqual(Object.keys(AGENTS));
  });

  it('deploys a single agent when --agent is set', () => {
    expect(resolveAgentKeys(['dev', '--agent', 'cosmo-mail-character'])).toEqual([
      'cosmo-mail-character',
    ]);
  });

  it('rejects an unknown --agent value', () => {
    expect(() => resolveAgentKeys(['--agent', 'nope'])).toThrow(/Unknown agent/);
  });
});

describe('rewriteSettings', () => {
  it('rewrites only slug and name for the chosen target', () => {
    const source = {
      slug: 'cosmo-mail',
      name: 'Cosmo Mail',
      description: 'keep me',
      format: 'interactive',
    };
    expect(rewriteSettings(source, AGENTS['cosmo-mail'].dev)).toEqual({
      slug: 'cosmo-mail-dev',
      name: 'Cosmo Mail dev',
      description: 'keep me',
      format: 'interactive',
    });
  });
});
