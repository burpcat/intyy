# M06 — Error ladder, reconciliation, certify case

> **Phase:** A · **Size:** L · **Depends on:** M05 · **Status:** not started

## Read first

- Section 5 §2 (principles), §4 (the ladder in one view), §5 to §7 (pack file, one handler, scope and merge), §8.1 to §8.6 and §8.9 to §8.13 (rung 1, retry, resume rule, rung 4, verdicts, after the commit), §9 (business outcomes and packs), §13 (fixtures), §14 (the bank app's faults), §15 (example packs), §16 (tests).
- Section 7 §7.3 (transport failures), §10 (the prelude, for `sign_in` recovery), §11 (reconciliation runs), §13.1 to §13.3 (intervention fields, decisions, deadlines).
- Section 8 §6 (certify inputs, all), §7.1, §7.3 to §7.8 (batch kinds, seeds, one case, run spec, scripted operator, plan and report), §8.1 to §8.3 (result class, truth checks, verdicts), §15.1, §15.2 (pack regression and which contexts).
- Section 9 §5.5 (harness port), §8.5 (pack commands), §8.7 (suite, test data, fault commands), §9.1 (certify), §10.6 (manual reconcile).
- Updates file §11.1 (`certify case` and extra cases).
- `CONTRACT.md` §5 (seed data), §6 (chaos), §8 (test endpoints).

## Goal

Replay handles the runtime errors of `CONTRACT.md` §6 on purpose, and `certify case` can show any fault path on demand.

## Why now

- **The brief's third distinction:** business outcome, recoverable condition, hard failure (brief §3.3). M05 has only the first and the last.
- **The hardest case, a lost commit reply,** needs reconciliation. Only `certify case` can place that fault at the commit step (build plan §7.2).

## Delivers

### Code

- **Packs:** the `intyy.pack/1.0` and `intyy.fixture/1.0` schemas, loader checks, merge by ID, the frozen set and its hash, the tie rule.
- **The ladder, rung 1:** declared outcomes, then handlers, then retry, then climb. The helper window, the pre-commit sweep, the resume rule, verdicts, ladder log lines.
- **Rungs 2 and 3 stay off.** Their frozen `ladder` facts say so. A climb goes straight to rung 4.
- **Rung 4, thin:** takeover requests with full context go to the mailbox. `retry_decision` and `reconciliation_decision` are answered with `operator decide`. Claiming a takeover comes in M07.
- **The `sign_in` handler** re-runs the prelude after a lost session.
- **Reconciliation:** a child run in a fresh session, `purpose: commit_check`, using the linked check capability. Plain code decides. If unclear, a human decides.
- **Commit retry:** after `absent_by_check`, a human approves a retry. The retry is a new child run with a new run ID.
- **Manual reconcile** (section 9 §10.6), with `effect_update.json`.
- **The harness port,** `src/adapters/kvfcu-harness/` (HTTP to the `/__test__/` endpoints), and an in-memory fake with a fault log and an oracle.
- **Certify inputs:** `intyy.suite/1.0`, `intyy.testdata/1.0`, `intyy.faults/1.0`, with loaders and commands.
- **The route map:** fault log plus run log give each step's route key and count.
- **Thin certify:** `certify case`, `certify rerun`, `certify report`. The scripted operator. Truth checks against the oracle. Verdicts. `plan.json` and `report.json`.
- **`--profile` accepts a standard profile or a suite `extra` case ID** (updates file §11.1).

### Commands

- `pack edit | check | seal | approve | dry-run`, `fixture new`, `candidate adopt`.
- `suite | testdata | faults`: `edit | check | seal | approve`.
- `certify case <key> --class … --profile … [--at …]`, `certify rerun`, `certify report`.
- `operator decide` for retry and reconciliation decisions.
- `reconcile <run_id> --inputs <file>`.

### Library files

| File | Agent | Owner |
|---|---|---|
| `library/suites/kvfcu/open_share_subaccount@1/1.json` | Drafts it from section 8 §6.1, with real outcome codes from the artifact | Seals as `op_017`, approves as `op_031` |
| `library/testdata/keystone/kvfcu/1.json` | Drafts pools from `CONTRACT.md` §5. Never `100240` | Seals as `op_017`, approves as `op_022` |
| `library/faults/kvfcu/1.json` | Writes the standard set of section 8 §6.3 | Seals as `op_017`, approves as `op_031` |
| `library/fixtures/kvfcu/…` | — | Makes each one with `fixture new` from a masked capture |
| `library/packs/global/1.json`, `library/packs/app/kvfcu/1.json` | Drafts handlers from the fixtures only | Seals as `op_017`, approves as `op_031` |

- **No key is approved yet.** So `pack impact` lists no context, and the first pack approval needs no regression batch. Record this in `docs/decisions.md`.

## Not in this milestone

- Claiming a takeover, the lease, capture, reverify. M07.
- `certify --operator mailbox`. M07.
- jev and the reviewer. M09.
- `certify <key>` batches of any kind. M08 builds `quick`, M10 builds `full`.
- The score store. Thin certify writes only `plan.json` and `report.json`.

## Tasks, in order

- [x] 1. Write the pack and fixture schemas, loader checks, merge, frozen set, and tie rule. Test first.
- [x] 2. Write the ladder, rung 1, on the snapshot surface. Test the helper window matrix, resume rule, rung order, and pre-commit sweep.
- [x] 3. Test "known screen, no progress": it fails with the underlying code and does not climb.
- [x] 4. Write rung 4 requests and the `operator decide` answers for retry and reconciliation.
- [x] 5. Write reconciliation, commit retry, and manual reconcile.
- [x] 6. Write the harness port, the kvfcu adapter, and the fake. Add the harness boundary test.
- [x] 7. Write the suite, test data, and fault schemas and commands. Draft the three files. Stop. Ask the owner to seal and approve them. (2026-10-01: test data rev 1 sealed op_017, approved op_022; faults rev 1 sealed op_017, approved op_031; open_share_subaccount suite rev 1 sealed op_017, approved op_031.)
- [x] 8. Write the route map, `certify case | rerun | report`, the scripted operator, truth checks, and verdicts.
- [x] 9. Stop. Ask the owner to run `certify case` once per profile. With no packs, each fails at its fault and captures the screen. (2026-10-01, on 1.0.3 at @step:click_member: server_error run_2026-10-01_6gvdnv11mp, maintenance run_2026-10-01_5jt1tkgbqg, known_popup run_2026-10-01_40mh2hdj7m, unknown_popup run_2026-10-01_1a1406rmfs (pass, escalated), session_expire run_2026-10-01_w0gccpdfzn; reply_lost run_2026-10-01_c6z6sr5fmr passed with the cited-waiver ending at click_ok.)
- [x] 10. Stop. Ask the owner to make fixtures from those captures, plus the restricted user's screen, with `fixture new`. (2026-10-01: trouble_server_error, trouble_maintenance, trouble_kyc_popup, trouble_session_expired, trouble_permission (restricted user, run_2026-10-01_q2nh5m1dpr), normal_confirm, normal_member_detail, normal_open_form; normal_main meta.json upgraded.)
- [ ] 11. Draft the global and app packs from the fixtures. Stop. Ask the owner to seal and approve them.
- [x] 12. Write the live fault table test and the live demo step 6 test.

## Test gate

### Automated (CI `check` job)

- [x] Pack loader, merge and override, frozen set, fixture suite, tie rule (section 5 §16).
- [x] Helper window matrix, resume rule, pre-commit sweep, rung order, known screen with no progress.
- [x] Undeclared outcome: a pack outcome the step does not declare ends `undeclared_outcome`.
- [x] Transport: `hang` recovers on an `idempotent` step, and reconciles after Confirm.
- [x] Reconciliation: `drop_after_confirm` ends `success`, `found_by_check`, through a child run.
- [x] Commit retry: `absent_by_check`, then `retry`, gives a new child run with a new run ID.
- [x] Manual reconcile: re-entered inputs are hash-checked; `effect_update` is written; `run status` warns `effect_updated`.
- [x] Route map, anchor expansion, truth checks, verdicts, all on the fake harness (section 8 §18).
- [x] Harness boundary: no replay-path module imports `ports/harness.ts`.
- [x] Canary scan: no canary value in the pack store or fixtures.

### Live (`npm run test:live`)

- [ ] Every row of section 5 §14 with a rung 1 answer ends as the table says. Named faults, fixed seed.
- [ ] `unknown_popup` ends `escalated`, because rungs 2 and 3 are off. That is `recovers_or_escalates`.
- [ ] The prelude: `sign_in` recovers a lost session, then the task resumes.
- [ ] Demo path step 6: `success`, `found_by_check`.

### Owner checks

- [ ] Suite, test data, faults, and both packs are sealed and approved. (Suite, test data, faults done 2026-10-01; packs pending.)
- [ ] Each handler has at least one `fire` and one `no_fire` fixture.
- [ ] You ran A8, A9, and A10 below, and each ended as expected.

## Evidence produced

- **A8:** `intyy certify case kvfcu/open_share_subaccount@1.0.0 --class valid --profile reply_lost`. Expect `success`, `found_by_check`.
- **A9:** `… --class valid --profile session_expire --at @step:<a task step>`. Expect `success` with one recovery.
- **A10:** the restricted-user replay in a subshell (build plan §13.4). Expect `failed`, `permission_denied`. If the app hides the button instead, the run escalates. Keep what happens and note it.

## Done when

- Replay tells business outcomes, recoverable conditions, and hard failures apart, with evidence for each.
- A lost commit reply ends in the truth, found by a read-only check.
