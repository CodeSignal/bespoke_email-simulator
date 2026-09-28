import { describe, it, expect } from 'vitest';
import { draftForScope, parseInsertedDraft, removeScopedDraft, upsertScopedDraft } from '../lib/drafts.js';

describe('scoped drafts', () => {
  const replyA = { scope: 'reply', threadId: 'thread-a', body: 'reply a' };
  const replyB = { scope: 'reply', threadId: 'thread-b', body: 'reply b' };
  const fresh = { scope: 'new', body: 'new message' };

  it('keeps a new message and each thread reply as separate drafts', () => {
    let drafts = [];
    drafts = upsertScopedDraft(drafts, fresh);
    drafts = upsertScopedDraft(drafts, replyA);
    drafts = upsertScopedDraft(drafts, replyB);
    drafts = upsertScopedDraft(drafts, { ...fresh, body: 'rewritten' });

    expect(drafts).toHaveLength(3);
    expect(draftForScope(drafts, { scope: 'new' }).body).toBe('rewritten');
    expect(draftForScope(drafts, { scope: 'reply', threadId: 'thread-a' }).body).toBe('reply a');
    expect(draftForScope(drafts, { scope: 'reply', threadId: 'thread-b' }).body).toBe('reply b');
  });

  it('treats a legacy unscoped draft as a new message, not a reply', () => {
    const drafts = [{ body: 'inserted from inbox' }];
    expect(draftForScope(drafts, { scope: 'new' }).body).toBe('inserted from inbox');
    expect(draftForScope(drafts, { scope: 'reply', threadId: 'thread-a' })).toBeNull();
  });

  it('replaces a legacy draft when a new message is saved', () => {
    const drafts = upsertScopedDraft([{ body: 'old' }], fresh);
    expect(drafts).toEqual([fresh]);
  });

  it('removes only the draft that was sent', () => {
    const drafts = [fresh, replyA];
    expect(removeScopedDraft(drafts, { scope: 'reply', threadId: 'thread-a' })).toEqual([fresh]);
    expect(removeScopedDraft(drafts, { scope: 'new' })).toEqual([replyA]);
  });
});

const CHARACTERS = [
  { name: 'Priya Nair', email: 'priya@brightlabs.io' },
  { name: 'Sam Okafor', email: 'sam@brightlabs.io' },
];

const THREADS = [
  {
    id: 'thread-1',
    subject: 'Atlas migration — weekly status',
    emails: [
      {
        from: { name: 'Priya Nair', email: 'priya@brightlabs.io' },
        to: [{ name: 'You', email: 'you@brightlabs.io' }],
        cc: [{ name: 'Sam Okafor', email: 'sam@brightlabs.io' }],
        subject: 'Re: Atlas migration — weekly status',
        body: 'Can you pull together a summary?',
      },
    ],
  },
];

describe('parseInsertedDraft', () => {
  const context = { characters: CHARACTERS, threads: THREADS, learnerEmail: 'you@brightlabs.io' };

  it('addresses the reply from the subject and drops that line from the body', () => {
    const parsed = parseInsertedDraft(
      'Subject: Re: Atlas migration — weekly status\n\nPriya,\n\nHere is the summary.\n',
      context,
    );
    expect(parsed.to).toEqual(['priya@brightlabs.io']);
    expect(parsed.subject).toBe('Re: Atlas migration — weekly status');
    expect(parsed.body).toBe('Priya,\n\nHere is the summary.');
  });

  it('uses an explicit To line, including a first name', () => {
    const parsed = parseInsertedDraft('To: Priya\nCc: Sam Okafor\nSubject: Update\n\nHello.', context);
    expect(parsed.to).toEqual(['priya@brightlabs.io']);
    expect(parsed.cc).toEqual(['sam@brightlabs.io']);
    expect(parsed.subject).toBe('Update');
    expect(parsed.body).toBe('Hello.');
  });

  it('falls back to the greeting when nothing else names a recipient', () => {
    const parsed = parseInsertedDraft('Hi Priya,\n\nChecking in.', context);
    expect(parsed.to).toEqual(['priya@brightlabs.io']);
    expect(parsed.subject).toBe('');
  });

  it('leaves the recipient empty when the draft names nobody', () => {
    const parsed = parseInsertedDraft('Here is a note with no recipient.', context);
    expect(parsed.to).toEqual([]);
    expect(parsed.body).toBe('Here is a note with no recipient.');
  });

  it('does not substitute a thread recipient when an explicit To header is unresolved', () => {
    const parsed = parseInsertedDraft(
      'To: Unknown Person\nSubject: Re: Atlas migration — weekly status\n\nPriya,\n\nHello.',
      context,
    );
    expect(parsed.to).toEqual([]);
    expect(parsed.subject).toBe('Re: Atlas migration — weekly status');
  });

  it('uses the intended thread id when the subject matches more than one thread', () => {
    const threads = [
      THREADS[0],
      {
        id: 'thread-2',
        subject: 'Atlas migration — weekly status',
        emails: [
          {
            from: { name: 'Sam Okafor', email: 'sam@brightlabs.io' },
            to: [{ name: 'You', email: 'you@brightlabs.io' }],
            subject: 'Re: Atlas migration — weekly status',
            body: 'Different thread.',
          },
        ],
      },
    ];
    const ambiguous = parseInsertedDraft(
      'Subject: Re: Atlas migration — weekly status\n\nHello.',
      { ...context, threads },
    );
    expect(ambiguous.to).toEqual([]);

    const targeted = parseInsertedDraft(
      'Subject: Re: Atlas migration — weekly status\n\nHello.',
      { ...context, threads, threadId: 'thread-2' },
    );
    expect(targeted.to).toEqual(['sam@brightlabs.io']);
  });
});
