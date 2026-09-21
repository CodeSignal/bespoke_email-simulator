# PRD: CosmoMail (CMail) — AI Email Simulator

*Draft for review. Companion doc: `similar-project-details.md` (the ChatCPT
reference project whose setup we are cloning).*

## 1. Overview

**Product name:** CosmoMail (CMail for short)

**Purpose:** A lightweight, hands-on email simulator that teaches and assesses
how people write and manage email with the help of an AI assistant. Learners
work inside a familiar email UX — reading a thread, composing in a rich editor,
"sending" replies — while an AI copilot (Cosmo) can help draft messages, answer
questions about the email history, summarize, and extract information. Optionally,
a simulated recipient replies in-character so a learner can practice a live email
exchange.

**Core concept:** Each exercise is a single, self-contained **scenario** defined
in a JSON config. The scenario seeds an inbox/thread, states the learner's task,
and turns AI capabilities on or off. The simulator never sends real email; it
faithfully *simulates* the experience and captures everything for assessment.

**Relationship to ChatCPT:** CMail clones ChatCPT's setup — one Express server on
port 3000, all agentic work via the Octavus SDK, a dev/prod two-profile Octavus
deployment, the shared `design-system` submodule, JSON-file persistence (no DB),
vanilla-JS frontend bundled by esbuild, and extraction scripts for readable
transcripts. CMail extends that foundation with an email-centric UX, a richer
scenario config, a TipTap composer, and a second agent behavior (the simulated
recipient).

---

## 2. Goals & objectives

### Primary goals
- Teach effective **email writing** (clarity, tone, structure, appropriateness).
- Teach effective **AI collaboration on email** (prompting an assistant to draft,
  answer questions, summarize, and extract from an email history).
- Simulate realistic email workflows (compose, reply, reply-to-chain) in a
  controlled learning environment.
- Optionally simulate **live threads** where the other party responds in-character.
- Capture all interactions (drafts, sends, thread, AI chat, final submission) for
  rubric-based assessment and tutoring.

### What's assessed (configurable per scenario)
The scenario's `primarySkill` selects the emphasis:
- **`writing`** — the learner writes the email themselves; the AI is an optional copilot.
- **`prompting`** — the learner directs the AI to produce/analyze emails.
- **`both`** — a blended exercise (default).

### Non-goals (v1)
- Not a real email client and it does **not** send real email (no SMTP/IMAP).
- No real inbox management (folders, labels, rules, calendar, contacts).
- No cross-session memory or long-term persistence.
- No multi-scenario picker — one scenario per deployment.
- No built-in scoring UI (grading/tutoring is an external subsystem fed by
  extraction output).

---

## 3. Target users
- Learners practicing professional/business email and AI-assisted writing.
- Students in communication, sales, support, or workplace-readiness courses.
- Candidates in assessments measuring written communication and AI collaboration.

---

## 4. Scenario types (brainstorm → v1 scope)

Scenarios are grouped by the skill they exercise. A single scenario can combine
composition and comprehension tasks.

### Composition (learner produces an outbound email)
- **Construct a new email** from a brief/goal (blank thread).
- **Reply to an email** (single inbound message in context).
- **Reply to an email chain** (full multi-message thread in context).
- Forward with a cover note; follow-up/nudge; decline/push back politely;
  negotiate (rates/deadlines/scope); cold outreach; support/apology response;
  tone/persona-constrained rewrite; respond in another language.

### Comprehension & retrieval (learner interrogates an email history)
- Summarize a long thread ("catch me up").
- Search the inbox ("find the email about the Q3 budget").
- Q&A over history ("what did Sarah commit to, and by when?").
- Extract action items / decisions / dates.

### Interactive / real-time (simulated recipient replies) — optional per scenario
- Back-and-forth negotiation where the recipient replies in-character.
- Escalating customer complaint that reacts to the learner's tone.
- Scheduling coordination that converges on a time.
- Multi-stakeholder thread (different personas reply differently).

**v1 confirmed capabilities:** compose/draft assistance, Q&A + search over
history, thread summarization, action-item/info extraction, and an **optional**
simulated recipient. Inbox triage/prioritization is out of v1 scope (candidate
for a later release).

---

## 5. User experience

### 5.1 Layout (focused, lightweight)
A single-purpose, focused workspace (not a full Outlook clone):

- **Left: thread / inbox rail** — a compact list of the seeded email(s)/threads
  for the scenario, with the relevant thread open by default. Kept minimal; the
  emphasis is the active thread, not inbox management.
- **Center: reading pane** — the active thread rendered top-to-bottom (each email
  shows from/to/cc/subject/date + Markdown-rendered body and any attachments).
- **Compose surface** — a composer with To / Cc / Subject fields and a **TipTap**
  rich-text body editor, opened inline for reply or as a focused compose view for
  a new email. Prefilled from `initialDraft` when configured.
- **Right: AI assistant panel** — a chat with Cosmo (the copilot). Streams
  responses (SSE) and can insert a drafted email directly into the composer.

The `primarySkill` value shifts emphasis (e.g. `writing` foregrounds the
composer; `prompting` foregrounds the assistant) but both surfaces are present.

### 5.2 Entry state
- Learner opens the exercise and sees the scenario **brief/task**, the seeded
  inbox with the target thread open (or an empty composer for "construct new"),
  and the assistant panel with an optional opening message.

### 5.3 Composing & the TipTap editor
- Body editing uses **TipTap in vanilla-JS mode** (`@tiptap/core`,
  `@tiptap/pm`, `@tiptap/starter-kit`, `@tiptap/markdown`), bundled by esbuild.
- **Markdown is the source of truth**: scenario configs author email bodies in
  Markdown; TipTap loads them with `contentType: 'markdown'` and serializes back
  via `editor.getMarkdown()`. Stored session bodies and extraction output are all
  Markdown — TipTap is purely the editing surface.
- Attachments are supported and **on by default** (reusing ChatCPT's upload flow
  via Octavus presigned URLs); allowed types configurable per scenario.

### 5.4 The AI assistant (copilot)
- Automatically has **full scenario context server-side**: the seeded inbox, the
  active thread, and the learner's current draft. The learner never has to paste
  emails in for the assistant to reason about them.
- Can: draft/rewrite an outbound email (offer to insert into the composer),
  answer questions about the thread/inbox, summarize, and extract action items.
- Honors optional per-scenario `systemPromptExtra` (trusted course-author
  instructions) and optional learner custom instructions (delivered in the user
  turn, subordinate to guardrails — same trust model as ChatCPT).

### 5.5 Sending & the simulated recipient
- **Send** simulates sending: the learner's email is appended to the thread and
  the composer clears. No real email leaves the system.
- If the scenario enables `simulatedRecipient`, sending triggers an in-character
  reply from a recipient persona, streamed into the thread. Thread behavior is
  **configurable per scenario**:
  - `one_reply` — each send yields exactly one recipient reply.
  - `multi_turn` — recipient keeps replying up to `maxTurns` / until a goal.
  - `scripted` — recipient only replies on author-defined beats.

### 5.6 Iteration & submission
- Learners can draft, send, and revise as many times as they like; everything is
  captured.
- **Submission:** the learner marks a final email/draft as their submission
  (analogous to ChatCPT's `selected_submission`). Default = most recent send.
  The full history is still captured regardless.

---

## 6. Scenario configuration (authoring)

One scenario per deployment, defined in a JSON config at the project root
(`scenario.json`, with `scenario.example.json` committed as the template — mirrors
ChatCPT's `chat-config.json`). Seed email data is **inline** in `seed.inbox` by
default. For a large mailbox, `seed.inbox` may instead be a path to a JSON file
of the same shape.

### 6.1 Config shape (illustrative)

```json
{
  "id": "reply-to-vendor-negotiation",
  "title": "CosmoMail",
  "brief": "Reply to the vendor's proposal. Push back on the price and propose a 12-month term.",
  "primarySkill": "both",
  "scenarioType": "reply_chain",

  "learner": { "displayName": "You" },

  "seed": {
    "inbox": {
      "threads": [
        {
          "id": "thread-1",
          "subject": "Proposal for annual license",
          "emails": [ /* ... */ ]
        }
      ]
    },
    "activeThreadId": "thread-1",
    "focusedEmailId": "email-3"
  },

  "initialDraft": {
    "to": ["dana@acme-vendor.com"],
    "cc": [],
    "subject": "Re: Proposal for annual license",
    "body": ""
  },

  "assistant": {
    "enabled": true,
    "capabilities": ["compose", "qa_search", "summarize", "extract"],
    "systemPromptExtra": "Coach the learner toward concise, professional tone.",
    "initialMessage": "Want help drafting a firm-but-friendly counter-offer?",
    "allowCustomInstructions": false
  },

  "simulatedRecipient": {
    "enabled": true,
    "threadBehavior": "multi_turn",
    "maxTurns": 4,
    "personas": [
      {
        "id": "dana",
        "name": "Dana Reyes",
        "email": "dana@acme-vendor.com",
        "role": "Vendor account manager",
        "prompt": "You are a friendly but firm account manager. Defend your pricing, but you can concede a small discount for a longer term."
      }
    ],
    "scriptedBeats": []
  },

  "generation": { "model": "anthropic/claude-opus-4-7", "temperature": 0.7, "thinking": "off", "language": "English" },

  "attachments": { "enabled": true, "allowedTypes": [".pdf", ".png", ".jpg", ".docx", ".txt"] },

  "submission": { "label": "Submit final email", "maxSubmissions": 1 },

  "ui": {
    "heading": "Reply to Dana's proposal",
    "hideAssistant": false,
    "hideHistory": false,
    "strings": {}
  },

  "rubricHints": {
    "notes": "Reward: acknowledges proposal, counters price with rationale, proposes 12-month term, professional tone."
  }
}
```

### 6.2 Seed email shape (illustrative)

This object lives in `seed.inbox`. For a large mailbox, the same JSON may live
in a separate file and `seed.inbox` can be a path to it.

```json
{
  "threads": [
    {
      "id": "thread-1",
      "subject": "Proposal for annual license",
      "emails": [
        {
          "id": "email-1",
          "from": { "name": "Dana Reyes", "email": "dana@acme-vendor.com" },
          "to": [{ "name": "You", "email": "you@company.com" }],
          "cc": [],
          "date": "2026-07-10T14:02:00Z",
          "subject": "Proposal for annual license",
          "body": "Hi,\n\nThanks for your interest. Our annual license is **$48,000**...",
          "attachments": []
        }
      ]
    }
  ]
}
```

### 6.3 Config capabilities summary
- Define the task/brief and `primarySkill` (writing / prompting / both).
- Choose `scenarioType` (`compose_new` / `reply` / `reply_chain`).
- Seed the inbox/threads (inline by default; optional JSON file for large
  inboxes); set the active/focused email.
- Prefill an initial draft.
- Enable/disable the assistant and choose its capabilities; add trusted
  `systemPromptExtra` and an optional opening message; opt into learner custom
  instructions.
- Enable/configure the simulated recipient (personas, thread behavior, turn caps,
  scripted beats).
- Control generation (model, temperature, thinking, language) and attachments.
- Configure the submission label/limit and UI/i18n overrides (reusing ChatCPT's
  string-override + i18n approach).
- Provide optional `rubricHints` metadata for the external tutor/assessment.

---

## 7. Backend architecture

### 7.1 Flow
```
Browser (vanilla JS + TipTap + design-system)
   │  @octavus/client-sdk (HTTP/SSE)  →  /api/*
   ▼
server.js (Express, port 3000) — thin proxy + JSON persistence + scenario loader
   │  @octavus/server-sdk (OctavusClient)
   ▼
Octavus (Cosmo Mail agent: assistant + recipient behaviors) → LLM
```

### 7.2 Responsibilities
- **Frontend:** render the email UX + assistant panel; manage local session state;
  drive the TipTap composer; call backend routes; stream responses.
- **Backend (thin):** load the scenario config + seed data; create/resume the
  session and seed the inbox into it; inject scenario context into the agent;
  proxy assistant and recipient turns to Octavus as SSE; persist state to JSON.
- **Octavus:** all LLM orchestration for both the assistant and the recipient.

### 7.3 Agent design (single agent, multiple behaviors)
One Octavus agent definition (**`cosmo-mail`** prod / **`cosmo-mail-dev`** dev),
the single source of truth, deployed via the same staging script pattern as
ChatCPT. It exposes distinct **triggers/handlers** so dev/prod parity stays simple:

- **`assistant-message` trigger** — the copilot. Inputs: `USER_MESSAGE`,
  `CUSTOM_INSTRUCTIONS` (optional), `FILES` (optional). Session-level context
  inputs: `SCENARIO_BRIEF`, `INBOX` / `THREAD`, `CURRENT_DRAFT`, plus the usual
  `MODEL`, `TEMPERATURE`, `THINKING`, `LANGUAGE`, `EXTRA_INSTRUCTIONS`,
  `VERBOSITY_INSTRUCTIONS`. System prompt covers: use the provided email context;
  distinguish compose vs. Q&A vs. summarize vs. extract; formatting; guardrails.
- **`recipient-reply` trigger** (used only when `simulatedRecipient.enabled`) —
  generates an in-character reply. Inputs: `SENT_EMAIL`, `THREAD`,
  `RECIPIENT_PERSONA`, `SCENARIO_GOAL`, `THREAD_BEHAVIOR`/`TURN` metadata. System
  prompt keeps the model in persona and prevents it from breaking character or
  acting as the assistant.

**Prompts to author (Octavus `prompts/`):**
- `system-assistant.md` — Cosmo the email copilot (persona, capabilities, context
  usage, guardrails, instruction-priority ordering like ChatCPT).
- `system-recipient.md` — the simulated recipient behavior (stay in persona, reply
  as the other party, pursue the scenario goal within guardrails).
- `assistant-message.md` / `recipient-reply.md` — user-turn templates that inject
  the message, context, persona, and files.

### 7.4 Big-context strategy
- **v1:** pass the full inbox/thread as context to the agent (scenarios start
  small — a handful of threads).
- **Designed to scale:** define a `search-emails` tool/skill hook (à la ChatCPT's
  `crawl-urls` skill) so that, when inboxes grow large, the assistant retrieves
  relevant emails instead of stuffing the whole history. Not implemented in v1,
  but the config/agent shape reserves room for it.

### 7.5 Persistence (JSON file, no DB)
Session state lives in a gitignored JSON file (e.g. `sessions.json`). Each record
extends ChatCPT's shape with email-thread state:

```json
{
  "session_id": "...",
  "scenario_id": "reply-to-vendor-negotiation",
  "created_at": "...",
  "updated_at": "...",
  "threads": [ { "id": "thread-1", "emails": [ /* seeded + learner sends + recipient replies */ ] } ],
  "drafts": [ { "to": [], "cc": [], "subject": "...", "body": "<markdown>", "updated_at": "..." } ],
  "assistant_messages": [ { "role": "user|assistant", "content": "...", "files": [], "timestamp": "..." } ],
  "selected_submission": { "email_id": "...", "submitted_at": "..." }
}
```

Everything is captured: the evolving thread (learner sends + recipient replies),
draft revisions, the assistant chat transcript, and the final submission.

### 7.6 API routes (extending ChatCPT)
- `GET /api/config` — scenario config + resolved i18n strings.
- `GET /api/scenario` — seed inbox/threads + brief (inline, or from a file path).
- `GET /api/session` / `POST /api/sessions` / `DELETE /api/sessions/:id` — lifecycle
  (session creation seeds the inbox into the record).
- `POST /api/assistant/trigger` — assistant turn (SSE stream).
- `POST /api/email/send` — append the learner's email to the thread; if the
  recipient is enabled, kick off the recipient reply.
- `POST /api/recipient/trigger` — generate a recipient reply (SSE stream).
- `POST /api/session/save` — persist thread/draft/assistant state.
- `POST /api/submission` — mark the final submission.
- `POST /api/upload-urls` — presigned attachment upload URLs (via Octavus).
- `GET /api/models` — available models filtered by config.

---

## 8. Data, extraction & assessment

- **Extraction scripts** (extending ChatCPT's `extract-conversations.js`) render
  readable output from the session JSON, in Markdown:
  - the **final submitted email(s)**,
  - the **full email thread** (seeded + learner sends + recipient replies),
  - the **assistant chat transcript** (including any search/Q&A the learner did),
  - a combined **report** for the tutor/rubric.
  - Modes along the lines of `--mode full|submission|thread|assistant|report`,
    plus `--latest`, `--output`, `--print-settings`.
- **Used by:** the external AI tutor and assessment rubrics (the `rubricHints`
  block in the scenario config can inform grading).

---

## 9. Guardrails & safety
- Reuse ChatCPT's guardrail model and strict **instruction-priority ordering**:
  hard guardrails > trusted course-author config (`systemPromptExtra`) > learner
  custom instructions (delivered in the user turn).
- The simulated recipient stays in persona but remains bound by the same
  guardrails (no harmful/unsafe content, no prompt extraction).
- Secrets (Octavus API key/URL, agent IDs) live only in `.env` (gitignored);
  `.env.example` is the committed reference. **No credentials in committed code.**

---

## 10. Technical constraints & stack
- Node.js 18+ (CI on 20), ESM, single Express server on **port 3000**.
- Octavus SDKs (`@octavus/server-sdk`, `@octavus/client-sdk`, `@octavus/cli`),
  dev/prod two-profile deploy + runtime switches (`AGENT_TARGET`).
- Frontend: vanilla JS bundled by esbuild; **TipTap** for the composer
  (`@tiptap/core`, `@tiptap/pm`, `@tiptap/starter-kit`, `@tiptap/markdown`);
  `marked` + `highlight.js` for rendering received email/assistant Markdown.
- Shared `design-system` git submodule, served statically.
- JSON-file persistence, no database. Stateless between sessions.
- Tests: `vitest` + `supertest`, with pure logic isolated in `lib/`.

---

## 11. Success metrics
- Exercise completion rate.
- Iterations per learner (draft revisions, sends, assistant turns).
- Quality improvement between attempts (via the external rubric).
- Appropriate use of the AI assistant for the scenario's `primarySkill`.
- Engagement time per session.

---

## 12. Future enhancements (out of v1 scope)
- Inbox triage/prioritization scenarios.
- A `search-emails` retrieval tool for large inboxes.
- Multi-scenario picker in one deployment.
- Richer email-client features (folders, labels, search UI).
- Inline coaching hints and real-time scoring.
- Attachment-aware analysis scenarios (summarize a PDF in a thread).

---

## 13. Open questions / assumptions to confirm
1. **Agent slug naming** — assumed `cosmo-mail` (prod) / `cosmo-mail-dev` (dev).
   Confirm, or if you prefer a `cmail-*` slug.
2. **Recipient turn ownership** — for `multi_turn`, should the recipient reply
   immediately after each learner send, or only when the learner chooses to send
   again? (Assumed: one recipient turn per learner send, capped by `maxTurns`.)
3. **Multiple personas on one thread** — v1 supports a persona list; do we need
   more than one persona replying within a single thread, or is one-per-thread
   enough for v1?
4. **Draft-in-composer vs. assistant output** — when the assistant drafts an
   email, should it auto-populate the composer, or offer an "insert" action the
   learner clicks? (Assumed: explicit "insert", to keep the learner in control.)
5. **Submission granularity** — is the submission always a single final email, or
   could a scenario ask the learner to submit multiple (e.g. a reply *and* a
   summary)? (Assumed: single, `maxSubmissions: 1`, but the field is configurable.)
6. **Attachments direction** — attachments are on by default for *outbound*
   learner emails; do seeded inbound emails also need attachments the assistant
   can reference in v1? (Assumed: seeded attachments are supported in the data
   model but assistant analysis of them is a later enhancement.)
