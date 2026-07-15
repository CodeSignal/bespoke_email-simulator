import 'dotenv/config';
import express from 'express';
import path from 'path';
import fs from 'fs/promises';
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

// Builds the session-level input for a new Octavus agent session from the
// scenario's generation settings and the trusted course-author extra prompt.
function buildAgentSessionInput(config) {
  const g = config.generation ?? {};
  const input = {};
  if (g.model) input.MODEL = g.model;
  const language = typeof g.language === 'string' && g.language.trim() ? g.language.trim() : 'English';
  input.LANGUAGE = language;
  const thinking = g.thinking ?? 'off';
  input.THINKING = thinking;
  if (thinking === 'off' && g.temperature !== undefined) input.TEMPERATURE = g.temperature;
  if (config.assistant?.systemPromptExtra) input.EXTRA_INSTRUCTIONS = config.assistant.systemPromptExtra;
  return input;
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

  const session = octavus.agentSessions.attach(sessionId);
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
    console.error('[assistant/trigger] Stream error:', err);
  } finally {
    reader.releaseLock();
    res.end();
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
