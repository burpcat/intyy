# M04 — Recorder and review

> **Phase:** A · **Size:** L · **Depends on:** M03 · **Status:** not started

## Read first

- Section 2 §3 to §19 (the artifact, field by field, and loader checks), §21 (full example).
- Section 6 §14 (the recorder, all), §15 (candidate review and sealing), §16 (correlation reference), §17 (worked example).
- Section 9 §5.8 (candidate store), §6.2 (library layout), §6.4 (indexes and sealing), §8.2, §8.3 (candidate commands, second look), §11 (capability catalog).
- Section 8 §10.2 (four eyes in two places).
- Section 5 §12.2 (the draft handler file).
- Updates file §5 (patch format: schema and loader only).

## Goal

The real `sign_in` run becomes a reviewed, sealed, versioned artifact: `kvfcu/sign_in@1.0.0`.

## Why now

- **The artifact schema is a focal point of the brief** (brief §3.2). It must exist before replay can read it.
- **M05's prelude replays `sign_in`.** So `sign_in` must be sealed first.

## Delivers

### Code

- **`src/core/model/`:** Zod schemas for `intyy.artifact/1.0`, `intyy.patch/1.0`, candidate decision lines, and `intyy.handler_draft/1.0`.
- **Loader checks** of section 2 §19, including candidate mode, the session link, and formats. Patches get schema and loader checks only.
- **JSON Schema export:** `npm run schemas` writes `schemas/`. `npm run check` fails when the files are stale.
- **The condition evaluator** (section 2 §14). It answers true, false, or unknown. Only true passes.
- **`src/core/recorder/`:** every rule in section 6 §14.2 to §14.15, as plain code. The same log and decisions always give the same bytes.
- **The candidate store:** a folder per candidate, with linked runs, `decisions.jsonl`, and regenerated revisions.
- **Sealing:** the four sealing rules, the second look, version bump checks, crops moved into the artifact folder.
- **The catalog:** `capability describe --format tool` prints a tool definition from the contract (section 2 §12.9).

### Commands

- `discover <spec> [--candidate <id>]` now runs the recorder and prints the candidate ID.
- `candidate list | show | issues | review | decide | second-look | seal --version`.
- `artifact list | show | verify`.
- `capability list | describe [--format tool]`.

### Library files

| File | Agent | Owner |
|---|---|---|
| `library/candidates/kvfcu/<id>/…` | The recorder writes it from the A1 run | Reviews and decides with the CLI |
| `library/artifacts/kvfcu/sign_in/1.0.0/` | — | Seals as `op_017`. Second look as `op_022` if a risk was lowered |

## Not in this milestone

- `candidate adopt`. It needs packs (M06).
- Patch merge, patch commands, patch drafting. Designed only (build plan §13.5).
- Replay. M05.

## Tasks, in order

- [x] 1. Write the artifact schema, block by block, with doc comments that cite section 2.
- [x] 2. Write the loader checks. Test that each check accepts and rejects the right files.
- [x] 3. Write the patch schema and its loader checks.
- [x] 4. Write the JSON Schema export and the freshness check.
- [x] 5. Write the condition evaluator. Test the three answers, and that `not` of unknown never passes.
- [x] 6. Write the candidate store and the decision log.
- [x] 7. Write the recorder, rule by rule, test first, on small saved logs in `tests/fixtures/logs/`.
- [x] 8. Write the "false before" check: a checkpoint true before its action is caught.
- [ ] 9. Write the golden test: a saved masked log plus decisions give the same artifact bytes.
- [ ] 10. Write the candidate commands and the guided review walk.
- [ ] 11. Write sealing and the second look. Test: sealing fails without it; passes with another staff ID; a disagreement records `irreversible`.
- [ ] 12. Write the artifact and capability commands.
- [ ] 13. Record the A1 run as a candidate. Stop. Ask the owner to review and seal `sign_in@1.0.0`.

## Test gate

### Automated (CI `check` job)

- [ ] Loader checks accept and reject the right files, for artifacts and patches.
- [ ] Recorder rules, each on its own small log (section 6 §18).
- [ ] The "false before" check catches its case.
- [ ] Negative alignment: an outcome lands on the right step.
- [ ] Recorder golden test.
- [ ] Second look and second-look disagreement (section 9 §16).
- [ ] The JSON Schema files are fresh.
- [ ] `capability describe --format tool` matches its golden file.

### Live

- [ ] None.

### Owner checks

- [ ] You reviewed every tag and risk flag on the `sign_in` candidate.
- [ ] `kvfcu/sign_in@1.0.0` is sealed. `intyy artifact verify kvfcu/sign_in@1.0.0` passes.
- [ ] The artifact holds no secret value, only `{secret.operator_username}` and `{secret.operator_password}`.

## Evidence produced

- **A4, part:** the sealed `sign_in` artifact. Published in M07.

## Done when

- The recorder turns a real run into an artifact by plain code, the same way every time.
- A human reviewed and sealed `sign_in@1.0.0`.
