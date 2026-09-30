## Features
- ~~Support dates relative to today in seeds.  Instead of saying "By July 15th", I should be able to say something like "By ${today}" or "By ${next week}" or "By ${3 days from today}" etc~~
- ~~The scenario should not know anything about the grading rubric~~
- ~~The assistant should use a SplitPanel so it can be re-sized~~
- ~~We need some way of knowing that Cosmo is "thinking".  A spinner, or some sort of animation, etc.~~
- ~~Clicking a seeded inbound attachment chip should open a small read-only preview when author-provided `text` is present (name-only chips stay non-interactive; no real file parsing).~~

## Bugs
- ~~No auth / session-ownership checks on mutating APIs (e.g. `POST /api/assistant/clear`, send, session save). Any caller who knows a `sessionId` can modify that session. Needs a real ownership model if this ever leaves a single-learner local harness.~~ (not a bug. This is not a real production app and only runs in a sandbox for one user)
- ~~Session store (`sessions.json`) has no serialized read-modify-write: overlapping `/api/session/save`, `/api/session/events`, send, and draft saves can overwrite each other’s updates. Needs a shared per-file (or per-session) write queue if concurrent writers matter.~~ (fixed via `withSessionsWrite` / `updateSessionById`)
- `sendAssistant` only guards on `chat.status === 'streaming'`, so Enter can still submit while a quick action is busy. Use `assistantIsBusy()` (keep the missing-chat guard).

## A11y

Parked until after the resizable shell. Track remediation in
[a11y_audits/findings-checklist.md](a11y_audits/findings-checklist.md)
(start with C1/C2, then S1–S5). SplitPanel unblocks S3 reflow work.
