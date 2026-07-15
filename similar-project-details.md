# Similar Project Details — `learn_cosmo-chat` (ChatCPT)

Reference notes for building our new simulator by cloning the setup of an existing
CodeSignal project. Source repo: <https://github.com/CodeSignal/learn_cosmo-chat>
(inspected at `main`, release `v0.5.0`).

## What it is

**ChatCPT (Cosmo Prompt Tutor)** is a lightweight clone of ChatGPT used to teach
and assess how people use chat-AI tools (prompt engineering). Learners write
prompts, iterate on responses, and can mark a "best attempt" as their submission.
The whole thing is deliberately small: a single Express server, a vanilla-JS
frontend, no database, and all agent/LLM work delegated to the **Octavus SDK**.

Primary purpose: drop a familiar chat UI into a course exercise, capture the full
transcript, and feed it to an external AI tutor / assessment rubric.

## High-level architecture

```
Browser (vanilla JS + design-system CSS)
   │  @octavus/client-sdk (HTTP/SSE transport) → /api/*
   ▼
server.js (Express, port 3000) — thin proxy + JSON persistence
   │  @octavus/server-sdk (OctavusClient)
   ▼
Octavus platform (agent orchestration, model exec, tools) → LLM
```

- **Frontend**: Vanilla JS / HTML / CSS, no framework. Source is `public/app.js`
  (~1800 lines), bundled by **esbuild** into `public/app.bundle.js` (gitignored,
  do not edit directly). Talks to the backend through `@octavus/client-sdk`'s
  `OctavusChat` + `createHttpTransport`, pointing at local `/api/*` routes.
- **Backend**: `server.js` — a single Express app. It is a thin layer: serves
  static assets, reads/writes the JSON session file, resolves config/i18n, and
  proxies chat execution to Octavus as a Server-Sent Events (SSE) stream.
- **Orchestration**: All agentic work (system prompt, model exec, tools like web
  search / URL crawl / image generation, session context) lives in **Octavus**,
  configured declaratively under `agents/cosmo-tutor/`.

## Key noteworthy points (per the brief)

### 1. Everything runs in a simple server on port 3000
- `server.js` is the whole backend. `PORT` env var overrides, defaults to `3000`.
- App available at <http://localhost:3000>.
- `NODE_ENV=test` skips `app.listen` so the Express app can be imported by tests.
- Helpful `EADDRINUSE` message tells you to free the port or use `PORT=3001`.

### 2. Uses the Octavus SDK for all agentic work
- Dependencies: `@octavus/server-sdk` and `@octavus/client-sdk` (both `^3.2.0`),
  plus `@octavus/cli` as a dev dependency.
- Server side: `new OctavusClient({ baseUrl: OCTAVUS_API_URL, apiKey: OCTAVUS_API_KEY })`.
  - `octavus.agentSessions.create(AGENT_ID, input)` — create a session.
  - `octavus.agentSessions.attach(sessionId).execute(payload)` — run a turn.
  - `octavus.files.getUploadUrls(sessionId, files)` — presigned S3 upload URLs.
  - `toSSEStream(events)` converts the event stream to SSE for the browser.
- Client side: `OctavusChat` + `createHttpTransport` posts turns to `/api/trigger`
  and consumes the SSE stream for real-time token streaming.
- Agent definition (declarative, single source of truth) lives in
  `agents/cosmo-tutor/`:
  - `settings.json` — `slug`, `name`, `description`, `format: "interactive"`.
  - `protocol.yaml` — session-level `input` params (MODEL, TEMPERATURE, THINKING,
    EXTRA_INSTRUCTIONS, VERBOSITY_INSTRUCTIONS, LANGUAGE), a `user-message`
    trigger (USER_MESSAGE, CUSTOM_INSTRUCTIONS, FILES), the `agent` block
    (model, system prompt, temperature, thinking, `webSearch: true`,
    `agentic: true`, `imageModel: openai/gpt-image-1`, `crawl-urls` skill), and
    `handlers` that add the user message then produce the next message.
  - `prompts/system.md` — Cosmo's persona, guidelines, guardrails, formatting
    rules, language-switching protocol, and a strict **instruction-priority
    ordering** (guardrails > trusted `EXTRA_INSTRUCTIONS` > user custom
    instructions). Uses `{{VERBOSITY_INSTRUCTIONS}}`, `{{LANGUAGE}}`,
    `{{EXTRA_INSTRUCTIONS}}` template tokens.
  - `prompts/user-message.md` — wraps the learner's message with
    `{{CUSTOM_INSTRUCTIONS}}`, `{{USER_MESSAGE}}`, `{{FILES}}`. Crucially, learner
    "custom instructions" are delivered in the **user turn**, never the system
    prompt, so they stay subordinate to guardrails.

### 3. Two profiles: dev and prod
There are **two independent switches** so you can test Octavus config in dev and
only promote to prod when going live:

- **Deploy switch** — which Octavus agent your edited files sync to.
  `scripts/deploy-agent.mjs <dev|prod>` stages a copy of `agents/cosmo-tutor/`
  into `.agent-build/<slug>/` and rewrites **only** the identity fields
  (`slug`, `name`) so dev and prod share the same prompts/protocol and can't
  drift. Targets: `prod` → slug `cosmo-tutor`; `dev` → slug `cosmo-tutor-dev`.
  - `npm run deploy:agent:dev` — syncs to `cosmo-tutor-dev`.
  - `npm run deploy:agent:prod` — syncs to `cosmo-tutor`, requires typing
    `deploy` interactively (or `--yes` in CI; refuses on non-TTY without it).
  - `npm run validate:agent` — dry-run validation only.
  - Each deploy runs `octavus validate` then `octavus sync` via `npx octavus --env .env`.
- **Runtime switch** — which deployed agent the running server talks to, chosen by
  `AGENT_TARGET` (`dev` | `prod`, defaults to `prod`).
  - `npm run dev` sets `AGENT_TARGET=dev`; `npm start` / `npm run start:prod` use prod.
  - Server picks `OCTAVUS_AGENT_ID_DEV` or `OCTAVUS_AGENT_ID_PROD` accordingly,
    falling back to legacy `OCTAVUS_AGENT_ID` for backward compatibility.
  - Invalid `AGENT_TARGET` throws at startup; missing agent ID logs a warning.

Typical workflow: edit `agents/cosmo-tutor/*` → `deploy:agent:dev` → test locally
(dev is default in `npm run dev`) → `deploy:agent:prod` once happy.

### 4. Client uses the shared `design-system` sub-repo
- Git submodule at `design-system/` →
  <https://github.com/CodeSignal/learn_bespoke-design-system.git> (see `.gitmodules`).
- Server mounts it statically: `app.use('/design-system', express.static(...))`.
- `public/index.html` links DS foundations (colors, spacing, typography) and
  components (button, boxes, icons, input, tags, dropdown, modal, numeric-slider).
- `public/app.js` imports DS JS components: `dropdown.js`, `modal.js`,
  `numeric-slider.js`.
- Clone with `git clone --recurse-submodules`; otherwise
  `git submodule update --init --recursive`. CI populates it before building.

### 5. No database — short-term state in a JSON file
- Sessions persist to `chat-sessions.json` at project root (gitignored, local only).
- Shape: `{ sessions: [ { session_id, created_at, updated_at, messages[], selected_submission } ] }`
  where each message is `{ role, content, files[], timestamp }`.
- Simple file helpers (`readJsonFile` / `writeJsonFile` in `lib/helpers.js`)
  read/write the whole file; no locking, no DB.
- REST-ish routes: `GET /api/session[?id=]`, `GET /api/sessions`,
  `POST /api/sessions`, `DELETE /api/sessions/:id`, `POST /api/session/fork`
  (regenerate / edit-and-resend), `POST /api/session/save`, `POST /api/upload-urls`,
  `POST /api/trigger` (SSE), plus `GET /api/config`, `GET /api/models`,
  `POST /api/config/custom-instructions`.
- `selected_submission` field supports the "mark this attempt as my final
  submission" concept from the PRD (default = most recent).

### 6. Extraction scripts for readable history
- `extract-conversations.js` reads `chat-sessions.json` and prints
  human-readable transcripts, newest first. Used to integrate with the AI tutor
  and assessment rubrics.
- Modes: `--mode full` (default; interleaved user + assistant), `--mode user-only`
  (only the learner's prompts), `--mode report` (markdown report, oldest first).
- Options: `--latest` (most recent conversation only), `--output <file>` (write to
  file), `--print-settings` (include current `chat-config.json` settings in the
  heading), `--help`.

## Configuration model

Two config layers, both important for authoring exercises:

- **`.env`** (secrets, gitignored; `.env.example` is the committed reference):
  `OCTAVUS_API_URL`, `OCTAVUS_API_KEY`, `AGENT_TARGET`, `OCTAVUS_AGENT_ID_DEV`,
  `OCTAVUS_AGENT_ID_PROD`, optional legacy `OCTAVUS_AGENT_ID`, optional `PORT`.
  (Rule of thumb for our project: never commit credentials.)
- **`chat-config.json`** (committed; `chat-config.example.json` is the template):
  runtime behavior + UI authoring. Notable keys: `initialPrompt`, `model`,
  `allowedModels`, `allowedModelFamilies`, `modelDisplayNames`, `temperature`,
  `systemPromptExtra` (trusted, → `EXTRA_INSTRUCTIONS`), `allowCustomInstructions`
  + `customInstructions` (learner-editable, delivered in user turn), `verbosity`
  (`concise|normal|detailed|verbose`), `language`, and a large set of UI
  overrides: `title`, `heading`, `placeholder`, `newChatLabel`, `strings`,
  `footer`, `hideSettings`, `hideModelSettings`, `hideHistory`, `hideFileUpload`,
  `hidePromptControls`.
- **Models**: `current-models.txt` is the master list (provider/model-id, `#`
  comments allowed); filtered by `allowedModels` / `allowedModelFamilies`.
- **i18n**: `i18n/*.json` locale catalogs (`{ languageNames[], strings{} }`)
  selected by the `language` config value. Resolution order per string:
  config `strings` override → matched i18n catalog → original English text.
  Setting `language` drives both the UI language and the language Cosmo responds in.

## Project layout (reference)

```
learn_cosmo-chat/
├── agents/cosmo-tutor/        # Octavus agent definition (source of truth)
│   ├── settings.json          # slug/name/description/format
│   ├── protocol.yaml          # inputs, triggers, agent block, handlers
│   └── prompts/{system.md, user-message.md}
├── design-system/             # git submodule (shared Bespoke DS)
├── i18n/{en.json, es.json}    # UI locale catalogs
├── lib/
│   ├── helpers.js             # config/session/model/i18n pure helpers
│   └── stream-registry.js     # pure streaming-concurrency decision logic
├── public/
│   ├── index.html
│   ├── app.js                 # frontend source (esbuild input)
│   ├── app.bundle.js          # generated, gitignored
│   ├── app.css
│   └── Images/*.svg,*.png
├── scripts/deploy-agent.mjs   # dev/prod agent deploy (stage + rewrite identity)
├── tests/                     # vitest: helpers, server (supertest), stream-registry
├── .cursor/commands/          # ~30 slash-command prompt templates
├── .github/workflows/release.yml  # build bundle + attach tarball on GitHub release
├── server.js                  # Express server + Octavus proxy (port 3000)
├── chat-config.json           # runtime config (gitignored; .example committed)
├── chat-sessions.json         # session store (gitignored, auto-generated)
├── current-models.txt         # master model list
├── extract-conversations.js   # readable transcript / report generator
├── package.json               # scripts + deps
├── MVP-prd.md / README.md     # product + setup docs
└── .env.example               # committed env reference (.env is gitignored)
```

## Tooling & workflow

- **Package manager / runtime**: Node.js 18+ (CI uses Node 20), `type: module` (ESM).
- **Scripts**: `build` (esbuild bundle), `build:watch`, `start` (build + node),
  `start:prod` (`cross-env AGENT_TARGET=prod`), `dev` (concurrently: bundle watch +
  `node --watch server.js` with `AGENT_TARGET=dev`), `validate:agent`,
  `deploy:agent:dev|prod`, `test` (`vitest run`), `test:watch`.
- **Testing**: `vitest` + `supertest`. `tests/server.test.js` imports the Express
  `app` (thanks to the `NODE_ENV=test` guard) and exercises routes;
  `helpers.test.js` and `stream-registry.test.js` cover the pure helper modules.
  Pattern: keep pure logic in `lib/` so it's unit-testable without DOM/SDK.
- **Markdown/UI**: `marked` + `marked-highlight` + `highlight.js` (20+ languages)
  for rendering streamed assistant markdown with syntax-highlighted code blocks.
- **CI**: `.github/workflows/release.yml` runs on GitHub release creation —
  inits the submodule, `npm ci`, `npm run build`, tars the dist (excluding
  `.git`, `.github`, `.env`, `chat-sessions.json`, `public/app.js`) and attaches
  it to the release.
- **License**: Elastic License 2.0.

## Patterns worth reusing for the new simulator

- Thin Express server on port 3000 that proxies all AI work to Octavus via SSE.
- Declarative Octavus agent definition as the single source of truth, deployed to
  two slugs (dev/prod) via a staging script that only rewrites identity fields.
- Two-switch dev/prod model: separate **deploy target** and **runtime target**.
- No DB — a single JSON file for short-term session state, with small pure
  read/write helpers.
- Rich, committed `chat-config.json` for course authors (behavior + UI + i18n),
  with secrets confined to a gitignored `.env` (never commit credentials).
- Shared `design-system` git submodule served statically and imported by the client.
- Extraction/report scripts that turn the JSON session store into readable
  transcripts for tutoring and rubric-based assessment.
- Keep untrusted learner instructions in the user turn, below trusted
  course-author config and hard guardrails.
