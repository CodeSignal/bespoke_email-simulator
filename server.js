import 'dotenv/config';
import express from 'express';
import path from 'path';
import fs from 'fs/promises';
import { watch as watchFiles } from 'fs';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';
import { OctavusClient, toSSEStream } from '@octavus/server-sdk';
import { filterModels } from './lib/helpers.js';
import { loadScenario } from './lib/scenario.js';
import { toCharacterAddress, resolveRecipientEmails } from './lib/characters.js';
import {
  selectResponders,
  compileCharacterCard,
  parseCharacterReply,
  buildCharacterReplyHeaders,
} from './lib/character-replies.js';
import { buildCapabilityInstructions } from './lib/assistant.js';
import { removeScopedDraft } from './lib/drafts.js';
import {
  appendSessionEvents,
  makeDraftProposedEvent,
  makeQuickActionEvent,
  newDraftId,
  normalizeDraftFields,
  PROPOSE_DRAFT_TOOL,
} from './lib/provenance.js';
import {
  QUICK_ACTION_MODEL,
  QUICK_ACTION_SOURCE,
  QUICK_ACTION_TOOLS,
  actionInstruction,
  isValidQuickAction,
  normalizeHeaderSuggestion,
  normalizeSuggestedReplies,
  normalizeTriageRanking,
  resolveQuickActionChips,
} from './lib/quick-actions.js';
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

// propose-draft / quick-action tools are passthrough: Cosmo emits structured
// fields; the host app renders them. Returning the fields lets the model finish.
function buildAssistantTools(capture = null) {
  return {
    [PROPOSE_DRAFT_TOOL]: async (args = {}) => {
      const draft = normalizeDraftFields(args);
      if (capture) capture.draft = draft;
      return { ok: true, ...draft, to: draft.to.join(', '), cc: draft.cc.join(', ') };
    },
    [QUICK_ACTION_TOOLS.PROPOSE_SUGGESTED_REPLIES]: async (args = {}) => {
      const replies = normalizeSuggestedReplies(args);
      if (capture) capture.replies = replies;
      return { ok: true, replies };
    },
    [QUICK_ACTION_TOOLS.PROPOSE_HEADERS]: async (args = {}) => {
      const headers = normalizeHeaderSuggestion(args);
      if (capture) capture.headers = headers;
      return {
        ok: true,
        ...headers,
        to: headers.to.join(', '),
        cc: headers.cc.join(', '),
      };
    },
    [QUICK_ACTION_TOOLS.PROPOSE_TRIAGE]: async (args = {}) => {
      const ranking = normalizeTriageRanking(args);
      if (capture) capture.ranking = ranking;
      return { ok: true, ranking };
    },
  };
}

const ASSISTANT_TOOLS = buildAssistantTools();

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

// Dev-only live reload (`npm run dev` sets LIVE_RELOAD=1): the page listens on
// /__livereload and swaps stylesheets on CSS edits, reloads on anything else.
if (process.env.LIVE_RELOAD === '1') {
  const clients = new Set();
  let timer = null;
  let pending = new Set();
  const notify = (file) => {
    pending.add(file);
    clearTimeout(timer);
    timer = setTimeout(() => {
      const kind = [...pending].every((f) => f.endsWith('.css')) ? 'css' : 'reload';
      pending = new Set();
      for (const res of clients) res.write(`data: ${kind}\n\n`);
    }, 120);
  };
  for (const dir of ['public', 'design-system']) {
    try {
      watchFiles(path.join(__dirname, dir), { recursive: true }, (_event, file) => {
        if (file && /\.(css|html|js|svg|png)$/.test(file)) notify(String(file));
      });
    } catch (err) {
      console.warn(`[live-reload] cannot watch ${dir}:`, err.message);
    }
  }
  app.get('/__livereload', (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.flushHeaders();
    res.write(': connected\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
  });
  console.log('[live-reload] watching public/ and design-system/');
} else {
  // Outside `npm run dev`, answer the page's probe quietly (204 ends the
  // EventSource without a console 404).
  app.get('/__livereload', (_req, res) => res.status(204).end());
}
app.use(express.static(path.join(__dirname, 'public')));
// Rive runtime WASM for the AI Assistant thinking animation (thinking.riv).
app.get('/vendor/rive.wasm', (_req, res) => {
  res.type('application/wasm').sendFile(path.join(__dirname, 'node_modules/@rive-app/canvas/rive.wasm'));
});

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
    const { seed, rubricHints: _rubricHints, rubric: _rubric, ...clientConfig } = config;
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

/** Serialize all sessions.json read-modify-write cycles (incl. autosave). */
let sessionsWriteChain = Promise.resolve();

function withSessionsWrite(work) {
  const run = sessionsWriteChain.then(
    () => work(),
    () => work(),
  );
  // Keep the queue moving even when a write fails.
  sessionsWriteChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * Read a session, apply updater, upsert, and persist — under the write queue.
 * Returns the fresh record, or null if missing.
 */
async function updateSessionById(sessionId, updater) {
  return withSessionsWrite(async () => {
    const data = await readSessions();
    const record = findSession(data, sessionId);
    if (!record) return null;
    await updater(record, data);
    upsertSession(data, record);
    await writeSessions(data);
    return record;
  });
}

// Creates a session seeded with the scenario's inbox threads.
async function createSeededSession() {
  const { config, inbox } = await getScenario();
  const record = newSessionRecord(config.id, inbox.threads);
  await withSessionsWrite(async () => {
    const data = await readSessions();
    upsertSession(data, record);
    await writeSessions(data);
  });
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
    await withSessionsWrite(async () => {
      const data = await readSessions();
      removeSession(data, req.params.sessionId);
      await writeSessions(data);
    });
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
  // Always forward an authored/normalized temperature (including candidate
  // defaults) so it is not dropped when thinking is enabled.
  if (g.temperature !== undefined) input.TEMPERATURE = g.temperature;
  return input;
}

// Session input for the assistant (copilot) role.
function buildAgentSessionInput(config) {
  const input = buildGenerationInput(config);
  if (config.assistant?.systemPromptExtra) input.EXTRA_INSTRUCTIONS = config.assistant.systemPromptExtra;
  input.CAPABILITIES = buildCapabilityInstructions(config.assistant?.capabilities);
  input.LEARNER_NAME = config.learner?.displayName || 'You';
  input.LEARNER_EMAIL = config.learner?.email || 'you@example.com';
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
async function streamAgent(res, octavusSessionId, payload, { tools } = {}) {
  const session = octavus.agentSessions.attach(
    octavusSessionId,
    tools ? { tools } : undefined,
  );
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
    const existing = findSession(await readSessions(), sessionId);
    if (!existing) return res.status(404).json({ error: 'Session not found' });
    if (existing.octavus_session_id) {
      return res.json({ octavusSessionId: existing.octavus_session_id });
    }

    // Create outside the write lock, then persist on the latest record.
    const { config } = await getScenario();
    const input = buildAgentSessionInput(config);
    const octavusSessionId = await octavus.agentSessions.create(AGENT_ID, input);

    const record = await updateSessionById(sessionId, (fresh) => {
      if (!fresh.octavus_session_id) fresh.octavus_session_id = octavusSessionId;
    });
    if (!record) return res.status(404).json({ error: 'Session not found' });
    res.json({ octavusSessionId: record.octavus_session_id });
  } catch (err) {
    console.error('[assistant/session] Error:', err);
    res.status(500).json({ error: 'Failed to create assistant session' });
  }
});

// POST /api/assistant/clear — wipe the persisted assistant transcript and
// start a fresh Octavus session so Cosmo has no memory of the old chat.
// Works even when the agent is not configured (octavusSessionId is null).
app.post('/api/assistant/clear', async (req, res) => {
  const { sessionId } = req.body;
  if (!sessionId) return res.status(400).json({ error: 'sessionId is required' });
  try {
    const existing = findSession(await readSessions(), sessionId);
    if (!existing) return res.status(404).json({ error: 'Session not found' });

    let octavusSessionId = null;
    if (AGENT_ID) {
      const { config } = await getScenario();
      const input = buildAgentSessionInput(config);
      octavusSessionId = await octavus.agentSessions.create(AGENT_ID, input);
    }

    const record = await updateSessionById(sessionId, (fresh) => {
      fresh.assistant_messages = [];
      fresh.octavus_session_id = octavusSessionId;
    });
    if (!record) return res.status(404).json({ error: 'Session not found' });
    res.json({ ok: true, octavusSessionId: record.octavus_session_id });
  } catch (err) {
    console.error('[assistant/clear] Error:', err);
    res.status(500).json({ error: 'Failed to clear assistant conversation' });
  }
});

// POST /api/assistant/trigger — attach to the Octavus session and stream the
// assistant response as SSE.
app.post('/api/assistant/trigger', async (req, res) => {
  const { sessionId, ...payload } = req.body;
  if (!sessionId) return res.status(400).json({ error: 'sessionId is required' });
  try {
    const { config } = await getScenario();
    // Candidates must not supply custom instructions, even if the client tries.
    if (config.audience === 'candidate') delete payload.CUSTOM_INSTRUCTIONS;
  } catch (err) {
    console.error('[assistant/trigger] Error:', err);
    return res.status(500).json({ error: 'Failed to load scenario config' });
  }
  await streamAgent(res, sessionId, payload, { tools: ASSISTANT_TOOLS });
});

/**
 * Run a one-shot quick-action on a fresh Octavus session (no chat history),
 * capture tool results, append a quick_action provenance event, and return JSON.
 */
async function runQuickAction({
  config,
  record,
  action,
  detail = '',
  threadContext = '',
  focusedEmail = '',
  currentDraft = '',
  threadId = null,
}) {
  const capture = { draft: null, replies: null, headers: null, ranking: null };
  const input = buildAgentSessionInput(config);
  // Prefer a cheaper/faster model for chip actions unless the scenario pins one.
  if (config.generation?.model === undefined) input.MODEL = QUICK_ACTION_MODEL;
  if (config.generation?.temperature === undefined) input.TEMPERATURE = 0.3;

  const ephemeralId = await octavus.agentSessions.create(AGENT_ID, input);
  try {
    const session = octavus.agentSessions.attach(ephemeralId, {
      tools: buildAssistantTools(capture),
    });
    // Server SDK uses execute() with the same trigger payload the client sends.
    const events = session.execute({
      type: 'trigger',
      triggerName: 'quick-action',
      input: {
        ACTION_INSTRUCTION: actionInstruction(action, detail),
        THREAD_CONTEXT: threadContext || '(no mailbox context)',
        FOCUSED_EMAIL: focusedEmail || '',
        CURRENT_DRAFT: currentDraft || '(empty)',
      },
    });
    for await (const _event of events) {
      // Drain the stream so tool handlers run to completion.
    }
  } finally {
    try {
      await octavus.agentSessions.clear(ephemeralId);
    } catch (err) {
      console.warn('[assistant/quick-action] clear failed:', err?.message || err);
    }
  }

  const draftId = capture.draft || capture.headers ? newDraftId() : null;
  const resultEvents = [];
  if (capture.draft) {
    resultEvents.push(
      makeDraftProposedEvent({
        draftId,
        source: QUICK_ACTION_SOURCE,
        draft: capture.draft,
      }),
    );
  }
  resultEvents.push(
    makeQuickActionEvent({
      action,
      source: QUICK_ACTION_SOURCE,
      draftId,
      draft: capture.draft,
      replies: capture.replies,
      headers: capture.headers,
      ranking: capture.ranking,
      detail: detail || null,
      threadId,
    }),
  );

  record.events = appendSessionEvents(record.events, resultEvents);

  return {
    action,
    draftId,
    draft: capture.draft,
    replies: capture.replies,
    headers: capture.headers,
    ranking: capture.ranking,
    events: resultEvents,
  };
}

// POST /api/assistant/quick-action — chip actions (no chat transcript pollution).
app.post('/api/assistant/quick-action', async (req, res) => {
  if (!AGENT_ID) return res.status(503).json({ error: 'Assistant agent is not configured' });
  const {
    sessionId,
    action,
    detail,
    threadContext,
    focusedEmail,
    currentDraft,
    threadId,
  } = req.body || {};
  if (!sessionId) return res.status(400).json({ error: 'sessionId is required' });
  if (!isValidQuickAction(action)) {
    return res.status(400).json({ error: 'action is required and must be a known quick action' });
  }
  try {
    const { config } = await getScenario();
    if (config.assistant?.enabled === false) {
      return res.status(403).json({ error: 'Assistant is disabled for this scenario' });
    }
    const chips = resolveQuickActionChips({
      capabilities: config.assistant?.capabilities,
      quickActions: config.assistant?.quickActions,
    });
    if (!chips.some((chip) => chip.id === action)) {
      return res.status(403).json({ error: `Quick action "${action}" is not enabled` });
    }

    const existing = findSession(await readSessions(), sessionId);
    if (!existing) return res.status(404).json({ error: 'Session not found' });

    // Scratch only — do not mutate the on-disk record during the long Octavus call.
    const scratch = {
      ...existing,
      events: Array.isArray(existing.events) ? [...existing.events] : [],
    };
    const result = await runQuickAction({
      config,
      record: scratch,
      action,
      detail,
      threadContext,
      focusedEmail,
      currentDraft,
      threadId: threadId || null,
    });

    const fresh = await updateSessionById(sessionId, (record) => {
      record.events = appendSessionEvents(record.events, result.events);
    });
    if (!fresh) return res.status(404).json({ error: 'Session not found' });
    res.json({ ok: true, ...result, sessionEvents: fresh.events });
  } catch (err) {
    console.error('[assistant/quick-action] Error:', err);
    res.status(500).json({ error: 'Failed to run quick action' });
  }
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
  const { sessionId, threadId, draftId, to, cc, subject, body, attachments } = req.body;
  if (!sessionId) return res.status(400).json({ error: 'sessionId is required' });
  try {
    const { config } = await getScenario();
    const characters = config.characters ?? [];
    // Keep addresses from reply autofill even when the sender is not in the
    // character directory (seed distractors). Picker-only adds stay directory-bound.
    const toList = resolveRecipientEmails(to, characters);
    const ccList = resolveRecipientEmails(cc, characters).filter(
      (email) => !toList.some((value) => value.toLowerCase() === email.toLowerCase()),
    );
    if (toList.length === 0) {
      return res.status(400).json({ error: 'to is required' });
    }

    let email;
    let thread;
    const record = await updateSessionById(sessionId, (fresh) => {
      thread = fresh.threads.find((t) => t.id === threadId);
      if (!thread) {
        thread = { id: `thread-${randomUUID()}`, subject: subject || '(no subject)', emails: [] };
        fresh.threads.push(thread);
      }

      email = {
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
      // Drop only the draft that was sent; keep other scoped drafts.
      fresh.drafts = removeScopedDraft(
        fresh.drafts,
        threadId ? { scope: 'reply', threadId } : { scope: 'new', id: draftId },
      );
    });
    if (!record) return res.status(404).json({ error: 'Session not found' });

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
    const existing = findSession(await readSessions(), sessionId);
    if (!existing) return res.status(404).json({ error: 'Session not found' });
    const { config } = await getScenario();
    const character = (config.characters || []).find((entry) => entry.id === characterId);
    if (!character) return res.status(404).json({ error: 'Character not found' });

    const prior = existing.character_sessions?.[characterId];
    if (prior) {
      return res.json({ characterOctavusSessionId: prior });
    }

    const id = await octavus.agentSessions.create(
      CHARACTER_AGENT_ID,
      buildCharacterSessionInput(config, character),
    );

    const record = await updateSessionById(sessionId, (fresh) => {
      fresh.character_sessions = fresh.character_sessions || {};
      if (!fresh.character_sessions[characterId]) {
        fresh.character_sessions[characterId] = id;
      }
    });
    if (!record) return res.status(404).json({ error: 'Session not found' });
    res.json({ characterOctavusSessionId: record.character_sessions[characterId] });
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
    const { config } = await getScenario();
    const characters = config.characters ?? [];
    const character = characters.find((entry) => entry.id === characterId);
    if (!character) return res.status(404).json({ error: 'Character not found' });

    let email;
    let thread;
    let done;
    const record = await updateSessionById(sessionId, (fresh) => {
      thread = fresh.threads.find((t) => t.id === threadId) ?? fresh.threads[0];
      if (!thread) {
        const err = new Error('Thread not found');
        err.status = 404;
        throw err;
      }

      const sent =
        thread.emails.find((entry) => entry.id === inReplyToId) ??
        [...thread.emails].reverse().find((entry) => entry.outbound);
      const parsed = parseCharacterReply(reply);
      done = parsed.done;
      const learnerEmail = config.learner?.email || 'you@example.com';
      const headers = buildCharacterReplyHeaders(sent, character, {
        learnerEmail,
        subjectFallback: thread.subject,
      });

      email = {
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
        body: parsed.body,
        outbound: false,
        attachments: [],
      };
      thread.emails.push(email);
      fresh.character_done = fresh.character_done || {};
      if (done) fresh.character_done[characterId] = true;
    });
    if (!record) return res.status(404).json({ error: 'Session not found' });

    res.json({ email, thread, done });
  } catch (err) {
    if (err?.status === 404) return res.status(404).json({ error: err.message });
    console.error('[character/complete] Error:', err);
    res.status(500).json({ error: 'Failed to record character reply' });
  }
});

// POST /api/session/save — persist threads / drafts / assistant messages / events.
app.post('/api/session/save', async (req, res) => {
  const { sessionId, threads, drafts, assistantMessages, events, readEmailIds } = req.body;
  if (!sessionId) return res.status(400).json({ error: 'sessionId is required' });
  try {
    const record = await updateSessionById(sessionId, (fresh) => {
      if (Array.isArray(threads)) fresh.threads = threads;
      if (Array.isArray(drafts)) fresh.drafts = drafts;
      if (Array.isArray(assistantMessages)) fresh.assistant_messages = assistantMessages;
      if (Array.isArray(events)) fresh.events = appendSessionEvents(fresh.events, events);
      // Read state only grows (opening mail never un-reads it), so merge.
      if (Array.isArray(readEmailIds)) {
        const ids = new Set(fresh.read_email_ids ?? []);
        for (const id of readEmailIds) if (typeof id === 'string' && id) ids.add(id);
        fresh.read_email_ids = [...ids];
      }
    });
    if (!record) return res.status(404).json({ error: 'Session not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[session/save] Error:', err);
    res.status(500).json({ error: 'Failed to save session' });
  }
});

// POST /api/session/events — append AI provenance events (draft_proposed, etc.).
app.post('/api/session/events', async (req, res) => {
  const { sessionId, events } = req.body;
  if (!sessionId) return res.status(400).json({ error: 'sessionId is required' });
  if (!Array.isArray(events) || events.length === 0) {
    return res.status(400).json({ error: 'events[] is required' });
  }
  try {
    const record = await updateSessionById(sessionId, (fresh) => {
      fresh.events = appendSessionEvents(fresh.events, events);
    });
    if (!record) return res.status(404).json({ error: 'Session not found' });
    res.json({ ok: true, events: record.events });
  } catch (err) {
    console.error('[session/events] Error:', err);
    res.status(500).json({ error: 'Failed to append session events' });
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
