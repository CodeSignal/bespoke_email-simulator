# CosmoMail (CMail)

A lightweight, AI-powered email simulator for teaching and assessing how people
write and manage email with the help of an AI assistant. Learners read a seeded
thread, compose replies in a rich editor, and "send" messages — while an AI
copilot (Cosmo) can help draft, answer questions about the email history,
summarize, and extract information. Scenarios can optionally simulate a recipient
who replies in-character for realistic, back-and-forth email threads.

CMail never sends real email; it simulates the experience and captures everything
for rubric-based assessment.

## How it works

- Each exercise is a single **scenario** defined in a JSON config (seeded inbox,
  task/brief, and which AI capabilities are enabled).
- All agentic work is orchestrated by the **Octavus** platform via a single agent
  (`cosmo-mail`) that switches roles — copilot vs. in-character recipient — using
  a `MODE` session input. Separate **dev** and **prod** agent profiles let you
  test configuration before going live.
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
| `AGENT_TARGET` | Which deployed agent the server talks to: `dev` or `prod` (default `prod`). |
| `OCTAVUS_AGENT_ID_DEV` | Agent id used when `AGENT_TARGET=dev`. |
| `OCTAVUS_AGENT_ID_PROD` | Agent id used when `AGENT_TARGET=prod`. |

Set up your scenario:

```bash
cp scenario.example.json scenario.json
# or start from one of the examples/ (see "Example scenarios")
```

## Running

```bash
npm run dev     # builds the client, watches, runs against the DEV agent
npm start       # one-off build + server against the default (prod) agent
npm run start:prod
```

The app serves on port `3000` by default (override with `PORT`).

## Deploying the Octavus agent

The agent definition lives in `agents/cosmo-mail/`. Deploy to each target:

```bash
npm run validate:agent     # validate the agent definition
npm run deploy:agent:dev   # create/update the cosmo-mail-dev agent
npm run deploy:agent:prod  # create/update the cosmo-mail (prod) agent
```

The deploy script stages the agent, rewrites `slug`/`name` for the target, then
runs `octavus validate` + `octavus sync`. Copy the resulting agent id into the
matching `OCTAVUS_AGENT_ID_*` variable in `.env`.

## Scenario authoring

A scenario config drives one exercise. Only fields you want to override need to
be present — everything else falls back to sane defaults (see
`lib/scenario.js`). The seed inbox may be inline (`{ "threads": [...] }`) or a
string path to a fixture file relative to the project root.

| Field | Type | Notes |
| --- | --- | --- |
| `id` | string | **Required.** Unique scenario id. |
| `title` | string | App title. |
| `brief` | string | The exercise task/prompt. Presented by the host harness; CosmoMail no longer renders it in-app. |
| `primarySkill` | `writing` \| `prompting` \| `both` | What the exercise assesses. |
| `scenarioType` | `compose_new` \| `reply` \| `reply_chain` | Drives composer prefill. |
| `learner` | `{ displayName, email, avatar }` | Who the learner is in the thread. Optional `avatar` is `0`–`12`; **`0` is the empty face and the default for You**. |
| `characters` | object[] | People the learner may put on To / Cc. `{ id, name, email }` required; optional `avatar` (`0`–`12`) picks a bundled circle-cropped face (`0` is empty). Extra fields (`role`, `prompt`, …) are kept for future personas. Compose and reply pickers are limited to this list. |
| `seed.inbox` | object \| string | Inline `{ threads }` or a fixture path. Threads may set `"mailbox": "spam"` to land in Spam; otherwise they start in Inbox. Sent is filled automatically when the learner sends. |
| `seed.activeThreadId` | string | Which mailbox to open on load (the folder that contains this thread). |
| `seed.focusedEmailId` | string | Email the reply targets. |
| `initialDraft` | `{ to, cc, subject, body }` | Optional composer prefill. |
| `assistant.enabled` | boolean | When `false`, hide the Cosmo copilot panel. |
| `assistant.capabilities` | string[] | `compose`, `qa_search`, `summarize`, `extract`. |
| `assistant.systemPromptExtra` | string | Trusted extra instructions for the copilot. |
| `assistant.initialMessage` | string | Cosmo's opening message. |
| `assistant.allowCustomInstructions` | boolean | Let learners add their own instructions. |
| `simulatedRecipient.enabled` | boolean | Enable in-character replies. |
| `simulatedRecipient.threadBehavior` | `one_reply` \| `multi_turn` \| `scripted` | Reply strategy. |
| `simulatedRecipient.maxTurns` | number | Cap for `multi_turn`. |
| `simulatedRecipient.personas` | object[] | `{ id, name, email, role, prompt }` (first is used). |
| `simulatedRecipient.scriptedBeats` | string[] | Fixed replies for `scripted`. |
| `generation` | `{ model, temperature, thinking, language }` | LLM settings. |
| `attachments` | `{ enabled, allowedTypes }` | Outbound attachment support. |
| `ui` | `{ hideHistory, strings }` | UI overrides + i18n strings. |
| `rubricHints` | object \| string | Notes surfaced in the extraction report. |

### Example scenarios

Ready-to-run scenarios live in [`scenario-examples/`](scenario-examples/) (their
seed data lives in [`fixtures/`](fixtures/)). Copy one to `scenario.json` to try
it:

- **`01-compose-new-outreach`** — write a cold outreach email from scratch
  (no seed inbox, copilot only).
- **`02-reply-vendor-negotiation`** — reply within a seeded vendor negotiation
  thread (copilot + attachments, no simulated recipient).
- **`03-qa-summarize-status`** — use Cosmo to interrogate a project thread and
  write a leadership-ready summary (Q&A / search / extract focus).
- **`04-simulated-recipient-support`** — a customer-support thread where the
  recipient replies in-character over multiple turns.
- **`05-scripted-recipient-scheduling`** — schedule an interview where the
  candidate returns fixed, scripted replies.

```bash
cp scenario-examples/04-simulated-recipient-support.scenario.json scenario.json && npm run dev
```

See [`scenario-examples/README.md`](scenario-examples/README.md) for details.

## Internationalization

Base UI strings live in `i18n/` (e.g. `i18n/en.json`). A scenario picks a
language via `generation.language`, and per-scenario overrides can be supplied in
`ui.strings`.

## Extraction & reporting

Turn captured sessions (`sessions.json`) into readable Markdown for an AI tutor
or an assessment rubric:

```bash
npm run extract                                    # full transcript, newest first
node extract-conversations.js --mode submission    # only the final (most recent) sent email
node extract-conversations.js --mode thread        # the email thread(s)
node extract-conversations.js --mode assistant     # the Cosmo conversation
npm run report                                      # Markdown report (rubric hints in header)
node extract-conversations.js --mode report --output report.md --print-settings
```

Options: `--latest` (most recent session only), `--output <file>`,
`--print-settings` (include scenario settings in the heading), `--help`.

## Testing

```bash
npm test         # vitest run (unit + API route tests)
npm run test:watch
```

CI (`.github/workflows/ci.yml`) runs build + tests on push/PR;
`.github/workflows/release.yml` tests, builds, and archives a dist tarball on a
GitHub release (excluding secrets and runtime files).

## Project layout

```
agents/cosmo-mail/     Octavus agent definition (protocol, prompts, settings)
design-system/         Shared UI submodule
scenario-examples/     Ready-to-run example scenarios
fixtures/              Seed inbox fixtures referenced by scenarios/examples
i18n/                  Locale catalogs
lib/                   Pure logic (scenario, sessions, i18n, helpers)
public/                Client app (index.html, app.js, app.css)
scripts/               Agent deploy tooling
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
