/**
 * Forwarding, shared by the server and the browser bundle.
 *
 * A forward keeps the original message as a structured snapshot on the
 * outbound email (`email.forwarded`) instead of pasting it into the body. The
 * learner's cover note stays the editable body, and the reading pane,
 * characters, Cosmo, and the session export all show the same original.
 *
 * A forward always starts a new thread, so a recipient only sees what was
 * forwarded, never the rest of the source conversation.
 */

export const FORWARDED_DIVIDER = '---------- Forwarded message ----------';

export function forwardSubject(subject) {
  const subj = String(subject || '').trim();
  if (!subj) return '';
  return /^fwd?:/i.test(subj) ? subj : `Fwd: ${subj}`;
}

export function findThreadEmail(threads, { threadId, emailId } = {}) {
  if (!threadId || !emailId) return null;
  const thread = (threads ?? []).find((th) => th.id === threadId);
  const email = thread?.emails?.find((item) => item.id === emailId);
  return email ? { thread, email } : null;
}

/** The copy of `email` that travels with a forward (nested forwards included). */
export function forwardedSnapshot(email, { subjectFallback = '' } = {}) {
  if (!email) return null;
  const snapshot = {
    emailId: email.id ?? null,
    from: email.from ?? null,
    to: Array.isArray(email.to) ? email.to : (email.to ? [email.to] : []),
    cc: Array.isArray(email.cc) ? email.cc : [],
    date: email.date ?? null,
    subject: email.subject || subjectFallback || '',
    body: String(email.body ?? ''),
    attachments: Array.isArray(email.attachments) ? email.attachments : [],
  };
  if (email.forwarded) snapshot.forwarded = email.forwarded;
  return snapshot;
}

function formatAddress(addr) {
  if (!addr) return '';
  if (typeof addr === 'string') return addr;
  return addr.name ? `${addr.name} <${addr.email}>` : addr.email || '';
}

function formatAddressList(list) {
  if (!list) return '';
  return (Array.isArray(list) ? list : [list]).map(formatAddress).filter(Boolean).join(', ');
}

function attachmentNames(attachments) {
  if (!attachments?.length) return [];
  return [`Attachments: ${attachments.map((a) => a?.name || 'file').join(', ')}`];
}

/**
 * Plain-text lines for a forwarded block, as a mail client would quote it.
 * `attachmentLines` lets Cosmo's context include seeded attachment text.
 */
export function forwardedLines(forwarded, {
  formatDate = (value) => String(value ?? ''),
  attachmentLines = attachmentNames,
} = {}) {
  if (!forwarded) return [];
  const lines = ['', FORWARDED_DIVIDER, `From: ${formatAddress(forwarded.from)}`];
  if (forwarded.date) lines.push(`Date: ${formatDate(forwarded.date)}`);
  if (forwarded.subject) lines.push(`Subject: ${forwarded.subject}`);
  lines.push(`To: ${formatAddressList(forwarded.to)}`);
  if (forwarded.cc?.length) lines.push(`Cc: ${formatAddressList(forwarded.cc)}`);
  lines.push('', String(forwarded.body ?? ''));
  const attachments = attachmentLines(forwarded.attachments ?? []);
  if (attachments.length) lines.push('', ...attachments);
  lines.push(...forwardedLines(forwarded.forwarded, { formatDate, attachmentLines }));
  return lines;
}

/** The email body followed by any forwarded message, as plain text. */
export function bodyWithForwarded(email, options) {
  const body = String(email?.body ?? '');
  if (!email?.forwarded) return body;
  return [body, ...forwardedLines(email.forwarded, options)].join('\n');
}
