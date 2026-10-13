import { describe, expect, it } from 'vitest';
import {
  FORWARDED_DIVIDER,
  bodyWithForwarded,
  findThreadEmail,
  forwardedLines,
  forwardedSnapshot,
  forwardSubject,
} from '../lib/forwarding.js';
import { serializeMailbox, buildMailboxContext } from '../lib/assistant.js';

const DANA = { name: 'Dana Reyes', email: 'dana@acme.test' };
const ALEX = { name: 'Alex', email: 'alex@northwind.test' };

const quote = {
  id: 'email-quote',
  from: DANA,
  to: [ALEX],
  date: '2026-10-05T15:00:00.000Z',
  subject: 'Vendor quote',
  body: 'Please review the Friday shipment.',
  attachments: [{ name: 'quote.txt', text: 'Total: $1,200' }],
};

const threads = [{ id: 'thread-quote', subject: 'Vendor quote', emails: [quote] }];

describe('forwardSubject', () => {
  it('prefixes Fwd: once', () => {
    expect(forwardSubject('Vendor quote')).toBe('Fwd: Vendor quote');
    expect(forwardSubject('Fwd: Vendor quote')).toBe('Fwd: Vendor quote');
    expect(forwardSubject('FW: Vendor quote')).toBe('FW: Vendor quote');
    expect(forwardSubject('Re: Vendor quote')).toBe('Fwd: Re: Vendor quote');
    expect(forwardSubject('')).toBe('');
  });
});

describe('findThreadEmail', () => {
  it('finds an email by thread and id', () => {
    expect(findThreadEmail(threads, { threadId: 'thread-quote', emailId: 'email-quote' })?.email).toBe(quote);
  });

  it('returns null for a missing or partial reference', () => {
    expect(findThreadEmail(threads, { threadId: 'thread-quote', emailId: 'nope' })).toBeNull();
    expect(findThreadEmail(threads, { threadId: 'nope', emailId: 'email-quote' })).toBeNull();
    expect(findThreadEmail(threads, { emailId: 'email-quote' })).toBeNull();
    expect(findThreadEmail(threads, undefined)).toBeNull();
  });
});

describe('forwardedSnapshot', () => {
  it('copies the headers, body, and attachments', () => {
    expect(forwardedSnapshot(quote)).toEqual({
      emailId: 'email-quote',
      from: DANA,
      to: [ALEX],
      cc: [],
      date: '2026-10-05T15:00:00.000Z',
      subject: 'Vendor quote',
      body: 'Please review the Friday shipment.',
      attachments: [{ name: 'quote.txt', text: 'Total: $1,200' }],
    });
  });

  it('falls back to the thread subject and keeps a nested forward', () => {
    const inner = forwardedSnapshot(quote);
    const snapshot = forwardedSnapshot(
      { id: 'email-fwd', from: ALEX, to: [DANA], body: 'FYI', forwarded: inner },
      { subjectFallback: 'Fwd: Vendor quote' },
    );
    expect(snapshot.subject).toBe('Fwd: Vendor quote');
    expect(snapshot.forwarded).toBe(inner);
  });
});

describe('forwardedLines / bodyWithForwarded', () => {
  it('quotes the original under the cover note', () => {
    const email = { body: 'Sam, can you take this?', forwarded: forwardedSnapshot(quote) };
    expect(bodyWithForwarded(email)).toBe([
      'Sam, can you take this?',
      '',
      FORWARDED_DIVIDER,
      'From: Dana Reyes <dana@acme.test>',
      'Date: 2026-10-05T15:00:00.000Z',
      'Subject: Vendor quote',
      'To: Alex <alex@northwind.test>',
      '',
      'Please review the Friday shipment.',
      '',
      'Attachments: quote.txt',
    ].join('\n'));
  });

  it('returns the plain body when nothing was forwarded', () => {
    expect(bodyWithForwarded({ body: 'Hello' })).toBe('Hello');
    expect(forwardedLines(null)).toEqual([]);
  });

  it('includes nested forwards', () => {
    const inner = forwardedSnapshot(quote);
    const outer = forwardedSnapshot({ id: 'e2', from: ALEX, to: [DANA], subject: 'Fwd: Vendor quote', body: 'FYI', forwarded: inner });
    const text = forwardedLines(outer).join('\n');
    expect(text.split(FORWARDED_DIVIDER)).toHaveLength(3);
    expect(text).toContain('FYI');
    expect(text).toContain('Please review the Friday shipment.');
  });
});

describe('Cosmo mailbox context', () => {
  it('includes the forwarded original and its seeded attachment text', () => {
    const sent = {
      id: 'email-fwd',
      from: ALEX,
      to: [{ name: 'Sam', email: 'sam@acme.test' }],
      outbound: true,
      subject: 'Fwd: Vendor quote',
      body: 'Sam, can you take this?',
      forwarded: forwardedSnapshot(quote),
    };
    const text = serializeMailbox(
      [...threads, { id: 'thread-fwd', subject: 'Fwd: Vendor quote', emails: [sent] }],
      { learnerEmail: ALEX.email },
    );
    expect(text).toContain(FORWARDED_DIVIDER);
    expect(text).toContain('Date: 2026-10-05 15:00 UTC');
    expect(text).toContain('Total: $1,200');
  });

  it('says when the composer holds a forward', () => {
    const { text } = buildMailboxContext({
      threads,
      learnerEmail: ALEX.email,
      viewing: { composingNew: true, forwarding: { threadId: 'thread-quote', emailId: 'email-quote' } },
    });
    expect(text).toMatch(/^Currently viewing: a forward in the composer of email email-quote from thread "Vendor quote"/);
  });

  it('labels a saved forward draft', () => {
    const text = serializeMailbox(threads, {
      drafts: [{ scope: 'new', id: 'd1', subject: 'Fwd: Vendor quote', body: 'Note', forwardOf: { threadId: 'thread-quote', emailId: 'email-quote' } }],
    });
    expect(text).toContain('(forward of email email-quote in thread thread-quote)');
  });
});
