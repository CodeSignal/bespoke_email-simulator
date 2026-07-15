# CosmoMail (CMail) — Staged Build Plan

A staged, incremental plan to build CosmoMail. Each stage builds on the previous
ones and ends with a **verification step**, a **git commit**, and a **push to
origin**. Check items off as they are completed.

Guiding docs: [`PRD.md`](PRD.md) and
[`similar-project-details.md`](similar-project-details.md) (the ChatCPT reference
whose setup we clone).

## Conventions & ground rules
- Single Express server on **port 3000**; Node.js 18+ (CI on 20); ESM (`type: module`).
- All agentic work goes through **Octavus** (`@octavus/server-sdk`,
  `@octavus/client-sdk`, `@octavus/cli`); one agent, two behaviors (assistant +
  recipient), deployed to **`cosmo-mail`** (prod) / **`cosmo-mail-dev`** (dev).
- Frontend is **vanilla JS bundled by esbuild**; composer uses **TipTap**
  (`@tiptap/core`, `@tiptap/pm`, `@tiptap/starter-kit`, `@tiptap/markdown`);
  received/assistant Markdown rendered with `marked` + `highlight.js`.
- **Markdown is the source of truth** for all email bodies (config, storage,
  extraction). TipTap is only the editing surface.
- No database — short-term state in a gitignored JSON file.
- **Never commit credentials.** Secrets live only in `.env` (gitignored);
  `.env.example` is the committed reference.
- Runtime/generated files are gitignored: `node_modules`, `.env`,
  `public/app.bundle.js`, `public/hljs-*.css`, `sessions.json`, `scenario.json`,
  `.agent-build`.
- Origin remote: `https://github.com/CodeSignal/bespoke_email-simulator.git` (already configured).

## How to work this plan
- Do stages in order; do not start a stage until the previous one is verified.
- At the end of each stage: run the **Verify** checks, then **commit** with the
  suggested message, then **push** to origin.
- Keep each stage's diff focused so commits stay reviewable.

---

## Stage 0 — Project scaffolding & tooling

**Goal:** A runnable, empty project skeleton with dependencies, build tooling, the
design-system submodule, and env/config templates.

- [x] Update `.gitignore` for CMail's runtime files (`sessions.json`,
      `scenario.json`) — replace ChatCPT's `chat-sessions.json` / `chat-config.json`.
- [x] Create `package.json` (ESM, `type: module`) with scripts: `build`,
      `build:watch`, `start`, `start:prod`, `dev`, `validate:agent`,
      `deploy:agent:dev`, `deploy:agent:prod`, `test`, `test:watch`.
- [x] Add dependencies: `@octavus/server-sdk`, `@octavus/client-sdk`, `express`,
      `dotenv`, `marked`, `marked-highlight`, `highlight.js`, `@tiptap/core`,
      `@tiptap/pm`, `@tiptap/starter-kit`, `@tiptap/markdown`.
- [x] Add devDependencies: `@octavus/cli`, `esbuild`, `concurrently`,
      `cross-env`, `vitest`, `supertest`.
- [x] Add the `design-system` git submodule
      (`https://github.com/CodeSignal/learn_bespoke-design-system.git`) and commit `.gitmodules`.
- [x] Create directory skeleton: `public/`, `public/Images/`, `lib/`, `i18n/`,
      `agents/cosmo-mail/prompts/`, `scripts/`, `fixtures/`, `tests/`.
- [x] Add `.env.example` (OCTAVUS_API_URL, OCTAVUS_API_KEY, AGENT_TARGET,
      OCTAVUS_AGENT_ID_DEV, OCTAVUS_AGENT_ID_PROD, optional legacy
      OCTAVUS_AGENT_ID, optional PORT).
- [x] `npm install` and confirm a clean lockfile.

**Verify**
- [x] `npm install` succeeds; `node --version` ≥ 18.
- [x] `git submodule status` shows `design-system` checked out.
- [x] `.env.example` present; `.env` is gitignored.

**Commit & push**
- [x] Commit: `chore: scaffold project, tooling, and design-system submodule`
- [x] Push to origin.

---

## Stage 1 — Static server & app shell

**Goal:** Express server on port 3000 serving a static HTML shell styled by the
design system. No AI or email logic yet.

- [x] Create `server.js`: Express app, `PORT` from env (default 3000),
      static hosting for `public/` and `/design-system`, `NODE_ENV=test` guard
      around `app.listen`, and an `EADDRINUSE` message. Export `app`.
- [x] Create `public/index.html` shell: link design-system foundations
      (colors, spacing, typography) + core components (button, boxes, icons,
      input, modal, dropdown) and `app.css`; load `/app.bundle.js` as a module.
- [x] Create `public/app.css` and a minimal `public/app.js` entry (bundled by esbuild).
- [x] Lay out the three surfaces from the PRD as static placeholders: thread rail,
      reading pane, composer area, assistant panel.

**Verify**
- [x] `npm run dev` starts; visiting `http://localhost:3000` renders the shell
      with design-system styling and no console errors. *(Verified on :3001 — an
      external ChatCPT instance already occupies :3000.)*
- [x] `public/app.bundle.js` is generated (and gitignored).

**Commit & push**
- [x] Commit: `feat: static express server and app shell on port 3000`
- [x] Push to origin.

---

## Stage 2 — Scenario config & fixtures loading

**Goal:** Load a scenario config + seed data (inline or fixture file) and expose
it to the client. No email rendering yet.

- [x] Define the scenario schema per PRD §6 and create
      `scenario.example.json` (committed template) + a working `scenario.json`
      (gitignored) for local dev.
- [x] Add `fixtures/` sample inbox/thread file(s) matching PRD §6.2.
- [x] `lib/config.js` (or extend `lib/helpers.js`): read scenario config, resolve
      `seed.inbox` inline-or-from-file, and validate required fields.
      *(Implemented as `lib/scenario.js` + `lib/helpers.js`.)*
- [x] `lib/i18n.js`: locale catalog loader + string resolution
      (config `strings` override → i18n catalog → English), reusing ChatCPT's approach.
- [x] `i18n/en.json` seed catalog.
- [x] Routes: `GET /api/config` (config + resolved strings) and
      `GET /api/scenario` (resolved brief + seed threads).
- [x] `GET /api/models` backed by a `current-models.txt` list, filtered by config.

**Verify**
- [x] `curl localhost:3000/api/config` and `/api/scenario` return the expected
      JSON for both inline and fixture-file seed modes.
- [x] Unit test: config loader resolves inline vs. fixture seeds correctly.

**Commit & push**
- [x] Commit: `feat: scenario config loader, fixtures, and config/scenario APIs`
- [x] Push to origin.

---

## Stage 3 — Email data model, session persistence & reading UI

**Goal:** Seed a session from the scenario, persist it to a JSON file, and render
the thread(s) read-only in the UI.

- [x] Define the session record shape per PRD §7.5 (`threads`, `drafts`,
      `assistant_messages`, `selected_submission`, timestamps, `scenario_id`).
- [x] `lib/sessions.js`: JSON file read/write helpers (`sessions.json`) and
      session create/resume that seeds the scenario inbox into the record.
- [x] Routes: `GET /api/session` (create/resume, seeds inbox),
      `POST /api/sessions`, `DELETE /api/sessions/:id`, `POST /api/session/save`.
- [x] Client: fetch scenario + session, render the thread rail and the reading
      pane (each email: from/to/cc/subject/date + Markdown body via `marked` +
      `highlight.js`), open the `activeThread`/`focusedEmail` by default.

**Verify**
- [x] Loading the app shows the seeded thread rendered correctly.
- [x] `sessions.json` is created/updated and is gitignored.
- [x] Unit tests: session seed + save/read round-trip.

**Commit & push**
- [x] Commit: `feat: session persistence and read-only thread rendering`
- [x] Push to origin.

---

## Stage 4 — TipTap composer & drafts

**Goal:** Compose/reply in a TipTap editor with Markdown as the source of truth,
and persist drafts.

- [x] Integrate TipTap (`@tiptap/core` + `@tiptap/pm` + `@tiptap/starter-kit` +
      `@tiptap/markdown`) into `public/app.js`, bundled by esbuild.
- [x] Composer UI: To / Cc / Subject fields + TipTap body; load `initialDraft`
      with `contentType: 'markdown'`; serialize with `editor.getMarkdown()`.
- [x] Wire reply vs. compose-new flows based on `scenarioType`
      (`compose_new` / `reply` / `reply_chain`), prefilling recipients/subject.
- [x] Autosave/save drafts to the session (`POST /api/session/save`) as Markdown.

**Verify**
- [x] Editing in TipTap and reloading restores the draft as Markdown.
- [x] Reply prefills To/Subject from the focused email; compose-new starts blank.
- [x] Round-trip check: Markdown → TipTap → `getMarkdown()` is stable.

**Commit & push**
- [x] Commit: `feat: TipTap composer with Markdown drafts`
- [x] Push to origin.

---

## Stage 5 — Octavus agent definition & dev/prod deployment

**Goal:** Define the Cosmo Mail agent (assistant behavior first) and the dev/prod
deploy tooling. No client wiring yet.

- [ ] `agents/cosmo-mail/settings.json` (slug `cosmo-mail`, name, description,
      `format: interactive`).
- [ ] `agents/cosmo-mail/protocol.yaml`: session inputs (MODEL, TEMPERATURE,
      THINKING, LANGUAGE, EXTRA_INSTRUCTIONS, VERBOSITY_INSTRUCTIONS) + scenario
      context inputs (SCENARIO_BRIEF, INBOX/THREAD, CURRENT_DRAFT); the
      `assistant-message` trigger (USER_MESSAGE, CUSTOM_INSTRUCTIONS, FILES);
      agent block; handlers.
- [ ] `agents/cosmo-mail/prompts/system-assistant.md` (email copilot persona,
      context usage, capabilities, guardrails, instruction-priority ordering).
- [ ] `agents/cosmo-mail/prompts/assistant-message.md` (user-turn template).
- [ ] `scripts/deploy-agent.mjs`: stage a copy, rewrite only slug/name for the
      target (`cosmo-mail` / `cosmo-mail-dev`), run `octavus validate` + `sync`;
      prod requires confirmation (`--yes` for CI).
- [ ] Server: `OctavusClient` init + `AGENT_TARGET` selection
      (`OCTAVUS_AGENT_ID_DEV`/`_PROD`, legacy fallback) per ChatCPT.

**Verify**
- [ ] `npm run validate:agent` passes.
- [ ] `npm run deploy:agent:dev` syncs to `cosmo-mail-dev` (requires real `.env`).
- [ ] Server boot logs the resolved `AGENT_TARGET` and agent id.

**Commit & push**
- [ ] Commit: `feat: cosmo-mail agent definition and dev/prod deploy tooling`
- [ ] Push to origin.

---

## Stage 6 — AI assistant panel (compose, Q&A, summarize, extract)

**Goal:** A working streaming assistant that has full scenario context and can
help with the confirmed v1 capabilities.

- [ ] Route `POST /api/assistant/trigger`: attach to the Octavus session and
      stream via SSE (`toSSEStream`), injecting inbox/thread/current-draft context.
- [ ] Client: assistant panel using `@octavus/client-sdk` (`OctavusChat` +
      `createHttpTransport` → `/api/assistant/trigger`) with streaming render.
- [ ] Support capabilities gated by `assistant.capabilities`: compose/draft,
      Q&A + search over history, summarize, extract action items.
- [ ] "Insert into composer" action for assistant-drafted emails (explicit,
      learner-controlled — see PRD §13).
- [ ] Persist assistant turns to `assistant_messages`; honor `systemPromptExtra`
      and optional learner custom instructions (delivered in the user turn).

**Verify**
- [ ] Ask the assistant to summarize the seeded thread → correct summary streams in.
- [ ] Ask a Q&A question about the thread → grounded answer.
- [ ] Ask it to draft a reply → "insert" populates the TipTap composer as Markdown.
- [ ] Assistant transcript persists across reload.

**Commit & push**
- [ ] Commit: `feat: streaming AI assistant with scenario context and capabilities`
- [ ] Push to origin.

---

## Stage 7 — Send flow & simulated recipient

**Goal:** Simulate sending, append to the thread, and optionally get an
in-character recipient reply.

- [ ] Route `POST /api/email/send`: append the learner's email (Markdown) to the
      thread, clear the composer server-side state, persist.
- [ ] Extend the agent with a `recipient-reply` trigger + handler and
      `agents/cosmo-mail/prompts/system-recipient.md` (in-persona, goal-directed,
      guardrail-bound).
- [ ] Route `POST /api/recipient/trigger`: generate a recipient reply via SSE
      using the persona + thread + behavior metadata.
- [ ] Implement `threadBehavior`: `one_reply`, `multi_turn` (respect `maxTurns`),
      `scripted` (author beats); only active when `simulatedRecipient.enabled`.
- [ ] Client: send button simulates send (no real email), appends learner email,
      streams recipient reply into the thread when enabled.
- [ ] Re-deploy the updated agent (`deploy:agent:dev`).

**Verify**
- [ ] With recipient disabled: send appends the email, no reply is generated.
- [ ] With recipient enabled: send triggers an in-character reply; `multi_turn`
      respects `maxTurns`; personas behave per their prompt.
- [ ] Thread state (sends + replies) persists across reload.

**Commit & push**
- [ ] Commit: `feat: send flow and optional simulated recipient replies`
- [ ] Push to origin.

---

## Stage 8 — Submission model

**Goal:** Let the learner mark a final email/draft as their submission.

- [ ] Route `POST /api/submission`: set `selected_submission` (default = most
      recent send); enforce `submission.maxSubmissions`.
- [ ] Client: submission control with the configured `submission.label`; visual
      indication of the selected submission.

**Verify**
- [ ] Marking a submission persists and is reflected on reload.
- [ ] Default submission is the most recent send when none is chosen.

**Commit & push**
- [ ] Commit: `feat: final submission selection`
- [ ] Push to origin.

---

## Stage 9 — Attachments

**Goal:** Support attachments on outbound emails (on by default), reusing
Octavus presigned uploads.

- [ ] Route `POST /api/upload-urls` proxying `octavus.files.getUploadUrls`.
- [ ] Composer: attach image/file buttons + preview; gate by
      `attachments.enabled` / `allowedTypes`.
- [ ] Include attachments in the sent email record and pass to the agent (FILES).

**Verify**
- [ ] Attaching a file yields a working upload; the sent email shows the attachment.
- [ ] Disallowed types are rejected; disabling attachments hides the controls.

**Commit & push**
- [ ] Commit: `feat: outbound email attachments via Octavus uploads`
- [ ] Push to origin.

---

## Stage 10 — Extraction & reporting scripts

**Goal:** Produce readable, Markdown transcripts for the tutor/assessment rubric.

- [ ] `extract-conversations.js` reading `sessions.json`, with modes:
      `full`, `submission`, `thread`, `assistant`, `report`; options `--latest`,
      `--output <file>`, `--print-settings`, `--help`.
- [ ] Output email bodies as Markdown; include `rubricHints` in the report header.

**Verify**
- [ ] Each mode prints/writes correct, readable output for a sample session.
- [ ] `report` mode writes a well-formed Markdown file.

**Commit & push**
- [ ] Commit: `feat: extraction and reporting scripts`
- [ ] Push to origin.

---

## Stage 11 — Tests & CI

**Goal:** Automated tests for pure logic and API routes, plus a release workflow.

- [ ] `tests/` with `vitest` + `supertest`: config/i18n helpers, session
      seed/save, scenario resolution, send/submission routes (import `app` via the
      `NODE_ENV=test` guard). Keep pure logic in `lib/` for unit testing.
- [ ] `.github/workflows/release.yml`: init submodule, `npm ci`, `npm run build`,
      archive dist (excluding `.git`, `.github`, `.env`, `sessions.json`,
      `public/app.js`), attach to the GitHub release.

**Verify**
- [ ] `npm test` passes locally.
- [ ] CI workflow succeeds on a test release/tag (or via `act`/manual review).

**Commit & push**
- [ ] Commit: `test: unit/API tests and release CI workflow`
- [ ] Push to origin.

---

## Stage 12 — Docs, examples & polish

**Goal:** Finalize authoring docs and developer experience.

- [ ] Expand `README.md`: setup (clone with submodules), env, `dev`/`start`,
      agent deploy (dev/prod), scenario authoring, extraction usage.
- [ ] Document the scenario schema and provide 2–3 example scenarios
      (compose-new, reply-chain, simulated-recipient) under `fixtures/`/examples.
- [ ] Accessibility & empty/error states pass; final UI polish.
- [ ] Confirm `.env.example`, `scenario.example.json`, and i18n are current.

**Verify**
- [ ] A new developer can follow the README from clone → running app.
- [ ] All example scenarios load and run end-to-end.

**Commit & push**
- [ ] Commit: `docs: authoring guide, example scenarios, and polish`
- [ ] Push to origin.

---

## Post-v1 backlog (from PRD §12, not scheduled)
- [ ] Inbox triage/prioritization scenarios.
- [ ] `search-emails` retrieval tool/skill for large inboxes.
- [ ] Multi-scenario picker in one deployment.
- [ ] Richer email-client features (folders, labels, search UI).
- [ ] Inline coaching hints / real-time scoring.
- [ ] Attachment-aware analysis scenarios.
