import { describe, it, expect } from 'vitest';
import {
  resolveRelativeDateExpression,
  expandRelativeDatesInString,
  expandRelativeDateField,
  expandRelativeDatesInInbox,
} from '../lib/relative-dates.js';

const NOW = new Date('2026-09-30T15:30:00Z');

describe('resolveRelativeDateExpression', () => {
  it('resolves today / tomorrow / yesterday', () => {
    expect(resolveRelativeDateExpression('today', NOW).toISOString()).toBe('2026-09-30T00:00:00.000Z');
    expect(resolveRelativeDateExpression('tomorrow', NOW).toISOString()).toBe('2026-10-01T00:00:00.000Z');
    expect(resolveRelativeDateExpression('yesterday', NOW).toISOString()).toBe('2026-09-29T00:00:00.000Z');
  });

  it('resolves next week / last week and N-day offsets', () => {
    expect(resolveRelativeDateExpression('next week', NOW).toISOString()).toBe('2026-10-07T00:00:00.000Z');
    expect(resolveRelativeDateExpression('last week', NOW).toISOString()).toBe('2026-09-23T00:00:00.000Z');
    expect(resolveRelativeDateExpression('3 days from today', NOW).toISOString()).toBe('2026-10-03T00:00:00.000Z');
    expect(resolveRelativeDateExpression('in 2 days', NOW).toISOString()).toBe('2026-10-02T00:00:00.000Z');
    expect(resolveRelativeDateExpression('5 days ago', NOW).toISOString()).toBe('2026-09-25T00:00:00.000Z');
  });

  it('returns null for unknown expressions', () => {
    expect(resolveRelativeDateExpression('next fiscal quarter', NOW)).toBeNull();
  });
});

describe('expandRelativeDatesInString', () => {
  it('expands tokens in prose', () => {
    expect(expandRelativeDatesInString('By ${today}', NOW)).toBe('By 2026-09-30');
    expect(expandRelativeDatesInString('Due ${next week} or ${3 days from today}', NOW))
      .toBe('Due 2026-10-07 or 2026-10-03');
  });

  it('leaves unknown tokens intact', () => {
    expect(expandRelativeDatesInString('See ${mystery}', NOW)).toBe('See ${mystery}');
  });
});

describe('expandRelativeDateField', () => {
  it('turns a bare token into an ISO datetime', () => {
    expect(expandRelativeDateField('${today}', NOW)).toBe('2026-09-30T12:00:00Z');
  });

  it('preserves an explicit time suffix', () => {
    expect(expandRelativeDateField('${3 days ago}T14:02:00Z', NOW)).toBe('2026-09-27T14:02:00Z');
  });
});

describe('expandRelativeDatesInInbox', () => {
  it('expands dates, bodies, and attachment text', () => {
    const inbox = expandRelativeDatesInInbox({
      threads: [
        {
          id: 't1',
          subject: 'Due ${next week}',
          emails: [
            {
              id: 'e1',
              date: '${today}T09:00:00Z',
              body: 'Please reply by ${3 days from today}.',
              attachments: [
                { name: 'note.txt', text: 'Valid through ${tomorrow}' },
                { name: 'empty.pdf' },
              ],
            },
          ],
        },
      ],
    }, NOW);

    const email = inbox.threads[0].emails[0];
    expect(inbox.threads[0].subject).toBe('Due 2026-10-07');
    expect(email.date).toBe('2026-09-30T09:00:00Z');
    expect(email.body).toBe('Please reply by 2026-10-03.');
    expect(email.attachments[0].text).toBe('Valid through 2026-10-01');
    expect(email.attachments[1].name).toBe('empty.pdf');
  });
});
