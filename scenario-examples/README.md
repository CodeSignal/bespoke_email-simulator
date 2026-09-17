# Scenario examples

Ready-to-run CosmoMail scenarios covering the main use cases the simulator was
built for. Each file is a complete scenario config; the seeded inbox data they
reference lives in the project-root [`fixtures/`](../fixtures/) folder.

## Try one

Copy a scenario to `scenario.json` at the project root, then start the app:

```bash
cp scenario-examples/02-reply-vendor-negotiation.scenario.json scenario.json
npm run dev
```

The `seed.inbox` paths are resolved relative to the project root (e.g.
`fixtures/vendor-thread.json`), so they work whether you run a file in place or
copy it to `scenario.json`.

## The examples

| File | Use case | Type | Assistant focus | Live characters |
| --- | --- | --- | --- | --- |
| `01-compose-new-outreach` | Write a cold outreach email from scratch | `compose_new` | compose, summarize | none (Priya is directory-only) |
| `02-reply-vendor-negotiation` | Counter a vendor's pricing in an ongoing thread | `reply_chain` | compose, Q&A, summarize, extract | none (Dana is directory-only) |
| `03-qa-summarize-status` | Interrogate a thread and write an exec summary | `reply` | Q&A / search / extract / summarize | none |
| `04-simulated-recipient-support` | De-escalate and resolve a support ticket | `reply_chain` | compose, Q&A, summarize | Marcus |
| `05-scripted-recipient-scheduling` | Schedule an interview with a candidate | `reply_chain` | compose, summarize | Jordan (Morgan is directory-only) |
| `06-software-sales-prospecting` | Align with a manager on one CRM lead, then book a meeting | `reply_chain` | compose, Q&A, summarize, extract | Alex, Jane, Ryan, Emily, Michael, Sarah |

### What each one demonstrates

- **01 — Compose new (writing):** No seed inbox; the learner drafts from a blank
  composer with an initial draft prefilled. Attachments and history are off.
- **02 — Reply within a chain (both skills):** A seeded negotiation thread with
  the copilot fully enabled and attachments on.
- **03 — Q&A / summarize / extract (prompting):** A multi-email project thread
  with concrete facts (owners, dates, budget, a blocker). The task is to use
  Cosmo to answer questions and produce a leadership-ready summary; custom
  instructions are allowed and temperature is lowered for factual accuracy.
- **04 — Live character, support:** Marcus replies in-character until he has a
  real fix or nothing left to say. Pushback if the learner is generic or cold.
- **05 — Live character, scheduling:** Jordan replies in-character and works
  toward a booked slot. Morgan is in the picker but will not write back unless
  you add a persona (or `responds: true`).
- **06 — Live characters, sales prospecting:** Alex emails a five-lead list.
  The learner argues for a target; Alex only greenlights Ryan. Then they
  compose a new note to that prospect. Ryan books a call if the mail is
  specific; Jane, Emily, Michael, and Sarah deflect.

## Extraction

After a run, generate a rubric-ready transcript:

```bash
npm run report                 # Markdown report with rubric hints in the header
npm run extract -- --latest    # full transcript of the most recent session
```

See the top-level [`README.md`](../README.md#scenario-authoring) for the full
scenario schema.
