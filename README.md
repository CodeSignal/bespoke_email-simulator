# CosmoMail (CMail)

A lightweight, AI-powered email simulator for teaching and assessing how people
write and manage email with the help of an AI assistant. Learners read a seeded
thread, compose replies in a rich editor, and "send" messages — while an AI
copilot (Cosmo) can help draft, answer questions about the email history,
summarize, and extract information. Scenarios can optionally simulate a recipient
who replies in-character for realistic, back-and-forth email threads.

CMail never sends real email; it simulates the experience and captures everything
for rubric-based assessment.

## Status

Early planning. See:

- [`PRD.md`](PRD.md) — product requirements and design.
- [`similar-project-details.md`](similar-project-details.md) — notes on the
  ChatCPT reference project whose setup CMail clones.

## Concept

- Each exercise is a single **scenario** defined in a JSON config (seeded inbox,
  task/brief, and which AI capabilities are enabled).
- All agentic work is orchestrated by the **Octavus** platform, with separate
  dev and prod agent profiles.
- No database — short-term state is stored in a local JSON file.

## License

Elastic License 2.0 — see [`LICENSE.md`](LICENSE.md).
