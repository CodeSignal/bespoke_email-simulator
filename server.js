import 'dotenv/config';
import express from 'express';
import path from 'path';
import fs from 'fs/promises';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';
import { OctavusClient, toSSEStream } from '@octavus/server-sdk';
import { filterModels } from './lib/helpers.js';
import { loadScenario } from './lib/scenario.js';
import { constrainToCharacters, toCharacterAddress } from './lib/characters.js';
import {
  selectResponders,
  compileCharacterCard,
  parseCharacterReply,
  buildCharacterReplyHeaders,
} from './lib/character-replies.js';
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
const SCENARIO_FILE = process.env.SCENARIO_FILE || path.join(__dirname, 'scenario.json');
const SESSIONS_FILE = process.env.SESSIONS_FILE || path.join(__dirname, 'sessions.json');
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

// Which deployed pair the server talks to, from AGENT_TARGET in .env.
// Defaults to "prod" so existing deployments that only set the legacy
// OCTAVUS_AGENT_ID keep working.
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
const CHARACTER_AGENT_ID =
  (AGENT_TARGET === 'prod'
    ? process.env.OCTAVUS_CHARACTER_AGENT_ID_PROD
    : process.env.OCTAVUS_CHARACTER_AGENT_ID_DEV) ?? process.env.OCTAVUS_CHARACTER_AGENT_ID;

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
  if (config.assistant?.systemPromptExtra) input.EXTRA_INSTRUCTIONS = config.assistant.systemPromptExtra;
  return input;
}

function buildCharacterSessionInput(config, character) {
  const input = buildGenerationInput(config);
  input.CHARACTER_NAME = character?.name || '';
  input.CHARACTER_EMAIL = character?.email || '';
  input.CHARACTER_ROLE = character?.role || '';
  input.CHARACTER_CARD = compileCharacterCard(character);
  if (config.world) input.WORLD = config.world;
  input.LEARNER_NAME = config.learner?.displayName || 'You';
  return input;
}

function doneCharacterIds(record) {
  return Object.entries(record.character_done || {})
    .filter(([, done]) => done)
    .map(([id]) => id);
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

// ── Send flow & character replies ─────────────────────────────

function publicResponder(character) {
  return { id: character.id, name: character.name, email: character.email, avatar: character.avatar ?? null };
}

// POST /api/email/send — simulate sending: append the learner's email to the
// thread (creating one for compose-new), clear the draft, and list who will
// write back.
app.post('/api/email/send', async (req, res) => {
  const { sessionId, threadId, to, cc, subject, body, attachments } = req.body;
  if (!sessionId) return res.status(400).json({ error: 'sessionId is required' });
  try {
    const data = await readSessions();
    const record = findSession(data, sessionId);
    if (!record) return res.status(404).json({ error: 'Session not found' });
    const { config } = await getScenario();
    const characters = config.characters ?? [];
    const toList = constrainToCharacters(to, characters);
    const ccList = constrainToCharacters(cc, characters).filter(
      (email) => !toList.some((value) => value.toLowerCase() === email.toLowerCase()),
    );
    if (characters.length && toList.length === 0) {
      return res.status(400).json({ error: 'to must include a scenario character' });
    }

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
      to: toList.map((addr) => toCharacterAddress(addr, characters)),
      cc: ccList.map((addr) => toCharacterAddress(addr, characters)),
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

    const responders = selectResponders(email, characters, { doneIds: doneCharacterIds(record) }).map(
      publicResponder,
    );
    res.json({ email, thread, responders });
  } catch (err) {
    console.error('[email/send] Error:', err);
    res.status(500).json({ error: 'Failed to send email' });
  }
});

// POST /api/character/session — lazily create (or return) the Octavus session
// that role-plays one scenario character.
app.post('/api/character/session', async (req, res) => {
  if (!CHARACTER_AGENT_ID) return res.status(503).json({ error: 'Character agent is not configured' });
  const { sessionId, characterId } = req.body;
  if (!sessionId || !characterId) {
    return res.status(400).json({ error: 'sessionId and characterId are required' });
  }
  try {
    const data = await readSessions();
    const record = findSession(data, sessionId);
    if (!record) return res.status(404).json({ error: 'Session not found' });
    const { config } = await getScenario();
    const character = (config.characters || []).find((entry) => entry.id === characterId);
    if (!character) return res.status(404).json({ error: 'Character not found' });

    record.character_sessions = record.character_sessions || {};
    if (record.character_sessions[characterId]) {
      return res.json({ characterOctavusSessionId: record.character_sessions[characterId] });
    }

    const id = await octavus.agentSessions.create(
      CHARACTER_AGENT_ID,
      buildCharacterSessionInput(config, character),
    );
    record.character_sessions[characterId] = id;
    upsertSession(data, record);
    await writeSessions(data);
    res.json({ characterOctavusSessionId: id });
  } catch (err) {
    console.error('[character/session] Error:', err);
    res.status(500).json({ error: 'Failed to create character session' });
  }
});

// POST /api/character/trigger — stream an in-character reply via SSE.
app.post('/api/character/trigger', async (req, res) => {
  const { sessionId, ...payload } = req.body;
  if (!sessionId) return res.status(400).json({ error: 'sessionId is required' });
  await streamAgent(res, sessionId, payload);
});

// POST /api/character/complete — append a finished character reply as inbound
// mail (reply-all) and record whether that character is done.
app.post('/api/character/complete', async (req, res) => {
  const { sessionId, threadId, characterId, reply, inReplyToId } = req.body;
  if (!sessionId || !characterId) {
    return res.status(400).json({ error: 'sessionId and characterId are required' });
  }
  try {
    const data = await readSessions();
    const record = findSession(data, sessionId);
    if (!record) return res.status(404).json({ error: 'Session not found' });
    const { config } = await getScenario();
    const characters = config.characters ?? [];
    const character = characters.find((entry) => entry.id === characterId);
    if (!character) return res.status(404).json({ error: 'Character not found' });

    const thread = record.threads.find((t) => t.id === threadId) ?? record.threads[0];
    if (!thread) return res.status(404).json({ error: 'Thread not found' });

    const sent =
      thread.emails.find((entry) => entry.id === inReplyToId) ??
      [...thread.emails].reverse().find((entry) => entry.outbound);
    const { body, done } = parseCharacterReply(reply);
    const learnerEmail = config.learner?.email || 'you@example.com';
    const headers = buildCharacterReplyHeaders(sent, character, {
      learnerEmail,
      subjectFallback: thread.subject,
    });

    const email = {
      id: `email-${randomUUID()}`,
      from: { name: character.name, email: character.email },
      to: headers.to.map((addr) =>
        addr.toLowerCase() === learnerEmail.toLowerCase()
          ? { name: config.learner?.displayName || 'You', email: learnerEmail }
          : toCharacterAddress(addr, characters),
      ),
      cc: headers.cc.map((addr) => toCharacterAddress(addr, characters)),
      date: new Date().toISOString(),
      subject: headers.subject,
      body,
      outbound: false,
      attachments: [],
    };
    thread.emails.push(email);
    record.character_done = record.character_done || {};
    if (done) record.character_done[characterId] = true;
    upsertSession(data, record);
    await writeSessions(data);

    res.json({ email, thread, done });
  } catch (err) {
    console.error('[character/complete] Error:', err);
    res.status(500).json({ error: 'Failed to record character reply' });
  }
});

// POST /api/session/save — persist threads / drafts / assistant messages.
app.post('/api/session/save', async (req, res) => {
  const { sessionId, threads, drafts, assistantMessages } = req.body;
  if (!sessionId) return res.status(400).json({ error: 'sessionId is required' });
  try {
    const data = await readSessions();
    const record = findSession(data, sessionId);
    if (!record) return res.status(404).json({ error: 'Session not found' });

    if (Array.isArray(threads)) record.threads = threads;
    if (Array.isArray(drafts)) record.drafts = drafts;
    if (Array.isArray(assistantMessages)) record.assistant_messages = assistantMessages;

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
    console.log(`[agent] target=${AGENT_TARGET}${AGENT_ID ? ` (cosmo-mail ${AGENT_ID})` : ''}`);
    console.log(
      `[agent] character${CHARACTER_AGENT_ID ? ` ${CHARACTER_AGENT_ID}` : ' (not configured)'}`,
    );
    if (!AGENT_ID) {
      const expected = `OCTAVUS_AGENT_ID_${AGENT_TARGET.toUpperCase()}`;
      console.warn(`[WARN] ${expected} is not set — the assistant will not work until it is configured.`);
    }
    if (!CHARACTER_AGENT_ID) {
      const expected = `OCTAVUS_CHARACTER_AGENT_ID_${AGENT_TARGET.toUpperCase()}`;
      console.warn(`[WARN] ${expected} is not set — live character replies will not work until it is configured.`);
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
