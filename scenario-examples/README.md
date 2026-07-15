# Scenario examples

Ready-to-run CosmoMail scenarios covering the main use cases the simulator was
built for. Each file is a complete scenario config; the `fixtures/` folder holds
the seeded inbox data they reference.

## Try one

Copy a scenario to `scenario.json` at the project root, then start the app:

```bash
cp scenario-examples/02-reply-vendor-negotiation.scenario.json scenario.json
npm run dev
```

The `seed.inbox` paths are relative to the project root
(`scenario-examples/fixtures/...`), so they resolve whether you run a file in
place or copy it to `scenario.json`.

## The examples

| File | Use case | Type | Assistant focus | Simulated recipient |
| --- | --- | --- | --- | --- |
| `01-compose-new-outreach` | Write a cold outreach email from scratch | `compose_new` | compose, summarize | off |
| `02-reply-vendor-negotiation` | Counter a vendor's pricing in an ongoing thread | `reply_chain` | compose, Q&A, summarize, extract | off |
| `03-qa-summarize-status` | Interrogate a thread and write an exec summary | `reply` | Q&A / search / extract / summarize | off |
| `04-simulated-recipient-support` | De-escalate and resolve a support ticket | `reply_chain` | compose, Q&A, summarize | `multi_turn` (frustrated customer) |
| `05-scripted-recipient-scheduling` | Schedule an interview with a candidate | `reply_chain` | compose, summarize | `scripted` (fixed beats) |

### What each one demonstrates

- **01 — Compose new (writing):** No seed inbox; the learner drafts from a blank
  composer with an initial draft prefilled. Attachments and history are off.
- **02 — Reply within a chain (both skills):** A seeded negotiation thread with
  the copilot fully enabled and attachments on.
- **03 — Q&A / summarize / extract (prompting):** A multi-email project thread
  with concrete facts (owners, dates, budget, a blocker). The task is to use
  Cosmo to answer questions and produce a leadership-ready summary; custom
  instructions are allowed and temperature is lowered for factual accuracy.
- **04 — Simulated recipient, multi-turn:** The recipient (Marcus) replies
  in-character over several turns and only relents when the reply is empathetic
  and offers a concrete fix — good for realistic back-and-forth practice.
- **05 — Simulated recipient, scripted:** The recipient (Jordan) returns fixed
  scripted beats regardless of exact wording, useful for deterministic,
  repeatable exercises. `maxSubmissions` is 2 to allow a follow-up.

## Extraction

After a run, generate a rubric-ready transcript:

```bash
npm run report                 # Markdown report with rubric hints in the header
npm run extract -- --latest    # full transcript of the most recent session
```

See the top-level [`README.md`](../README.md#scenario-authoring) for the full
scenario schema.
