/**
 * Mailbox membership for the simulated client (Inbox / Sent / Spam).
 *
 * `thread.mailbox` is only used to put a thread in Spam (`"spam"`). Everything
 * else is Inbox by default. Sent is derived: a non-spam thread appears there
 * once it contains an outbound (learner-sent) email. A replied inbox thread
 * therefore shows up in both Inbox and Sent, like a real client.
 */

export const MAILBOXES = [
  { id: 'inbox', label: 'Inbox' },
  { id: 'sent', label: 'Sent' },
  { id: 'spam', label: 'Spam' },
];

export function normalizeMailbox(value) {
  return String(value || 'inbox').toLowerCase() === 'spam' ? 'spam' : 'inbox';
}

function fromEmail(email) {
  if (!email?.from) return '';
  if (typeof email.from === 'string') return email.from;
  return email.from.email || '';
}

export function emailIsOutbound(email, learnerEmail) {
  if (!email) return false;
  if (email.outbound === true) return true;
  if (!learnerEmail) return false;
  return fromEmail(email).toLowerCase() === String(learnerEmail).toLowerCase();
}

export function threadInMailbox(thread, mailbox, learnerEmail) {
  if (normalizeMailbox(thread?.mailbox) === 'spam') return mailbox === 'spam';
  if (mailbox === 'spam') return false;

  const emails = thread?.emails ?? [];
  const hasOutbound = emails.some((email) => emailIsOutbound(email, learnerEmail));
  const hasInbound = emails.some((email) => !emailIsOutbound(email, learnerEmail));

  if (mailbox === 'sent') return hasOutbound;
  // Inbox: received mail, or an empty placeholder thread.
  return hasInbound || !hasOutbound;
}

export function threadsInMailbox(threads, mailbox, learnerEmail) {
  return (threads ?? []).filter((thread) => threadInMailbox(thread, mailbox, learnerEmail));
}

export function mailboxCounts(threads, learnerEmail) {
  const counts = { inbox: 0, sent: 0, spam: 0 };
  for (const id of Object.keys(counts)) {
    counts[id] = threadsInMailbox(threads, id, learnerEmail).length;
  }
  return counts;
}

// Prefer Inbox over Sent when a thread lives in both (a normal reply).
export function mailboxForThread(thread, learnerEmail) {
  if (threadInMailbox(thread, 'spam', learnerEmail)) return 'spam';
  if (threadInMailbox(thread, 'inbox', learnerEmail)) return 'inbox';
  if (threadInMailbox(thread, 'sent', learnerEmail)) return 'sent';
  return 'inbox';
}
