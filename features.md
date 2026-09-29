## Features
- Support dates relative to today in seeds.  Instead of saying "By July 15th", I should be able to say something like "By ${today}" or "By ${next week}" or "By ${3 days from today}" etc
- The scenario should not know anything about the grading rubric 
- The assistant should use a SplitPanel so it can be re-sized
- We need some way of knowing that Cosmo is "thinking".  A spinner, or some sort of animation, etc.

## Bugs
- No auth / session-ownership checks on mutating APIs (e.g. `POST /api/assistant/clear`, send, session save). Any caller who knows a `sessionId` can modify that session. Needs a real ownership model if this ever leaves a single-learner local harness. (not a bug. This is not a real production app and only runs in a sandbox for one user)
- Session store (`sessions.json`) has no serialized read-modify-write: overlapping `/api/session/save`, `/api/session/events`, send, and draft saves can overwrite each other’s updates. Needs a shared per-file (or per-session) write queue if concurrent writers matter.

## A11y

