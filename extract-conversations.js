#!/usr/bin/env node
/**
 * extract-conversations.js
 *
 * Reads sessions.json and prints CosmoMail sessions in a human-readable,
 * Markdown-friendly form (newest session first). Grading stays outside this
 * project: the report is a transcript only. If sessions.json doesn't exist yet
 * (the participant never opened the scenario), this still produces a valid,
 * empty report that says so plainly instead of erroring out.
 *
 * Usage:
 *   node extract-conversations.js [--mode <mode>] [--latest] [--output <file>] [--print-settings]
 *
 * Modes:
 *   full        (default) Everything: the email thread(s) and the assistant
 *               conversation (if enabled for the scenario).
 *   submission  Only the participant's selected submission (falls back to the most
 *               recent sent email when none is chosen).
 *   thread      Only the email thread(s).
 *   assistant   Only the Cosmo assistant conversation.
 *   report      Generate a human-readable Markdown report (oldest first).
 *               Written to report.md by default (see --output / --stdout
 *               below).
 *
 * The assistant (Cosmo) conversation section is only included when the
 * scenario has `assistant.enabled` set to `true` (the default). When the
 * assistant is disabled for a scenario, the report notes that plainly instead
 * of rendering an empty section.
 *
 * With --print-settings, the report opens with a plain-language World and
 * Characters summary (no model config or IDs — just enough context to follow
 * the conversation).
 *
 * The emails (in `full`, `thread`, and `report` output) can be ordered two
 * ways via --order:
 *   thread        (default) Grouped by conversation thread, each thread's
 *                 emails in send order — good for reading one exchange
 *                 start-to-finish.
 *   chronological All threads merged into a single timeline by send time,
 *                 each email tagged with which thread it belongs to — good
 *                 for seeing how the participant moved between conversations.
 *
 * Options:
 *   --latest          Only include the most recent session.
 *   --order <order>   Email ordering: thread (default) or chronological.
 *   --output <file>   Write output to this file instead of the default.
 *   --stdout          Print to stdout instead of writing a file (report mode
 *                      writes to report.md by default; other modes already
 *                      print to stdout unless --output is given).
 *   --print-settings  Include the scenario's key settings in the heading.
 *   -h, --help        Show this help message.
 */

import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { characterIsLive, normalizeWorld } from './lib/character-replies.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SESSIONS_FILE = process.env.SESSIONS_FILE || join(__dirname, 'sessions.json');
const SCENARIO_FILE = process.env.SCENARIO_FILE || join(__dirname, 'scenario.json');

const VALID_MODES = ['full', 'submission', 'thread', 'assistant', 'report'];
const VALID_ORDERS = ['thread', 'chronological'];
const DEFAULT_REPORT_FILE = join(__dirname, 'report.md');

// ── Parse args ────────────────────────────────────────────────
const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  console.log(`Usage: node extract-conversations.js [options]

Options:
  --mode <mode>    Output mode (default: full)
                     full        Thread(s) + assistant
                     submission  Only the selected submission (or latest send)
                     thread      Only the email thread(s)
                     assistant   Only the Cosmo assistant conversation
                     report      Generate a human-readable Markdown report
                                 (oldest first). Written to report.md by
                                 default.
  --latest         Only include the most recent session
  --order <order>  Email ordering (default: thread)
                     thread        Grouped by conversation thread
                     chronological All threads merged into one timeline
  --output <file>  Write output to this file instead of the default
  --stdout         Print to stdout instead of writing report.md (report mode)
  --print-settings Include a human-readable World/Characters summary
  -h, --help       Show this help message

The assistant (Cosmo) conversation is only included when the scenario's
"assistant.enabled" is true (the default); otherwise the report notes that
the assistant was disabled for the scenario.`);
  process.exit(0);
}

let mode = 'full';
const modeIdx = args.indexOf('--mode');
if (modeIdx !== -1) {
  const provided = args[modeIdx + 1];
  if (!provided || !VALID_MODES.includes(provided)) {
    console.log(`Error: --mode must be one of: ${VALID_MODES.join(', ')}`);
    process.exit(1);
  }
  mode = provided;
}
let order = 'thread';
const orderIdx = args.indexOf('--order');
if (orderIdx !== -1) {
  const provided = args[orderIdx + 1];
  if (!provided || !VALID_ORDERS.includes(provided)) {
    console.log(`Error: --order must be one of: ${VALID_ORDERS.join(', ')}`);
    process.exit(1);
  }
  order = provided;
}
const latestOnly = args.includes('--latest');
const printSettings = args.includes('--print-settings');
const stdout = args.includes('--stdout');
const outputIdx = args.indexOf('--output');
const explicitOutputFile = outputIdx !== -1 && args[outputIdx + 1] ? args[outputIdx + 1] : null;
// Report mode is meant to be handed to a human grader, so it writes a
// report.md file by default instead of dumping to stdout.
const outputFile = explicitOutputFile ?? (mode === 'report' && !stdout ? DEFAULT_REPORT_FILE : null);

// ── Load ──────────────────────────────────────────────────────
// No sessions.json yet means the participant hasn't opened the scenario at
// all — that's a valid, reportable state, not an error. Any other
// read/parse failure (a corrupt or unreadable file that does exist) is a
// real problem and still stops the script.
let data;
try {
  data = JSON.parse(readFileSync(SESSIONS_FILE, 'utf8'));
} catch (err) {
  if (err.code === 'ENOENT') {
    data = { sessions: [] };
  } else {
    console.log(`Could not read ${SESSIONS_FILE}: ${err.message}`);
    process.exit(1);
  }
}

let scenario = {};
try {
  scenario = JSON.parse(readFileSync(SCENARIO_FILE, 'utf8'));
} catch {
  scenario = {};
}

// Defaults to true, matching lib/scenario.js's default for `assistant.enabled`.
const assistantEnabled = scenario.assistant?.enabled !== false;

const sessions = (data.sessions ?? [])
  .slice()
  .sort((a, b) => new Date(b.updated_at || b.created_at) - new Date(a.updated_at || a.created_at));

const toRender = latestOnly ? sessions.slice(0, 1) : sessions;
const NO_SESSIONS_MESSAGE =
  '_No sessions recorded yet — the participant has not started this scenario._';

// ── Helpers ───────────────────────────────────────────────────
function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? String(iso)
    : d.toLocaleString(undefined, {
        year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
      });
}

function addr(a) {
  if (!a) return '';
  if (typeof a === 'string') return a;
  return a.name ? `${a.name} <${a.email}>` : a.email || '';
}

function addrList(list) {
  if (!Array.isArray(list)) return addr(list);
  return list.map(addr).join(', ');
}

// A plain-language overview of the scenario for a human grader — the setting
// and who's involved. Deliberately leaves out model/generation config, IDs,
// and other internals that don't help someone read the conversation.
function overviewLines() {
  if (!printSettings) return [];
  const lines = [];

  const world = normalizeWorld(scenario.world);
  if (world) {
    lines.push('## World', '', world, '');
  }

  const characters = scenario.characters || [];
  if (characters.length) {
    lines.push('## Characters', '');
    for (const character of characters) {
      const name = character.name || character.id || '(unnamed)';
      const bits = [character.role, character.email].filter(Boolean).join(' — ');
      const tag = characterIsLive(character) ? '' : ' _(directory only — does not write back)_';
      lines.push(`- **${name}**${bits ? ` — ${bits}` : ''}${tag}`);
    }
    lines.push('');
  }

  if (!lines.length) return [];
  lines.push('---', '');
  return lines;
}

function emailLines(email) {
  const dir = email.outbound ? 'Outbound (participant)' : 'Inbound';
  const lines = [
    `**From:** ${addr(email.from)}  `,
    `**To:** ${addrList(email.to)}  `,
  ];
  if (email.cc?.length) lines.push(`**Cc:** ${addrList(email.cc)}  `);
  lines.push(`**Date:** ${formatDate(email.date)} · _${dir}_  `);
  if (email.subject) lines.push(`**Subject:** ${email.subject}  `);
  if (email.attachments?.length) {
    lines.push(`**Attachments:** ${email.attachments.map((a) => a.name || 'file').join(', ')}  `);
  }
  lines.push('');
  lines.push(String(email.body ?? ''));
  lines.push('');
  return lines;
}

function threadLines(session) {
  const lines = [];
  for (const thread of session.threads ?? []) {
    lines.push(`### Thread: ${thread.subject || '(no subject)'}`);
    lines.push('');
    const emails = thread.emails ?? [];
    if (!emails.length) {
      lines.push('_(no emails)_', '');
      continue;
    }
    emails.forEach((email, i) => {
      lines.push(...emailLines(email));
      if (i < emails.length - 1) lines.push('---', '');
    });
  }
  return lines;
}

// All threads merged into one timeline by send time, each email tagged with
// which thread it belongs to. Useful for seeing how the participant moved
// between conversations, rather than reading each one start-to-finish.
function chronologicalLines(session) {
  const items = (session.threads ?? []).flatMap((thread) =>
    (thread.emails ?? []).map((email) => ({
      email,
      threadSubject: thread.subject || '(no subject)',
    })),
  );
  const lines = ['### Email history (chronological)', ''];
  if (!items.length) {
    lines.push('_(no emails)_', '');
    return lines;
  }
  items.sort((a, b) => new Date(a.email.date || 0) - new Date(b.email.date || 0));
  items.forEach(({ email, threadSubject }, i) => {
    lines.push(`**Thread:** ${threadSubject}  `);
    lines.push(...emailLines(email));
    if (i < items.length - 1) lines.push('---', '');
  });
  return lines;
}

function emailHistoryLines(session) {
  return order === 'chronological' ? chronologicalLines(session) : threadLines(session);
}

function addrListPlain(list) {
  if (!Array.isArray(list)) return String(list || '');
  return list.join(', ');
}

function draftFieldLines(draft, indent = '') {
  if (!draft) return [];
  const lines = [];
  if (draft.to?.length) lines.push(`${indent}- **To:** ${addrListPlain(draft.to)}`);
  if (draft.cc?.length) lines.push(`${indent}- **Cc:** ${addrListPlain(draft.cc)}`);
  if (draft.subject) lines.push(`${indent}- **Subject:** ${draft.subject}`);
  if (draft.body) {
    lines.push(`${indent}- **Body:**`, '');
    for (const line of String(draft.body).split('\n')) {
      lines.push(`${indent}  ${line}`);
    }
  }
  return lines;
}

// AI draft provenance: propose → insert → (optional) send-with-edit-distance;
// plus quick_action chip events (not learner chat turns).
function provenanceLines(session) {
  const events = session.events ?? [];
  const lines = ['### AI draft provenance', ''];
  if (!events.length) {
    lines.push('_No AI draft events recorded in this session._', '');
    return lines;
  }

  for (const event of events) {
    const when = formatDate(event.timestamp);
    if (event.type === 'draft_proposed') {
      lines.push(`- **Draft proposed** (${event.source || 'propose-draft'}${when ? ` · ${when}` : ''})`);
      lines.push(`  - draftId: \`${event.draftId}\``);
      lines.push(...draftFieldLines(event.draft, '  '));
    } else if (event.type === 'draft_inserted') {
      const scope = event.scope?.scope === 'reply'
        ? `reply on ${event.scope.threadId || 'thread'}`
        : 'new message';
      lines.push(`- **Draft inserted** into composer (${scope}${when ? ` · ${when}` : ''})`);
      lines.push(`  - draftId: \`${event.draftId}\``);
    } else if (event.type === 'draft_sent') {
      const dist = event.editDistance;
      const distSummary = dist
        ? `body edit distance ${dist.body}, subject ${dist.subject}, total ${dist.total}`
        : 'no insert baseline';
      lines.push(`- **Draft sent** (${distSummary}${when ? ` · ${when}` : ''})`);
      if (event.draftId) lines.push(`  - draftId: \`${event.draftId}\``);
      if (event.emailId) lines.push(`  - emailId: \`${event.emailId}\``);
      if (dist) {
        lines.push(
          `  - recipients: to ±${dist.to?.total ?? 0}, cc ±${dist.cc?.total ?? 0}`,
        );
      }
    } else if (event.type === 'quick_action') {
      lines.push(
        `- **Quick action** \`${event.action || 'unknown'}\` (${event.source || 'quick-action'}${when ? ` · ${when}` : ''})`,
      );
      if (event.draftId) lines.push(`  - draftId: \`${event.draftId}\``);
      if (event.threadId) lines.push(`  - threadId: \`${event.threadId}\``);
      if (event.replies?.length) {
        lines.push(`  - suggested replies (${event.replies.length}):`);
        for (const reply of event.replies) {
          for (const line of String(reply).split('\n')) lines.push(`    > ${line}`);
          lines.push('');
        }
      }
      if (event.headers) lines.push(...draftFieldLines(event.headers, '  '));
      if (event.draft) lines.push(...draftFieldLines(event.draft, '  '));
    } else {
      lines.push(`- **${event.type}**${when ? ` · ${when}` : ''}`);
    }
    lines.push('');
  }
  return lines;
}

function assistantLines(session) {
  const lines = ['### Assistant conversation (Cosmo)', ''];
  if (!assistantEnabled) {
    lines.push(
      '_The Cosmo assistant was disabled for this scenario, so the participant worked without AI help._',
      '',
    );
    return lines;
  }

  const msgs = session.assistant_messages ?? [];
  if (!msgs.length) {
    lines.push(
      '_The assistant was available, but the participant did not use it in this session._',
      '',
    );
    lines.push(...provenanceLines(session));
    return lines;
  }

  const participantTurns = msgs.filter((m) => m.role === 'user').length;
  const cosmoTurns = msgs.length - participantTurns;
  lines.push(
    `_Summary: ${participantTurns} participant message(s), ${cosmoTurns} Cosmo reply(ies)._`,
    '',
  );

  for (const m of msgs) {
    const who = m.role === 'user' ? 'Participant' : 'Cosmo';
    lines.push(`**${who}:**`);
    if (m.role === 'user') {
      lines.push(...String(m.content || '').split('\n').map((l) => `> ${l}`));
    } else {
      lines.push('', String(m.content || ''));
      for (const draft of m.drafts ?? []) {
        lines.push('', '_Proposed draft (structured):_');
        lines.push(...draftFieldLines(draft));
      }
    }
    lines.push('');
  }
  lines.push(...provenanceLines(session));
  return lines;
}

function findSubmissionEmail(session) {
  const sel = session.selected_submission;
  const allOutbound = (session.threads ?? []).flatMap((t) => t.emails ?? []).filter((e) => e.outbound);
  if (sel?.email_id) {
    for (const thread of session.threads ?? []) {
      const email = (thread.emails ?? []).find((e) => e.id === sel.email_id);
      if (email) return { email, submitted: true };
    }
  }
  if (allOutbound.length) return { email: allOutbound[allOutbound.length - 1], submitted: false };
  return null;
}

function submissionLines(session) {
  const found = findSubmissionEmail(session);
  const lines = ['### Submission', ''];
  if (!found) {
    lines.push('_(no email submitted or sent)_', '');
    return lines;
  }
  lines.push(found.submitted ? '_Explicitly submitted by the participant._' : '_Defaulted to the most recent send (no explicit submission)._', '');
  lines.push(...emailLines(found.email));
  return lines;
}

// Only label sessions "Session N" when there's more than one to tell apart —
// in practice there's almost always exactly one, so that heading would just
// be noise.
function sessionHeader(session, index, total) {
  const lines = [];
  if (total > 1) {
    lines.push(`## Session ${index + 1}`, '');
  }
  lines.push(`**Updated:** ${formatDate(session.updated_at || session.created_at)}  `, '');
  return lines;
}

function renderSession(session, index, total) {
  const lines = [...sessionHeader(session, index, total)];
  if (mode === 'thread') {
    lines.push(...emailHistoryLines(session));
  } else if (mode === 'assistant') {
    lines.push(...assistantLines(session));
  } else if (mode === 'submission') {
    lines.push(...submissionLines(session));
  } else {
    // full
    lines.push(...emailHistoryLines(session));
    lines.push('---', '');
    lines.push(...assistantLines(session));
  }
  return lines;
}

// ── Emit ──────────────────────────────────────────────────────
function emit(text) {
  if (outputFile) {
    writeFileSync(outputFile, text);
    console.log(`Written to ${outputFile}`);
  } else {
    console.log(text);
  }
}

if (mode === 'report') {
  const reportSessions = [...toRender].reverse();
  const lines = [];
  lines.push('# CosmoMail Session Report', '');
  lines.push(`*Generated on ${formatDate(new Date().toISOString())}*`, '', '---', '');
  lines.push(...overviewLines());
  if (reportSessions.length === 0) {
    lines.push(NO_SESSIONS_MESSAGE, '');
  } else {
    reportSessions.forEach((session, idx) => {
      lines.push(...renderSession(session, idx, reportSessions.length));
      if (idx < reportSessions.length - 1) lines.push('---', '');
    });
  }
  emit(lines.join('\n'));
  process.exit(0);
}

const out = [];
out.push(...overviewLines());
if (toRender.length === 0) {
  out.push(NO_SESSIONS_MESSAGE, '');
} else {
  toRender.forEach((session, idx) => {
    out.push(...renderSession(session, idx, toRender.length));
    if (idx < toRender.length - 1) out.push('', '---', '');
  });
}
emit(out.join('\n'));
