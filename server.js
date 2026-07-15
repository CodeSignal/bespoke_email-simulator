import 'dotenv/config';
import express from 'express';
import path from 'path';
import fs from 'fs/promises';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';
import { OctavusClient, toSSEStream } from '@octavus/server-sdk';
import { filterModels } from './lib/helpers.js';
import { loadScenario } from './lib/scenario.js';
import { resolveStrings } from './lib/i18n.js';
import {
  newSessionRecord,
  readSessionsFile,
  writeSessionsFile,
  findSession,
  latestSession,
  upsertSession,
  removeSession,
  toClientSession,
} from './lib/sessions.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO_FILE = path.join(__dirname, 'scenario.json');
const SESSIONS_FILE = path.join(__dirname, 'sessions.json');
const MODELS_FILE = path.join(__dirname, 'current-models.txt');
const I18N_DIR = path.join(__dirname, 'i18n');
const app = express();
const PORT = Number.parseInt(process.env.PORT ?? '3000', 10) || 3000;

// ── Octavus client ────────────────────────────────────────────
// Fall back to sensible defaults so the server can boot for local UI work even
// before credentials are configured. Actual agent calls still require a valid
// OCTAVUS_API_KEY and a deployed agent id.
const octavus = new OctavusClient({
  baseUrl: process.env.OCTAVUS_API_URL || 'https://octavus.ai',
  apiKey: process.env.OCTAVUS_API_KEY || '',
});

// Which deployed agent the server talks to. Defaults to "prod" so existing
// deployments that only set the legacy OCTAVUS_AGENT_ID keep working. Local
// development opts into the dev agent via `npm run dev` (AGENT_TARGET=dev).
const AGENT_TARGET = (process.env.AGENT_TARGET ?? 'prod').toLowerCase();
if (AGENT_TARGET !== 'prod' && AGENT_TARGET !== 'dev') {
  throw new Error(
    `Invalid AGENT_TARGET "${process.env.AGENT_TARGET}". Expected "prod" or "dev".`,
  );
}
const AGENT_ID =
  (AGENT_TARGET === 'prod'
    ? process.env.OCTAVUS_AGENT_ID_PROD
    : process.env.OCTAVUS_AGENT_ID_DEV) ?? process.env.OCTAVUS_AGENT_ID;

// ── Middleware ────────────────────────────────────────────────
app.use(express.json({ limit: '5mb' }));
app.use('/design-system', express.static(path.join(__dirname, 'design-system')));
app.use(express.static(path.join(__dirname, 'public')));

// ── Health ────────────────────────────────────────────────────
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'cosmo-mail' });
});

// ── Scenario / config ─────────────────────────────────────────
const getScenario = () => loadScenario(SCENARIO_FILE, __dirname);

// Client-facing configuration: everything except the seed inbox (that ships via
// /api/scenario), plus resolved i18n strings for the config's language.
app.get('/api/config', async (_req, res) => {
  try {
    const { config, errors } = await getScenario();
    if (errors.length) console.warn('[scenario] validation warnings:', errors);
    const strings = await resolveStrings(config.generation.language, config.ui.strings, I18N_DIR);
    const { seed, ...clientConfig } = config;
    res.json({ ...clientConfig, strings, warnings: errors });
  } catch (err) {
    console.error('[config] Error:', err);
    res.status(500).json({ error: 'Failed to load scenario config' });
  }
});

// The brief + resolved seed threads for rendering the inbox.
app.get('/api/scenario', async (_req, res) => {
  try {
    const { config, inbox } = await getScenario();
    res.json({
      id: config.id,
      brief: config.brief,
      scenarioType: config.scenarioType,
      activeThreadId: config.seed.activeThreadId,
      focusedEmailId: config.seed.focusedEmailId,
      threads: inbox.threads,
    });
  } catch (err) {
    console.error('[scenario] Error:', err);
    res.status(500).json({ error: 'Failed to load scenario' });
  }
});

// ── Models ─────────────────────────────────────────────────────
app.get('/api/models', async (_req, res) => {
  try {
    const [raw, { config }] = await Promise.all([
      fs.readFile(MODELS_FILE, 'utf8'),
      getScenario(),
    ]);
    res.json({ models: filterModels(raw, config.allowedModels, config.allowedModelFamilies) });
  } catch {
    res.json({ models: [] });
  }
});

// ── Sessions ───────────────────────────────────────────────────
const readSessions = () => readSessionsFile(SESSIONS_FILE);
const writeSessions = (data) => writeSessionsFile(SESSIONS_FILE, data);

// Creates a session seeded with the scenario's inbox threads.
async function createSeededSession() {
  const { config, inbox } = await getScenario();
  const record = newSessionRecord(config.id, inbox.threads);
  const data = await readSessions();
  upsertSession(data, record);
  await writeSessions(data);
  return record;
}

// GET /api/session — load ?id=, resume the most recent, or create a seeded one.
app.get('/api/session', async (req, res) => {
  try {
    const data = await readSessions();

    if (req.query.id) {
      const session = findSession(data, req.query.id);
      if (!session) return res.status(404).json({ error: 'Session not found' });
      return res.json(toClientSession(session));
    }

    const latest = latestSession(data);
    if (latest) return res.json(toClientSession(latest));

    const record = await createSeededSession();
    res.json(toClientSession(record));
  } catch (err) {
    console.error('[session] Error:', err);
    res.status(500).json({ error: 'Failed to load session' });
  }
});

// POST /api/sessions — force-create a fresh seeded session.
app.post('/api/sessions', async (_req, res) => {
  try {
    const record = await createSeededSession();
    res.json(toClientSession(record));
  } catch (err) {
    console.error('[sessions] Error:', err);
    res.status(500).json({ error: 'Failed to create session' });
  }
});

// DELETE /api/sessions/:sessionId
app.delete('/api/sessions/:sessionId', async (req, res) => {
  try {
    const data = await readSessions();
    removeSession(data, req.params.sessionId);
    await writeSessions(data);
    res.json({ ok: true });
  } catch (err) {
    console.error('[sessions] Delete error:', err);
    res.status(500).json({ error: 'Failed to delete session' });
  }
});

// Shared generation-level inputs (model/temperature/thinking/language).
function buildGenerationInput(config) {
  const g = config.generation ?? {};
  const input = {};
  if (g.model) input.MODEL = g.model;
  input.LANGUAGE = typeof g.language === 'string' && g.language.trim() ? g.language.trim() : 'English';
  const thinking = g.thinking ?? 'off';
  input.THINKING = thinking;
  if (thinking === 'off' && g.temperature !== undefined) input.TEMPERATURE = g.temperature;
  return input;
}

// Session input for the assistant (copilot) role.
function buildAgentSessionInput(config) {
  const input = buildGenerationInput(config);
  input.MODE = 'assistant';
  if (config.assistant?.systemPromptExtra) input.EXTRA_INSTRUCTIONS = config.assistant.systemPromptExtra;
  return input;
}

// Session input for the recipient (in-character correspondent) role.
function buildRecipientSessionInput(config, persona) {
  const input = buildGenerationInput(config);
  input.MODE = 'recipient';
  input.PERSONA = persona?.prompt || `You are ${persona?.name || 'the recipient'}.`;
  input.PERSONA_NAME = persona?.name || 'The recipient';
  return input;
}

// Normalizes a To/Cc value (array or comma-delimited string) into an array of
// { email } address objects.
function toAddressList(value) {
  if (Array.isArray(value)) {
    return value
      .map((v) => (typeof v === 'string' ? { email: v.trim() } : v))
      .filter((v) => v && (v.email || v.name));
  }
  if (typeof value === 'string') {
    return value.split(',').map((s) => s.trim()).filter(Boolean).map((email) => ({ email }));
  }
  return [];
}

// Whether the simulated recipient may still reply given the thread behavior.
function recipientAllowed(config, record) {
  const sr = config.simulatedRecipient;
  if (!sr?.enabled) return false;
  const turns = record.recipient_turns || 0;
  switch (sr.threadBehavior) {
    case 'one_reply':
      return turns < 1;
    case 'multi_turn':
      return turns < (sr.maxTurns ?? 1);
    case 'scripted':
      return turns < (Array.isArray(sr.scriptedBeats) ? sr.scriptedBeats.length : 0);
    default:
      return false;
  }
}

// Attach to an Octavus session, execute the payload, and pipe the SSE stream.
async function streamAgent(res, octavusSessionId, payload) {
  const session = octavus.agentSessions.attach(octavusSessionId);
  const events = session.execute(payload);
  const stream = toSSEStream(events);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
  } catch (err) {
    console.error('[stream] error:', err);
  } finally {
    reader.releaseLock();
    res.end();
  }
}

// POST /api/assistant/session — lazily create (or return) the Octavus agent
// session backing a CMail session's assistant conversation.
app.post('/api/assistant/session', async (req, res) => {
  if (!AGENT_ID) return res.status(503).json({ error: 'Assistant agent is not configured' });
  const { sessionId } = req.body;
  if (!sessionId) return res.status(400).json({ error: 'sessionId is required' });
  try {
    const data = await readSessions();
    const record = findSession(data, sessionId);
    if (!record) return res.status(404).json({ error: 'Session not found' });

    if (record.octavus_session_id) {
      return res.json({ octavusSessionId: record.octavus_session_id });
    }

    const { config } = await getScenario();
    const input = buildAgentSessionInput(config);
    const octavusSessionId = await octavus.agentSessions.create(AGENT_ID, input);
    record.octavus_session_id = octavusSessionId;
    upsertSession(data, record);
    await writeSessions(data);
    res.json({ octavusSessionId });
  } catch (err) {
    console.error('[assistant/session] Error:', err);
    res.status(500).json({ error: 'Failed to create assistant session' });
  }
});

// POST /api/assistant/trigger — attach to the Octavus session and stream the
// assistant response as SSE.
app.post('/api/assistant/trigger', async (req, res) => {
  const { sessionId, ...payload } = req.body;
  if (!sessionId) return res.status(400).json({ error: 'sessionId is required' });
  await streamAgent(res, sessionId, payload);
});

// POST /api/upload-urls — proxy presigned upload URL requests to Octavus.
app.post('/api/upload-urls', async (req, res) => {
  const { sessionId, files } = req.body;
  if (!sessionId || !Array.isArray(files)) {
    return res.status(400).json({ error: 'sessionId and files[] are required' });
  }
  try {
    const result = await octavus.files.getUploadUrls(sessionId, files);
    res.json(result);
  } catch (err) {
    console.error('[upload-urls] Error:', err);
    res.status(500).json({ error: 'Failed to get upload URLs' });
  }
});

// ── Send flow & simulated recipient ────────────────────────────

// POST /api/email/send — simulate sending: append the learner's email to the
// thread (creating one for compose-new), clear the draft, and report whether a
// simulated recipient reply is allowed next.
app.post('/api/email/send', async (req, res) => {
  const { sessionId, threadId, to, cc, subject, body, attachments } = req.body;
  if (!sessionId) return res.status(400).json({ error: 'sessionId is required' });
  try {
    const data = await readSessions();
    const record = findSession(data, sessionId);
    if (!record) return res.status(404).json({ error: 'Session not found' });
    const { config } = await getScenario();

    let thread = record.threads.find((t) => t.id === threadId);
    if (!thread) {
      thread = { id: `thread-${randomUUID()}`, subject: subject || '(no subject)', emails: [] };
      record.threads.push(thread);
    }

    const email = {
      id: `email-${randomUUID()}`,
      from: {
        name: config.learner?.displayName || 'You',
        email: config.learner?.email || 'you@example.com',
      },
      to: toAddressList(to),
      cc: toAddressList(cc),
      date: new Date().toISOString(),
      subject: subject || thread.subject,
      body: body || '',
      outbound: true,
      attachments: Array.isArray(attachments) ? attachments : [],
    };
    thread.emails.push(email);
    record.drafts = [];
    upsertSession(data, record);
    await writeSessions(data);

    res.json({
      email,
      thread,
      recipient: {
        allowed: recipientAllowed(config, record),
        behavior: config.simulatedRecipient?.enabled ? config.simulatedRecipient.threadBehavior : null,
      },
    });
  } catch (err) {
    console.error('[email/send] Error:', err);
    res.status(500).json({ error: 'Failed to send email' });
  }
});

// POST /api/recipient/session — lazily create the Octavus session that role-plays
// the simulated recipient persona.
app.post('/api/recipient/session', async (req, res) => {
  if (!AGENT_ID) return res.status(503).json({ error: 'Agent is not configured' });
  const { sessionId } = req.body;
  if (!sessionId) return res.status(400).json({ error: 'sessionId is required' });
  try {
    const data = await readSessions();
    const record = findSession(data, sessionId);
    if (!record) return res.status(404).json({ error: 'Session not found' });
    const { config } = await getScenario();
    const sr = config.simulatedRecipient;
    if (!sr?.enabled) return res.status(400).json({ error: 'Simulated recipient is not enabled' });

    if (record.recipient_octavus_session_id) {
      return res.json({ recipientOctavusSessionId: record.recipient_octavus_session_id });
    }

    const persona = sr.personas?.[0] ?? {};
    const input = buildRecipientSessionInput(config, persona);
    const id = await octavus.agentSessions.create(AGENT_ID, input);
    record.recipient_octavus_session_id = id;
    upsertSession(data, record);
    await writeSessions(data);
    res.json({ recipientOctavusSessionId: id });
  } catch (err) {
    console.error('[recipient/session] Error:', err);
    res.status(500).json({ error: 'Failed to create recipient session' });
  }
});

// POST /api/recipient/trigger — stream an in-character recipient reply via SSE.
app.post('/api/recipient/trigger', async (req, res) => {
  const { sessionId, ...payload } = req.body;
  if (!sessionId) return res.status(400).json({ error: 'sessionId is required' });
  await streamAgent(res, sessionId, payload);
});

// POST /api/recipient/complete — append a finished recipient reply (LLM- or
// script-generated) to the thread as an inbound email and count the turn.
app.post('/api/recipient/complete', async (req, res) => {
  const { sessionId, threadId, reply } = req.body;
  if (!sessionId) return res.status(400).json({ error: 'sessionId is required' });
  try {
    const data = await readSessions();
    const record = findSession(data, sessionId);
    if (!record) return res.status(404).json({ error: 'Session not found' });
    const { config } = await getScenario();
    const sr = config.simulatedRecipient;
    const persona = sr?.personas?.[0] ?? {};

    const thread = record.threads.find((t) => t.id === threadId) ?? record.threads[0];
    if (!thread) return res.status(404).json({ error: 'Thread not found' });

    // Scripted behavior ignores the streamed reply and uses the author's beat.
    let bodyText = reply || '';
    if (sr?.threadBehavior === 'scripted') {
      const beat = sr.scriptedBeats?.[record.recipient_turns || 0];
      bodyText = typeof beat === 'string' ? beat : beat?.body || '';
    }

    const learner = record.threads
      .flatMap((t) => t.emails)
      .find((e) => e.outbound);

    const email = {
      id: `email-${randomUUID()}`,
      from: { name: persona.name || 'Recipient', email: persona.email || 'recipient@example.com' },
      to: [{ name: config.learner?.displayName || 'You', email: config.learner?.email || 'you@example.com' }],
      cc: [],
      date: new Date().toISOString(),
      subject: /^re:/i.test(thread.subject || '') ? thread.subject : `Re: ${thread.subject || ''}`,
      body: bodyText,
      outbound: false,
      attachments: [],
    };
    thread.emails.push(email);
    record.recipient_turns = (record.recipient_turns || 0) + 1;
    upsertSession(data, record);
    await writeSessions(data);

    res.json({ email, thread, recipient: { allowed: recipientAllowed(config, record) } });
  } catch (err) {
    console.error('[recipient/complete] Error:', err);
    res.status(500).json({ error: 'Failed to record recipient reply' });
  }
});

// ── Submission ─────────────────────────────────────────────────

// Finds the most recent outbound (learner-sent) email across all threads.
function mostRecentSend(record) {
  let latest = null;
  for (const thread of record.threads ?? []) {
    for (const email of thread.emails ?? []) {
      if (email.outbound && (!latest || (email.date || '') >= (latest.email.date || ''))) {
        latest = { email, threadId: thread.id };
      }
    }
  }
  return latest;
}

// POST /api/submission — mark the learner's final email. Defaults to the most
// recent send; enforces submission.maxSubmissions.
app.post('/api/submission', async (req, res) => {
  const { sessionId, emailId, threadId } = req.body;
  if (!sessionId) return res.status(400).json({ error: 'sessionId is required' });
  try {
    const data = await readSessions();
    const record = findSession(data, sessionId);
    if (!record) return res.status(404).json({ error: 'Session not found' });
    const { config } = await getScenario();
    const maxSubmissions = config.submission?.maxSubmissions ?? 1;

    record.submission_count = record.submission_count || 0;
    if (record.submission_count >= maxSubmissions) {
      return res.status(409).json({
        error: 'No submissions remaining',
        submissionsRemaining: 0,
        selectedSubmission: record.selected_submission,
      });
    }

    let target = null;
    if (emailId) {
      for (const thread of record.threads ?? []) {
        const email = thread.emails?.find((e) => e.id === emailId);
        if (email) { target = { email, threadId: thread.id }; break; }
      }
    } else {
      target = mostRecentSend(record);
    }
    if (!target) return res.status(400).json({ error: 'No email to submit' });

    record.selected_submission = {
      email_id: target.email.id,
      thread_id: threadId || target.threadId,
      submitted_at: new Date().toISOString(),
    };
    record.submission_count += 1;
    upsertSession(data, record);
    await writeSessions(data);

    res.json({
      selectedSubmission: record.selected_submission,
      submissionsRemaining: Math.max(0, maxSubmissions - record.submission_count),
    });
  } catch (err) {
    console.error('[submission] Error:', err);
    res.status(500).json({ error: 'Failed to record submission' });
  }
});

// POST /api/session/save — persist threads / drafts / assistant messages / submission.
app.post('/api/session/save', async (req, res) => {
  const { sessionId, threads, drafts, assistantMessages, selectedSubmission } = req.body;
  if (!sessionId) return res.status(400).json({ error: 'sessionId is required' });
  try {
    const data = await readSessions();
    const record = findSession(data, sessionId);
    if (!record) return res.status(404).json({ error: 'Session not found' });

    if (Array.isArray(threads)) record.threads = threads;
    if (Array.isArray(drafts)) record.drafts = drafts;
    if (Array.isArray(assistantMessages)) record.assistant_messages = assistantMessages;
    if (selectedSubmission !== undefined) record.selected_submission = selectedSubmission;

    upsertSession(data, record);
    await writeSessions(data);
    res.json({ ok: true });
  } catch (err) {
    console.error('[session/save] Error:', err);
    res.status(500).json({ error: 'Failed to save session' });
  }
});

// ── Boot ──────────────────────────────────────────────────────
if (process.env.NODE_ENV !== 'test') {
  const server = app.listen(PORT, () => {
    console.log(`CosmoMail running at http://localhost:${PORT}`);
    console.log(`[agent] target=${AGENT_TARGET}${AGENT_ID ? ` (agent ${AGENT_ID})` : ''}`);
    if (!AGENT_ID) {
      const expected = `OCTAVUS_AGENT_ID_${AGENT_TARGET.toUpperCase()}`;
      console.warn(`[WARN] ${expected} is not set — the assistant will not work until it is configured.`);
    }
  });
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(
        `Port ${PORT} is already in use. Stop the other server (or any app on that port), or run with a different port, e.g. PORT=3001 npm run dev`,
      );
    } else {
      console.error(err);
    }
    process.exit(1);
  });
}

export { app };
