# CosmoMail (CMail)

A lightweight, AI-powered email simulator for teaching and assessing how people
write and manage email with the help of an AI assistant. Learners read a seeded
thread, compose replies in a rich editor, and "send" messages — while an AI
copilot (Cosmo) can help draft, answer questions about the email history,
summarize, and extract information. Live scenario characters can write back
in-character so the learner practices a real email exchange.

CMail never sends real email; it simulates the experience and captures everything
for rubric-based assessment.

## How it works

- Each exercise is a single **scenario** defined in a JSON config (seeded inbox,
  task/brief, and which AI capabilities are enabled).
- All agentic work is orchestrated by **Octavus**. **Cosmo** (`cosmo-mail`) is
  the copilot. Live scenario people are a second agent (`cosmo-mail-character`),
  one Octavus session per character. Separate **dev** and **prod** profiles let
  you test configuration before going live.
- The UI uses the shared **`design-system`** submodule.
- **No database** — short-term state (threads, drafts, assistant messages) is
  stored in a local `sessions.json` file.

## Prerequisites

- Node.js 20+
- An Octavus API key and access to deploy an agent.

## Setup

Clone with the design-system submodule:

```bash
git clone --recurse-submodules <repo-url>
cd bespoke_email_simulator
# If you already cloned without submodules:
git submodule update --init
npm install
```

Configure environment variables:

```bash
cp .env.example .env
# then edit .env with your Octavus credentials and agent ids
```

| Variable | Purpose |
| --- | --- |
| `OCTAVUS_API_URL` | Octavus platform URL (default `https://octavus.ai`). |
| `OCTAVUS_API_KEY` | Your Octavus API key. |
| `AGENT_TARGET` | Which pair of agents to use: `dev` or `prod` (default `prod`). Selects runtime IDs and the target for `npm run deploy:agent`. |
| `OCTAVUS_AGENT_ID_DEV` | Cosmo (copilot) agent id used when `AGENT_TARGET=dev`. |
| `OCTAVUS_AGENT_ID_PROD` | Cosmo (copilot) agent id used when `AGENT_TARGET=prod`. |
| `OCTAVUS_CHARACTER_AGENT_ID_DEV` | Character agent id used when `AGENT_TARGET=dev`. |
| `OCTAVUS_CHARACTER_AGENT_ID_PROD` | Character agent id used when `AGENT_TARGET=prod`. |

Set up your scenario:

```bash
cp scenario.example.json scenario.json
# or start from one of the examples/ (see "Example scenarios")
```

## Running

```bash
npm run dev     # builds the client, watches; uses AGENT_TARGET from .env
npm start       # one-off build + server; uses AGENT_TARGET from .env
npm run start:prod  # force the prod pair regardless of .env
```

The app serves on port `3000` by default (override with `PORT`).

## Agent deployment (dev vs prod)

Two agent definitions live under `agents/` and are the **single source of truth**:

- `agents/cosmo-mail/` — Cosmo, the email copilot
- `agents/cosmo-mail-character/` — in-character correspondents

Each definition is deployed to two Octavus agents, distinguished by slug:

| Agent     | Target | Slug                       | Used by                               |
| --------- | ------ | -------------------------- | ------------------------------------- |
| copilot   | dev    | `cosmo-mail-dev`           | local development / testing (default) |
| copilot   | prod   | `cosmo-mail`               | real users                            |
| character | dev    | `cosmo-mail-character-dev` | local development / testing (default) |
| character | prod   | `cosmo-mail-character`     | real users                            |

There are **two independent switches**:

1. **Deploy** — which agents the CLI writes your edited files to. The Octavus CLI
   targets an agent by the `slug` in `settings.json`, so `scripts/deploy-agent.mjs`
   stages a copy of each definition and rewrites only the slug/name for the chosen
   target (prompts and `protocol.yaml` are never duplicated, so dev and prod cannot
   drift):

   ```bash
   npm run deploy:agent                 # both agents, target from AGENT_TARGET in .env
   npm run deploy:agent:dev             # both agents → *-dev slugs
   npm run deploy:agent:prod            # both agents → prod slugs (asks for confirmation)
   npm run deploy:character-agent:dev   # character agent only → cosmo-mail-character-dev
   npm run deploy:character-agent:prod  # character agent only → cosmo-mail-character
   npm run validate:agent               # dry-run validation only
   ```

   `deploy:agent:prod` requires confirmation: answer the interactive prompt, or
   pass `--yes` for CI (`node scripts/deploy-agent.mjs prod --yes`).

2. **Runtime** — which deployed pair the running server talks to, selected by
   `AGENT_TARGET` in `.env` (defaults to `prod`):

   ```bash
   npm run dev          # watch mode; talks to whatever AGENT_TARGET is in .env
   npm start            # same, without watch
   npm run start:prod   # force the prod pair regardless of .env
   ```

   The server reads `OCTAVUS_AGENT_ID_DEV` / `OCTAVUS_CHARACTER_AGENT_ID_DEV` or
   the `*_PROD` pair based on `AGENT_TARGET`. Find the IDs with
   `npx octavus --env .env list`.

   **Backward compatibility:** the default is `prod`, and when a target-specific
   ID is missing the server falls back to the legacy `OCTAVUS_AGENT_ID` /
   `OCTAVUS_CHARACTER_AGENT_ID`. An existing `.env` that only defines those
   keeps working unchanged.

Typical workflow: set `AGENT_TARGET=dev` in `.env`, edit `agents/cosmo-mail/*`
and/or `agents/cosmo-mail-character/*`, run `npm run deploy:agent`, and test
with `npm run dev`. Flip `AGENT_TARGET` to `prod` and deploy again once you're
happy. Copy new ids into the matching `OCTAVUS_AGENT_ID_*` and
`OCTAVUS_CHARACTER_AGENT_ID_*` variables in `.env`.

## Scenario authoring

A scenario config drives one exercise. Only fields you want to override need to
be present — everything else falls back to sane defaults (see
`lib/scenario.js`). Put the seed inbox inline as `{ "threads": [...] }`. For a
large mailbox, `seed.inbox` may instead be a string path to a JSON file of that
shape, relative to the project root.

| Field | Type | Notes |
| --- | --- | --- |
| `id` | string | **Required.** Unique scenario id. |
| `title` | string | App title. |
| `brief` | string | The exercise task/prompt. Presented by the host harness; CosmoMail no longer renders it in-app. |
| `primarySkill` | `writing` \| `prompting` \| `both` | What the exercise assesses. |
| `scenarioType` | `compose_new` \| `reply` \| `reply_chain` | Drives composer prefill. |
| `learner` | `{ displayName, email, avatar }` | Who the learner is in the thread. Optional `avatar` is `0`–`12`; **`0` is the empty face and the default for You**. |
| `characters` | object[] | People the learner may put on To / Cc. `{ id, name, email }` required; optional `avatar` (`0`–`12`). Optional `persona` (free-form object or string) and/or `prompt` make the character **live** — they reply via `cosmo-mail-character`. Live characters reply as ordinary people (busy, self-interested, incomplete) unless the persona explicitly says they coach, mentor, or manage the learner's development. `responds: true/false` overrides live vs directory-only. Directory-only people (no persona, `responds` omitted) can be emailed but never write back. |
| `world` | string \| `{ summary }` | Shared in-world facts every live character already knows. Cosmo does **not** see this. |
| `seed.inbox` | object \| string | Inline `{ threads }` by default. Optionally a path to a JSON file of the same shape for large inboxes. Threads may set `"mailbox": "spam"` to land in Spam; otherwise they start in Inbox. Sent is filled automatically when the learner sends. |
| `seed.activeThreadId` | string | Which mailbox to open on load (the folder that contains this thread). |
| `seed.focusedEmailId` | string | Email the reply targets. |
| `initialDraft` | `{ to, cc, subject, body }` | Optional composer prefill. |
| `assistant.enabled` | boolean | When `false`, hide the Cosmo copilot panel. |
| `assistant.capabilities` | string[] | `compose`, `qa_search`, `summarize`, `extract`. |
| `assistant.systemPromptExtra` | string | Trusted extra instructions for the copilot. |
| `assistant.initialMessage` | string | Cosmo's opening message. |
| `assistant.allowCustomInstructions` | boolean | Let learners add their own instructions. |
| `generation` | `{ model, temperature, thinking, language }` | LLM settings. |
| `attachments` | `{ enabled, allowedTypes }` | Outbound attachment support. |
| `ui` | `{ hideHistory, strings }` | UI overrides + i18n strings. |
| `rubricHints` | object \| string | Notes surfaced in the extraction report. |

### Example scenarios

Ready-to-run scenarios live in [`scenario-examples/`](scenario-examples/). Copy
one to `scenario.json` to try it:

- **`01-compose-new-outreach`** — write a cold outreach email from scratch
  (no seed inbox, copilot only).
- **`02-reply-vendor-negotiation`** — reply within a seeded vendor negotiation
  thread (copilot + attachments; Dana is directory-only, so she will not write back).
- **`03-qa-summarize-status`** — use Cosmo to interrogate a project thread and
  write a leadership-ready summary (Q&A / search / extract focus).
- **`04-simulated-recipient-support`** — a customer-support thread where Marcus
  replies in-character until the issue is resolved.
- **`05-scripted-recipient-scheduling`** — schedule an interview; Jordan replies
  in-character. Morgan is in the directory but does not write back unless you
  give her a persona.
- **`06-software-sales-prospecting`** — align with a sales manager on one CRM
  lead, then email that prospect and book a meeting (Alex plus five live
  prospects; Ryan is the right call).

```bash
cp scenario-examples/04-simulated-recipient-support.scenario.json scenario.json && npm run dev
```

See [`scenario-examples/README.md`](scenario-examples/README.md) for details.

## Internationalization

Base UI strings live in `i18n/` (e.g. `i18n/en.json`). A scenario picks a
language via `generation.language`, and per-scenario overrides can be supplied in
`ui.strings`.

## Extraction & reporting

Turn captured sessions (`sessions.json`) into readable Markdown for a human
grader or an AI tutor:

```bash
npm run report                                      # writes report.md, threads grouped (oldest first)
npm run report:chronological                        # writes report.md, one merged timeline instead
npm run extract                                     # full transcript to stdout, newest first
node extract-conversations.js --mode submission     # only the final (most recent) sent email
node extract-conversations.js --mode thread         # the email thread(s)
node extract-conversations.js --mode assistant      # the Cosmo conversation
node extract-conversations.js --mode report --stdout # preview the report without writing a file
```

`npm run report` is the one to hand to a grader. With `--print-settings` (the
default for `npm run report`), it opens with a plain-language **World** blurb
and a **Characters** list (name, role, email, and whether they're a live
correspondent or directory-only) — no model config, IDs, or rubric hints,
just enough context to follow the conversation. It then walks each session
(numbering them only if there's more than one — in practice there's just the
one) and renders the email(s) and the current draft, plus — only when the
scenario's `assistant.enabled` is `true` — a summary and full transcript of
the participant's conversation with the Cosmo assistant. When the assistant
is disabled for a scenario, the report says so plainly instead of showing an
empty section. If `sessions.json` doesn't exist yet (the participant never
opened the scenario), the report still generates cleanly and says so.

The emails can be ordered two ways with `--order` (applies to `full`,
`thread`, and `report`):

- `thread` (default) — grouped by conversation thread, each thread's emails
  in send order. Good for reading one exchange start-to-finish.
- `chronological` — every thread merged into a single timeline by send time,
  each email tagged with which thread it belongs to. Good for seeing how the
  participant moved between conversations (e.g. emailing a prospect mid-way
  through a still-open exchange with their manager).

Options: `--latest` (most recent session only), `--order <thread|chronological>`,
`--output <file>` (override the destination; `report.md` is the default for
`--mode report`), `--stdout` (print instead of writing a file),
`--print-settings` (include the World/Characters summary), `--help`.

## Testing

```bash
npm test         # vitest run (unit + API route tests)
npm run test:watch
npm run pack     # client + server bundles → dist/ and dist.tar.gz
```

CI (`.github/workflows/ci.yml`) runs build + tests on push/PR.
`.github/workflows/release.yml` tests, then `npm run pack`: a minified client
bundle, a single-file server bundle (Express + Octavus inlined — no
`node_modules`), a single-file `extract-conversations.js` (for the `report` /
`extract` scripts, with `lib/character-replies.js` inlined the same way), and
the static files the server serves. Extract `dist.tar.gz` and run
`node server.js`. Supply `scenario.json` and `.env` at runtime; use
`npm run report` (or `node extract-conversations.js ...` directly) against
the `sessions.json` it produces.

## Project layout

```
agents/cosmo-mail/              Cosmo copilot (protocol, prompts, settings)
agents/cosmo-mail-character/    In-character correspondents
design-system/         Shared UI submodule
scenario-examples/     Ready-to-run example scenarios
i18n/                  Locale catalogs
lib/                   Pure logic (scenario, sessions, i18n, helpers)
public/                Client app (index.html, app.js, app.css)
scripts/               Agent deploy + release pack tooling
tests/                 vitest unit + supertest API tests
server.js              Express server + API routes
extract-conversations.js  Transcript/report generator
```

## Reference docs

- [`PRD.md`](PRD.md) — product requirements and design.
- [`build-plan.md`](build-plan.md) — staged implementation plan.
- [`similar-project-details.md`](similar-project-details.md) — notes on the
  ChatCPT reference project whose setup CMail clones.

## License

Elastic License 2.0 — see [`LICENSE.md`](LICENSE.md).
