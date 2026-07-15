import 'dotenv/config';
import express from 'express';
import path from 'path';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';
import { filterModels } from './lib/helpers.js';
import { loadScenario } from './lib/scenario.js';
import { resolveStrings } from './lib/i18n.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO_FILE = path.join(__dirname, 'scenario.json');
const MODELS_FILE = path.join(__dirname, 'current-models.txt');
const I18N_DIR = path.join(__dirname, 'i18n');
const app = express();
const PORT = Number.parseInt(process.env.PORT ?? '3000', 10) || 3000;

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

// ── Boot ──────────────────────────────────────────────────────
if (process.env.NODE_ENV !== 'test') {
  const server = app.listen(PORT, () => {
    console.log(`CosmoMail running at http://localhost:${PORT}`);
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
