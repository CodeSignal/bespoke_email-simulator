#!/usr/bin/env node
/**
 * extract-conversations.js
 *
 * Reads sessions.json and prints CosmoMail sessions in a human-readable,
 * Markdown-friendly form (newest session first), for feeding into an AI tutor or
 * an assessment rubric.
 *
 * Usage:
 *   node extract-conversations.js [--mode <mode>] [--latest] [--output <file>] [--print-settings]
 *
 * Modes:
 *   full        (default) Everything: the email thread(s), the current draft,
 *               the assistant conversation, and the selected submission.
 *   submission  Only the learner's selected submission (falls back to the most
 *               recent sent email when none is chosen).
 *   thread      Only the email thread(s).
 *   assistant   Only the Cosmo assistant conversation.
 *   report      Generate a Markdown report (oldest first), with scenario
 *               rubric hints in the header.
 *
 * Options:
 *   --latest          Only include the most recent session.
 *   --output <file>   Write output to a file instead of stdout.
 *   --print-settings  Include the scenario's key settings in the heading.
 *   -h, --help        Show this help message.
 */

import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SESSIONS_FILE = join(__dirname, 'sessions.json');
const SCENARIO_FILE = join(__dirname, 'scenario.json');

const VALID_MODES = ['full', 'submission', 'thread', 'assistant', 'report'];

// ── Parse args ────────────────────────────────────────────────
const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  console.log(`Usage: node extract-conversations.js [options]

Options:
  --mode <mode>    Output mode (default: full)
                     full        Thread(s) + draft + assistant + submission
                     submission  Only the selected submission (or latest send)
                     thread      Only the email thread(s)
                     assistant   Only the Cosmo assistant conversation
                     report      Generate a Markdown report (oldest first)
  --latest         Only include the most recent session
  --output <file>  Write output to a file instead of stdout
  --print-settings Include the scenario's key settings in the heading
  -h, --help       Show this help message`);
  process.exit(0);
}

let mode = 'full';
const modeIdx = args.indexOf('--mode');
if (modeIdx !== -1) {
  const provided = args[modeIdx + 1];
  if (!provided || !VALID_MODES.includes(provided)) {
    console.error(`Error: --mode must be one of: ${VALID_MODES.join(', ')}`);
    process.exit(1);
  }
  mode = provided;
}
const latestOnly = args.includes('--latest');
const printSettings = args.includes('--print-settings');
const outputIdx = args.indexOf('--output');
const outputFile = outputIdx !== -1 && args[outputIdx + 1] ? args[outputIdx + 1] : null;

// ── Load ──────────────────────────────────────────────────────
let data;
try {
  data = JSON.parse(readFileSync(SESSIONS_FILE, 'utf8'));
} catch (err) {
  console.error(`Could not read ${SESSIONS_FILE}: ${err.message}`);
  process.exit(1);
}

let scenario = {};
try {
  scenario = JSON.parse(readFileSync(SCENARIO_FILE, 'utf8'));
} catch {
  scenario = {};
}

const sessions = (data.sessions ?? [])
  .slice()
  .sort((a, b) => new Date(b.updated_at || b.created_at) - new Date(a.updated_at || a.created_at));

if (sessions.length === 0) {
  console.log('No sessions found.');
  process.exit(0);
}

const toRender = latestOnly ? sessions.slice(0, 1) : sessions;

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

function settingsHeadingLines() {
  if (!printSettings) return [];
  const settings = {
    scenarioId: scenario.id,
    primarySkill: scenario.primarySkill,
    scenarioType: scenario.scenarioType,
    generation: scenario.generation,
    world: scenario.world || '',
    characters: (scenario.characters || []).map((character) => ({
      id: character.id,
      name: character.name,
      email: character.email,
      role: character.role || '',
      responds: character.responds,
    })),
    submission: scenario.submission,
  };
  return ['# Settings', '', '```json', JSON.stringify(settings, null, 2), '```', '', '---', ''];
}

function rubricHintLines() {
  const hints = scenario.rubricHints;
  if (!hints || (typeof hints === 'object' && Object.keys(hints).length === 0)) return [];
  const body = typeof hints === 'string' ? hints : JSON.stringify(hints, null, 2);
  return ['## Rubric hints', '', typeof hints === 'string' ? body : '```json\n' + body + '\n```', '', '---', ''];
}

function emailLines(email) {
  const dir = email.outbound ? 'Outbound (learner)' : 'Inbound';
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

function draftLines(session) {
  const draft = session.drafts?.[0];
  if (!draft) return [];
  const lines = ['### Current draft', ''];
  if (draft.to?.length) lines.push(`**To:** ${draft.to.join(', ')}  `);
  if (draft.cc?.length) lines.push(`**Cc:** ${draft.cc.join(', ')}  `);
  if (draft.subject) lines.push(`**Subject:** ${draft.subject}  `);
  lines.push('', String(draft.body || '_(empty)_'), '');
  return lines;
}

function assistantLines(session) {
  const msgs = session.assistant_messages ?? [];
  const lines = ['### Assistant conversation (Cosmo)', ''];
  if (!msgs.length) {
    lines.push('_(no assistant messages)_', '');
    return lines;
  }
  for (const m of msgs) {
    const who = m.role === 'user' ? 'Learner' : 'Cosmo';
    lines.push(`**${who}:**`);
    if (m.role === 'user') {
      lines.push(...String(m.content || '').split('\n').map((l) => `> ${l}`));
    } else {
      lines.push('', String(m.content || ''));
    }
    lines.push('');
  }
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
  lines.push(found.submitted ? '_Explicitly submitted by the learner._' : '_Defaulted to the most recent send (no explicit submission)._', '');
  lines.push(...emailLines(found.email));
  return lines;
}

function sessionHeader(session, label) {
  return [
    `# ${label}`,
    '',
    `**Session:** ${session.session_id}  `,
    `**Scenario:** ${session.scenario_id || '(unknown)'}  `,
    `**Updated:** ${formatDate(session.updated_at || session.created_at)}  `,
    `**Recipient replies:** ${session.recipient_turns || 0} · **Submissions:** ${session.submission_count || 0}`,
    '',
  ];
}

function renderSession(session, label) {
  const lines = [...sessionHeader(session, label)];
  if (mode === 'thread') {
    lines.push(...threadLines(session));
  } else if (mode === 'assistant') {
    lines.push(...assistantLines(session));
  } else if (mode === 'submission') {
    lines.push(...submissionLines(session));
  } else {
    // full
    lines.push(...threadLines(session));
    lines.push('---', '');
    lines.push(...draftLines(session));
    lines.push('---', '');
    lines.push(...assistantLines(session));
    lines.push('---', '');
    lines.push(...submissionLines(session));
  }
  return lines;
}

// ── Emit ──────────────────────────────────────────────────────
function emit(text) {
  if (outputFile) {
    writeFileSync(outputFile, text);
    console.error(`Written to ${outputFile}`);
  } else {
    console.log(text);
  }
}

if (mode === 'report') {
  const reportSessions = [...toRender].reverse();
  const lines = [];
  lines.push(...settingsHeadingLines());
  lines.push('# CosmoMail Session Report', '');
  lines.push(`*Generated on ${formatDate(new Date().toISOString())}*  `);
  lines.push(`*${reportSessions.length} session(s)*`, '', '---', '');
  lines.push(...rubricHintLines());
  reportSessions.forEach((session, idx) => {
    lines.push(...renderSession(session, `Session ${idx + 1}`));
    if (idx < reportSessions.length - 1) lines.push('---', '');
  });
  emit(lines.join('\n'));
  process.exit(0);
}

const out = [];
out.push(...settingsHeadingLines());
toRender.forEach((session, idx) => {
  const label = latestOnly ? 'Latest session' : `Session ${idx + 1}`;
  out.push(...renderSession(session, label));
  if (idx < toRender.length - 1) out.push('', '---', '');
});
emit(out.join('\n'));
