# Milestones

> **Source:** build plan §7 (`docs/design/10-intyy-build-plan.md`).
> **Rule:** one milestone per Claude Code session. No gate, no next milestone.

## The list

| # | Spec | Phase | Size | Depends on |
|---|---|---|---|---|
| M00 | [Foundation](M00-foundation.md) | A | S | — |
| M01 | [Core seams](M01-core-seams.md) | A | M | M00 |
| M02 | [Surface and safety gate](M02-surface-and-safety-gate.md) | A | L | M01 |
| M03 | [Live discovery](M03-live-discovery.md) | A | M | M02 |
| M04 | [Recorder and review](M04-recorder-and-review.md) | A | L | M03 |
| M05 | [Replay core](M05-replay-core.md) | A | L | M04 |
| M06 | [Error ladder, reconciliation, certify case](M06-ladder-reconciliation-certify-case.md) | A | L | M05 |
| M07 | [Handoff, publish, drafts](M07-handoff-publish-drafts.md) | A | L | M06 |
| M08 | [Visual clue](M08-visual-clue.md) | B | S | M07 |
| M09 | [Models on the ladder](M09-models-on-the-ladder.md) | B | M | M07 |
| M10 | [Certify and approval](M10-certify-and-approval.md) | B | L | M07; M09 if built |
| M11 | [Live trust and drift](M11-live-trust-and-drift.md) | B | M | M10 |
| M12 | [Final write-up and evidence](M12-final-write-up.md) | C | S | M07, plus whatever phase B finished |

- **Phase A** is the thin slice: the brief's full thread, done simply. It ends at M07.
- **Phase B** adds depth. Every phase B item is on the cut line (build plan §12).
- **Phase C** finishes the submission. It is never cut.
- **Sizes are relative.** S is about half an M. L is about twice an M.

## How to use a spec

| Heading | What it tells you |
|---|---|
| Read first | The only design sections to read for this milestone |
| Goal | One sentence: what exists at the end |
| Why now | Why this comes here in the order |
| Delivers | Code, commands, and files, with who makes each file |
| Not in this milestone | Work to leave alone, even if it looks close |
| Tasks, in order | A checklist. Tick each box when done |
| Test gate | Automated, live, and owner checks. All must pass |
| Evidence produced | Items for `/evidence/` (build plan §11) |
| Done when | The short list the owner signs off |

## Words used in every spec

| Word | Meaning | Example |
|---|---|---|
| **Owner** | The person who reviews gates and plays every staff role | Seals as `op_017`, approves as `op_022` |
| **Temporary data root** | A throwaway folder with its own `intyy.json`, made by a test | `mkdtemp()` in a test's setup |
| **Live test** | A test that talks to the local bank app | The network guard test |
| **Cassette** | A fake planner that replays saved model replies | Replays the owner's `sign_in` run in CI |

## Pace check

- **After M02,** the owner sets a time box for the rest (build plan §7.6).
- **If M07 is not done at 60% of the time box,** skip phase B. Go to M12.
