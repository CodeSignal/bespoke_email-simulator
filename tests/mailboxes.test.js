import { describe, it, expect } from 'vitest';
import {
  normalizeMailbox,
  emailIsOutbound,
  threadInMailbox,
  threadsInMailbox,
  mailboxCounts,
  mailboxForThread,
  buildReplyHeaders,
} from '../lib/mailboxes.js';

const learner = 'you@company.com';

const inbound = {
  id: 'in-1',
  from: { name: 'Dana', email: 'dana@acme.com' },
  to: [{ email: learner }],
  body: 'hello',
};

const outbound = {
  id: 'out-1',
  from: { name: 'You', email: learner },
  to: [{ email: 'dana@acme.com' }],
  outbound: true,
  body: 'reply',
};

const inboxThread = { id: 't-inbox', subject: 'Hello', emails: [inbound] };
const repliedThread = { id: 't-replied', subject: 'Hello', emails: [inbound, outbound] };
const sentThread = { id: 't-sent', subject: 'Outreach', emails: [outbound] };
const spamThread = {
  id: 't-spam',
  mailbox: 'spam',
  subject: 'Winner',
  emails: [{ id: 's1', from: { email: 'spam@biz' }, body: 'prize' }],
};

describe('normalizeMailbox', () => {
  it('treats missing or unknown values as inbox, and spam as spam', () => {
    expect(normalizeMailbox(undefined)).toBe('inbox');
    expect(normalizeMailbox('INBOX')).toBe('inbox');
    expect(normalizeMailbox('sent')).toBe('inbox');
    expect(normalizeMailbox('spam')).toBe('spam');
    expect(normalizeMailbox('SPAM')).toBe('spam');
  });
});

describe('emailIsOutbound', () => {
  it('honors the outbound flag or a matching learner from-address', () => {
    expect(emailIsOutbound(outbound, learner)).toBe(true);
    expect(emailIsOutbound({ from: { email: learner } }, learner)).toBe(true);
    expect(emailIsOutbound(inbound, learner)).toBe(false);
    expect(emailIsOutbound({ outbound: true }, null)).toBe(true);
  });
});

describe('threadInMailbox', () => {
  it('puts received threads in Inbox only', () => {
    expect(threadInMailbox(inboxThread, 'inbox', learner)).toBe(true);
    expect(threadInMailbox(inboxThread, 'sent', learner)).toBe(false);
    expect(threadInMailbox(inboxThread, 'spam', learner)).toBe(false);
  });

  it('puts a replied thread in both Inbox and Sent', () => {
    expect(threadInMailbox(repliedThread, 'inbox', learner)).toBe(true);
    expect(threadInMailbox(repliedThread, 'sent', learner)).toBe(true);
    expect(threadInMailbox(repliedThread, 'spam', learner)).toBe(false);
  });

  it('puts a newly composed outbound thread in Sent only', () => {
    expect(threadInMailbox(sentThread, 'inbox', learner)).toBe(false);
    expect(threadInMailbox(sentThread, 'sent', learner)).toBe(true);
  });

  it('keeps mailbox:spam threads in Spam even if they have outbound mail', () => {
    const repliedSpam = { ...spamThread, emails: [...spamThread.emails, outbound] };
    expect(threadInMailbox(repliedSpam, 'spam', learner)).toBe(true);
    expect(threadInMailbox(repliedSpam, 'inbox', learner)).toBe(false);
    expect(threadInMailbox(repliedSpam, 'sent', learner)).toBe(false);
  });
});

describe('mailboxCounts / mailboxForThread', () => {
  const threads = [inboxThread, repliedThread, sentThread, spamThread];

  it('counts each folder, with replied threads contributing to Inbox and Sent', () => {
    expect(mailboxCounts(threads, learner)).toEqual({ inbox: 2, sent: 2, spam: 1 });
    expect(threadsInMailbox(threads, 'sent', learner).map((t) => t.id)).toEqual(['t-replied', 't-sent']);
  });

  it('opens a dual-folder thread in Inbox rather than Sent', () => {
    expect(mailboxForThread(repliedThread, learner)).toBe('inbox');
    expect(mailboxForThread(sentThread, learner)).toBe('sent');
    expect(mailboxForThread(spamThread, learner)).toBe('spam');
  });
});

describe('buildReplyHeaders', () => {
  const inbound = {
    from: { name: 'Dana', email: 'dana@acme.com' },
    to: [{ email: learner }, { email: 'alex@company.com' }],
    cc: [{ email: 'pat@company.com' }],
    subject: 'Proposal',
  };

  it('replies only to the sender', () => {
    expect(buildReplyHeaders(inbound, { mode: 'reply', learnerEmail: learner })).toEqual({
      to: ['dana@acme.com'],
      cc: [],
      subject: 'Re: Proposal',
    });
  });

  it('reply-all keeps other recipients except the learner', () => {
    expect(buildReplyHeaders(inbound, { mode: 'replyAll', learnerEmail: learner })).toEqual({
      to: ['dana@acme.com'],
      cc: ['alex@company.com', 'pat@company.com'],
      subject: 'Re: Proposal',
    });
  });

  it('replies to the original To when the last mail was outbound', () => {
    const outbound = {
      from: { email: learner },
      to: [{ email: 'dana@acme.com' }],
      cc: [{ email: 'alex@company.com' }],
      outbound: true,
      subject: 'Re: Proposal',
    };
    expect(buildReplyHeaders(outbound, { mode: 'reply', learnerEmail: learner })).toEqual({
      to: ['dana@acme.com'],
      cc: [],
      subject: 'Re: Proposal',
    });
    expect(buildReplyHeaders(outbound, { mode: 'replyAll', learnerEmail: learner })).toEqual({
      to: ['dana@acme.com'],
      cc: ['alex@company.com'],
      subject: 'Re: Proposal',
    });
  });
});
