import { describe, it, expect } from 'vitest';
import {
  QUICK_ACTIONS,
  VALID_QUICK_ACTIONS,
  actionInstruction,
  normalizeHeaderSuggestion,
  normalizeQuickActionsConfig,
  normalizeSuggestedReplies,
  resolveQuickActionChips,
} from '../lib/quick-actions.js';
import { EVENT_TYPES, makeQuickActionEvent } from '../lib/provenance.js';
import { withScenarioDefaults, validateScenario } from '../lib/scenario.js';

describe('normalizeQuickActionsConfig', () => {
  it('defaults to every action for true / undefined', () => {
    expect(normalizeQuickActionsConfig(undefined)).toEqual(VALID_QUICK_ACTIONS);
    expect(normalizeQuickActionsConfig(true)).toEqual(VALID_QUICK_ACTIONS);
  });

  it('returns an empty list when false', () => {
    expect(normalizeQuickActionsConfig(false)).toEqual([]);
  });

  it('keeps a subset and drops unknowns', () => {
    expect(normalizeQuickActionsConfig(['rewrite', 'nope', 'rewrite', 'shorten'])).toEqual([
      'rewrite',
      'shorten',
    ]);
  });
});

describe('resolveQuickActionChips', () => {
  it('requires compose for all v1 chips', () => {
    expect(
      resolveQuickActionChips({
        capabilities: ['qa_search', 'summarize', 'extract'],
        quickActions: true,
      }),
    ).toEqual([]);
  });

  it('returns compose chips when compose is enabled', () => {
    const chips = resolveQuickActionChips({
      capabilities: ['compose'],
      quickActions: true,
    });
    expect(chips.map((c) => c.id)).toEqual(VALID_QUICK_ACTIONS);
  });

  it('honors an author allow-list', () => {
    const chips = resolveQuickActionChips({
      capabilities: ['compose', 'summarize'],
      quickActions: ['suggested_replies', 'tone'],
    });
    expect(chips.map((c) => c.id)).toEqual(['suggested_replies', 'tone']);
  });

  it('hides all chips when quickActions is false', () => {
    expect(
      resolveQuickActionChips({
        capabilities: ['compose'],
        quickActions: false,
      }),
    ).toEqual([]);
  });
});

describe('normalizeSuggestedReplies', () => {
  it('reads reply1/2/3 fields', () => {
    expect(
      normalizeSuggestedReplies({
        reply1: ' Thanks. ',
        reply2: 'Not now.',
        reply3: '',
      }),
    ).toEqual(['Thanks.', 'Not now.']);
  });

  it('parses a JSON replies string', () => {
    expect(
      normalizeSuggestedReplies({
        replies: JSON.stringify(['One', { body: 'Two' }, 'Three', 'Four']),
      }),
    ).toEqual(['One', 'Two', 'Three']);
  });
});

describe('normalizeHeaderSuggestion', () => {
  it('normalizes recipients and subject without a body', () => {
    expect(
      normalizeHeaderSuggestion({
        to: 'dana@acme-vendor.com, sam@x.com',
        cc: '',
        subject: ' Re: Hello ',
        body: 'should be ignored',
      }),
    ).toEqual({
      to: ['dana@acme-vendor.com', 'sam@x.com'],
      cc: [],
      subject: 'Re: Hello',
    });
  });
});

describe('actionInstruction', () => {
  it('mentions the tool for each action', () => {
    expect(actionInstruction('suggested_replies')).toContain('propose-suggested-replies');
    expect(actionInstruction('rewrite')).toContain('propose-draft');
    expect(actionInstruction('subject_recipients')).toContain('propose-headers');
  });
});

describe('makeQuickActionEvent', () => {
  it('records action payload separately from chat', () => {
    const event = makeQuickActionEvent({
      action: 'suggested_replies',
      replies: ['Hi'],
      threadId: 'thread-1',
    });
    expect(event.type).toBe(EVENT_TYPES.QUICK_ACTION);
    expect(event.action).toBe('suggested_replies');
    expect(event.replies).toEqual(['Hi']);
    expect(event.threadId).toBe('thread-1');
    expect(event.source).toBe('quick-action');
  });
});

describe('scenario quickActions', () => {
  it('normalizes true to the full action list', () => {
    const cfg = withScenarioDefaults({ id: 'x', assistant: { quickActions: true } });
    expect(cfg.assistant.quickActions).toEqual(VALID_QUICK_ACTIONS);
    expect(validateScenario(cfg)).toEqual([]);
  });

  it('normalizes false to an empty list', () => {
    const cfg = withScenarioDefaults({ id: 'x', assistant: { quickActions: false } });
    expect(cfg.assistant.quickActions).toEqual([]);
  });

  it('rejects unknown action ids', () => {
    const cfg = withScenarioDefaults({
      id: 'x',
      assistant: { quickActions: ['telepathy'] },
    });
    // Unknowns dropped during normalize; validate an unnormalized shape.
    expect(
      validateScenario({
        ...cfg,
        assistant: { ...cfg.assistant, quickActions: ['telepathy'] },
      }).some((e) => e.includes('quickActions')),
    ).toBe(true);
  });

  it('exposes chip metadata for UI labels', () => {
    expect(QUICK_ACTIONS.rewrite.label).toBe('Rewrite');
    expect(QUICK_ACTIONS.suggested_replies.needsThread).toBe(true);
  });
});
