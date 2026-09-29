import { describe, it, expect } from 'vitest';
import {
  CANDIDATE_DEFAULTS,
  VALID_CAPABILITIES,
  buildCapabilityInstructions,
  buildMailboxContext,
  hashText,
  normalizeCapabilities,
  serializeAttachments,
  serializeMailbox,
} from '../lib/assistant.js';
import { validateScenario, withScenarioDefaults, loadScenario } from '../lib/scenario.js';
import path from 'path';
import os from 'os';
import { mkdtemp, writeFile, rm } from 'fs/promises';

const LEARNER = 'you@example.com';

const threads = [
  {
    id: 'thread-1',
    subject: 'Proposal',
    emails: [
      {
        id: 'e1',
        from: { name: 'Dana', email: 'dana@vendor.com' },
        to: [{ name: 'You', email: LEARNER }],
        cc: [],
        date: '2026-07-10T14:02:00Z',
        subject: 'Proposal',
        body: 'Price is **$48,000**.',
        attachments: [{ name: 'quote.pdf' }],
      },
      {
        id: 'e2',
        from: { name: 'You', email: LEARNER },
        to: [{ name: 'Dana', email: 'dana@vendor.com' }],
        cc: [{ name: 'Sam', email: 'sam@vendor.com' }],
        date: '2026-07-11T09:15:00Z',
        subject: 'Re: Proposal',
        body: 'Can you do less?',
        attachments: [],
      },
    ],
  },
  {
    id: 'thread-2',
    subject: 'You won a prize',
    mailbox: 'spam',
    emails: [
      {
        id: 'e3',
        from: { name: 'Prize Desk', email: 'prizes@example.net' },
        to: [{ name: 'You', email: LEARNER }],
        date: '2026-07-12T00:00:00Z',
        body: 'Click here.',
      },
    ],
  },
];

describe('normalizeCapabilities', () => {
  it('defaults to every capability when not an array', () => {
    expect(normalizeCapabilities(undefined)).toEqual(VALID_CAPABILITIES);
  });

  it('drops unknown names and duplicates, keeping order', () => {
    expect(normalizeCapabilities(['summarize', 'nope', 'summarize', 'compose'])).toEqual([
      'summarize',
      'compose',
    ]);
  });

  it('keeps an explicitly empty list empty', () => {
    expect(normalizeCapabilities([])).toEqual([]);
  });
});

describe('buildCapabilityInstructions', () => {
  it('lists everything as enabled with no decline section by default', () => {
    const text = buildCapabilityInstructions(VALID_CAPABILITIES);
    for (const label of [
      'Compose & revise',
      'Answer questions & search',
      'Summarize',
      'Extract',
      'Inbox triage',
    ]) {
      expect(text).toContain(`**${label}**`);
    }
    expect(text).not.toContain('Turned off');
  });

  it('marks omitted capabilities as turned off with a decline rule', () => {
    const text = buildCapabilityInstructions(['qa_search', 'summarize', 'extract']);
    const [enabled, disabled] = text.split('Turned off in this workspace');
    expect(enabled).not.toContain('Compose & revise');
    expect(disabled).toContain('**Compose & revise**');
    expect(disabled).toContain('Do not write, rewrite, or edit email text');
    expect(disabled).toContain('**Inbox triage**');
    expect(disabled).toContain("can't do that here");
  });

  it('handles an empty capability list', () => {
    const text = buildCapabilityInstructions([]);
    expect(text).toContain('Nothing.');
    for (const label of ['Compose & revise', 'Summarize']) expect(text).toContain(label);
  });
});

describe('serializeAttachments', () => {
  it('lists name-only attachments without inventing contents', () => {
    expect(serializeAttachments([{ name: 'quote.pdf' }])).toEqual([
      'Attachments:',
      '- quote.pdf',
    ]);
  });

  it('includes seeded text when present', () => {
    const lines = serializeAttachments([
      { name: 'quote.txt', text: 'List price: $48,000\nTerm: 12 months' },
      { name: 'deck.pptx' },
    ]);
    expect(lines).toEqual([
      'Attachments:',
      '- quote.txt (seeded text follows)',
      '```',
      'List price: $48,000\nTerm: 12 months',
      '```',
      '- deck.pptx',
    ]);
  });

  it('omits text when includeText is false', () => {
    expect(
      serializeAttachments([{ name: 'notes.txt', text: 'secret' }], { includeText: false }),
    ).toEqual(['Attachments:', '- notes.txt']);
  });

  it('ignores non-string text and empty text', () => {
    expect(serializeAttachments([{ name: 'a.pdf', text: 12 }, { name: 'b.pdf', text: '' }])).toEqual([
      'Attachments:',
      '- a.pdf',
      '- b.pdf',
    ]);
  });
});

describe('serializeMailbox', () => {
  it('includes every thread with folders, ids, and stable UTC dates', () => {
    const text = serializeMailbox(threads, { learnerEmail: LEARNER });
    expect(text).toContain('#### Thread 1: Proposal [Inbox] (id: thread-1)');
    expect(text).toContain('#### Thread 2: You won a prize [Spam] (id: thread-2)');
    expect(text).toContain('Date: 2026-07-10 14:02 UTC');
    expect(text).toContain('Attachments:');
    expect(text).toContain('- quote.pdf');
    expect(text).toContain('Cc: Sam <sam@vendor.com>');
  });

  it('includes seeded attachment text on inbound mail only', () => {
    const withText = [
      {
        id: 'thread-1',
        subject: 'Proposal',
        emails: [
          {
            id: 'e1',
            from: { name: 'Dana', email: 'dana@vendor.com' },
            to: [{ name: 'You', email: LEARNER }],
            date: '2026-07-10T14:02:00Z',
            body: 'See attached.',
            attachments: [{ name: 'quote.txt', text: 'List price: $48,000' }],
          },
          {
            id: 'e2',
            from: { name: 'You', email: LEARNER },
            to: [{ name: 'Dana', email: 'dana@vendor.com' }],
            date: '2026-07-11T09:15:00Z',
            body: 'Thanks.',
            // Even if outbound somehow had text, Cosmo must not see it.
            attachments: [{ name: 'counter.txt', text: 'Our counter: $40,000' }],
          },
        ],
      },
    ];
    const text = serializeMailbox(withText, { learnerEmail: LEARNER });
    expect(text).toContain('List price: $48,000');
    expect(text).toContain('- quote.txt (seeded text follows)');
    expect(text).toContain('- counter.txt');
    expect(text).not.toContain('Our counter: $40,000');
    expect(text).not.toContain('counter.txt (seeded text follows)');
  });

  it('marks emails from the learner', () => {
    const text = serializeMailbox(threads, { learnerEmail: LEARNER });
    expect(text).toContain(`From: You <${LEARNER}> (the user)`);
    expect(text).not.toContain('dana@vendor.com> (the user)');
  });

  it('reports an empty mailbox', () => {
    expect(serializeMailbox([])).toBe('The mailbox is empty.');
  });
});

describe('buildMailboxContext', () => {
  const base = { threads, learnerEmail: LEARNER, viewing: { threadId: 'thread-1' } };

  it('sends the full mailbox the first time and says what is open', () => {
    const ctx = buildMailboxContext(base);
    expect(ctx.unchanged).toBe(false);
    expect(ctx.text).toContain('Currently viewing: thread "Proposal" (id: thread-1)');
    expect(ctx.text).toContain(`### Mailbox state ${ctx.hash}`);
    expect(ctx.text).toContain('Price is **$48,000**.');
    expect(ctx.text).toContain('Click here.');
  });

  it('sends only a marker when the mailbox is unchanged', () => {
    const first = buildMailboxContext(base);
    const second = buildMailboxContext({ ...base, previousHash: first.hash });
    expect(second.unchanged).toBe(true);
    expect(second.hash).toBe(first.hash);
    expect(second.text).toContain('unchanged');
    expect(second.text).not.toContain('Price is');
  });

  it('still reports the current view when the mailbox is unchanged', () => {
    const first = buildMailboxContext(base);
    const second = buildMailboxContext({
      ...base,
      viewing: { mailbox: 'inbox' },
      previousHash: first.hash,
    });
    expect(second.text).toContain('Currently viewing: the Inbox list');
  });

  it('sends the full mailbox again after a new email arrives', () => {
    const first = buildMailboxContext(base);
    const grown = threads.map((th) =>
      th.id === 'thread-1'
        ? {
            ...th,
            emails: [
              ...th.emails,
              {
                id: 'e4',
                from: { name: 'Dana', email: 'dana@vendor.com' },
                to: [{ name: 'You', email: LEARNER }],
                date: '2026-07-12T16:40:00Z',
                body: 'We can do 15% off for 24 months.',
              },
            ],
          }
        : th,
    );
    const next = buildMailboxContext({ ...base, threads: grown, previousHash: first.hash });
    expect(next.unchanged).toBe(false);
    expect(next.hash).not.toBe(first.hash);
    expect(next.text).toContain('15% off for 24 months');
  });

  it('describes the composer and an unknown thread gracefully', () => {
    expect(buildMailboxContext({ ...base, viewing: { composingNew: true } }).text).toContain(
      'a new message in the composer',
    );
    expect(buildMailboxContext({ ...base, viewing: { threadId: 'gone' } }).text).toContain(
      'the mailbox list',
    );
  });
});

describe('hashText', () => {
  it('is deterministic and sensitive to content', () => {
    expect(hashText('a')).toBe(hashText('a'));
    expect(hashText('a')).not.toBe(hashText('b'));
    expect(hashText('')).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe('audience', () => {
  it('defaults to learner without touching generation defaults', () => {
    const cfg = withScenarioDefaults({ id: 'x' });
    expect(cfg.audience).toBe('learner');
    expect(cfg.generation.model).toBeUndefined();
    expect(cfg.generation.temperature).toBe(0.7);
  });

  it('pins model and lowers temperature for candidates', () => {
    const cfg = withScenarioDefaults({ id: 'x', audience: 'candidate' });
    expect(cfg.generation.model).toBe(CANDIDATE_DEFAULTS.model);
    expect(cfg.generation.temperature).toBe(CANDIDATE_DEFAULTS.temperature);
  });

  it('respects an authored model and temperature for candidates', () => {
    const cfg = withScenarioDefaults({
      id: 'x',
      audience: 'candidate',
      generation: { model: 'anthropic/other', temperature: 0 },
    });
    expect(cfg.generation.model).toBe('anthropic/other');
    expect(cfg.generation.temperature).toBe(0);
  });

  it('turns off custom instructions for candidates', () => {
    const cfg = withScenarioDefaults({
      id: 'x',
      audience: 'candidate',
      assistant: { allowCustomInstructions: true },
    });
    expect(cfg.assistant.allowCustomInstructions).toBe(false);
  });

  it('warns when a candidate scenario tries to allow custom instructions', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'cmail-aud-'));
    const file = path.join(dir, 'scenario.json');
    await writeFile(
      file,
      JSON.stringify({
        id: 'x',
        audience: 'candidate',
        assistant: { allowCustomInstructions: true },
      }),
    );
    try {
      const { errors } = await loadScenario(file, dir);
      expect(errors.some((e) => e.includes('allowCustomInstructions'))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('validates the audience and capability names', () => {
    const cfg = withScenarioDefaults({
      id: 'x',
      audience: 'nope',
      assistant: { capabilities: ['compose', 'telepathy'] },
    });
    const errors = validateScenario(cfg);
    expect(errors.some((e) => e.includes('audience'))).toBe(true);
    expect(errors.some((e) => e.includes('telepathy'))).toBe(true);
  });
});
