import { describe, it, expect } from 'vitest';
import {
  QUICK_ACTIONS,
  VALID_QUICK_ACTIONS,
  actionInstruction,
  normalizeHeaderSuggestion,
  normalizeQuickActionsConfig,
  normalizeSuggestedReplies,
  normalizeTriageRanking,
  resolveQuickActionChips,
} from '../lib/quick-actions.js';
import { EVENT_TYPES, makeQuickActionEvent } from '../lib/provenance.js';
import { withScenarioDefaults, validateScenario, loadScenario } from '../lib/scenario.js';
import path from 'path';
import os from 'os';
import { mkdtemp, writeFile, rm } from 'fs/promises';

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
  it('hides compose chips when compose is off', () => {
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
    expect(chips.map((c) => c.id)).toEqual(
      VALID_QUICK_ACTIONS.filter((id) => QUICK_ACTIONS[id].requires.includes('compose')),
    );
  });

  it('returns the prioritize chip when triage is enabled', () => {
    const chips = resolveQuickActionChips({
      capabilities: ['triage'],
      quickActions: true,
    });
    expect(chips.map((c) => c.id)).toEqual(['prioritize_inbox']);
  });

  it('honors an author allow-list', () => {
    const chips = resolveQuickActionChips({
      capabilities: ['compose', 'summarize', 'triage'],
      quickActions: ['suggested_replies', 'tone', 'prioritize_inbox'],
    });
    expect(chips.map((c) => c.id)).toEqual([
      'suggested_replies',
      'tone',
      'prioritize_inbox',
    ]);
  });

  it('hides all chips when quickActions is false', () => {
    expect(
      resolveQuickActionChips({
        capabilities: ['compose', 'triage'],
        quickActions: false,
      }),
    ).toEqual([]);
  });

  it('shows prioritize only on the inbox list, not in a thread or while composing', () => {
    const caps = { capabilities: ['compose', 'triage'], quickActions: true };
    expect(
      resolveQuickActionChips({
        ...caps,
        context: { view: 'list', mailbox: 'inbox', composerOpen: false },
      }).map((c) => c.id),
    ).toEqual(['prioritize_inbox']);
    expect(
      resolveQuickActionChips({
        ...caps,
        context: { view: 'thread', mailbox: 'inbox', composerOpen: false },
      }).map((c) => c.id),
    ).toEqual(['suggested_replies']);
    expect(
      resolveQuickActionChips({
        ...caps,
        context: { view: 'list', mailbox: 'sent', composerOpen: false },
      }).map((c) => c.id),
    ).toEqual([]);
    expect(
      resolveQuickActionChips({
        ...caps,
        context: { view: 'list', mailbox: 'inbox', composerOpen: true, composingNew: true },
      }).map((c) => c.id),
    ).toEqual(['subject_recipients']);
  });

  it('shows rewrite chips only when the composer has a body', () => {
    const caps = { capabilities: ['compose', 'triage'], quickActions: true };
    expect(
      resolveQuickActionChips({
        ...caps,
        context: {
          view: 'list',
          mailbox: 'inbox',
          composerOpen: true,
          composingNew: true,
          hasDraftBody: false,
          hasRecipients: false,
          hasSubject: false,
        },
      }).map((c) => c.id),
    ).toEqual(['subject_recipients']);
    expect(
      resolveQuickActionChips({
        ...caps,
        context: {
          view: 'list',
          mailbox: 'inbox',
          composerOpen: true,
          composingNew: true,
          hasDraftBody: true,
          hasRecipients: false,
          hasSubject: false,
        },
      }).map((c) => c.id),
    ).toEqual(['rewrite', 'shorten', 'tone', 'proofread', 'subject_recipients']);
  });

  it('hides subject & recipients once both are filled', () => {
    const chips = resolveQuickActionChips({
      capabilities: ['compose'],
      quickActions: true,
      context: {
        view: 'list',
        mailbox: 'inbox',
        composerOpen: true,
        composingNew: true,
        hasDraftBody: true,
        hasRecipients: true,
        hasSubject: true,
      },
    });
    expect(chips.map((c) => c.id)).toEqual(['rewrite', 'shorten', 'tone', 'proofread']);
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
    expect(actionInstruction('prioritize_inbox')).toContain('propose-triage');
  });
});

describe('normalizeTriageRanking', () => {
  it('trims ranking Markdown', () => {
    expect(
      normalizeTriageRanking({
        ranking: '  1. Dana — awaiting counter — High\n2. Lena — dietary needs — Medium  ',
      }),
    ).toBe('1. Dana — awaiting counter — High\n2. Lena — dietary needs — Medium');
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

  it('records a triage ranking', () => {
    const event = makeQuickActionEvent({
      action: 'prioritize_inbox',
      ranking: '1. Dana — High\n2. Lena — Medium',
    });
    expect(event.action).toBe('prioritize_inbox');
    expect(event.ranking).toContain('Dana');
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

  it('rejects unknown action ids on the real load path', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'cmail-qa-'));
    const file = path.join(dir, 'scenario.json');
    await writeFile(
      file,
      JSON.stringify({
        id: 'x',
        primarySkill: 'both',
        scenarioType: 'reply',
        audience: 'learner',
        assistant: { quickActions: ['telepathy'] },
      }),
    );
    try {
      const { errors } = await loadScenario(file, dir);
      expect(errors.some((e) => e.includes('quickActions') && e.includes('telepathy'))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('exposes chip metadata for UI labels', () => {
    expect(QUICK_ACTIONS.rewrite.label).toBe('Rewrite');
    expect(QUICK_ACTIONS.suggested_replies.needsThread).toBe(true);
    expect(QUICK_ACTIONS.prioritize_inbox.label).toBe('Prioritize my inbox');
    expect(QUICK_ACTIONS.prioritize_inbox.requires).toEqual(['triage']);
  });
});
