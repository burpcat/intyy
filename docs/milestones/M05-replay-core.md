# M05 — Replay core

> **Phase:** A · **Size:** L · **Depends on:** M04 · **Status:** not started

## Read first

- Section 3 §4 (the request, all), §5 (the result contract, all), §6.4 to §6.9 (events, frozen facts, write-ahead, redaction points, step trace), §7.3 to §7.10.
- Section 7 §2 (principles), §4 (a run, start to end), §5 (settling and waiting), §6 (clue voting), §7 (acting), §8 (limits), §9 (dialogs and pop-ups), §10 (the prelude), §18 (determinism).
- Section 4 §7.8 (risk in replay: the four checks), §8.11 (the request index).
- Section 2 §16 (recovery and commit states).
- Section 1 §19, "Commit points".
- Section 6 §5.5 (the prelude in discovery), §16 (correlation reference).
- Section 9 §10.1 to §10.3 (replay, waiting, stopping), §10.7 (sweep), §13.2 (demo path).

## Goal

A sealed artifact replays with no model deciding: it signs in, does the task, and returns a typed result.

## Why now

- **Replay is the production path** (brief §3.3). Everything after this milestone makes it safer or better proven.
- **Task discovery needs the prelude.** The prelude is a replay of `sign_in` (build plan §7.2).

## Delivers

### Code

- **`src/core/model/`:** `intyy.request/1.0`, `intyy.result/1.0`, `intyy.runspec/1.0`, and `intyy.run/1.0`.
- **`src/core/orchestrator/`:**
  - Pre-run checks 1 to 10 (section 3 §4.8). No browser opens until all pass.
  - **Check 7, thin:** no score store exists yet. Every context counts as `draft`. Unattended requests get `rejected`, `context_not_approved`, `not_approved`.
  - **A minimal resolver:** the newest sealed version of the major that fits the tenant's app version.
  - **The request index:** keyed hashes only, with the K1 key. A true repeat returns the stored result.
  - The run log with frozen facts, `run.json`, and the tenant index.
- **`src/core/replay/`:**
  - Settle after actions. Condition waits. The outcome race. Timeouts from artifact defaults.
  - Clue voting with DOM and accessibility clues. The winner rule: score 0.70, lead 0.15, evidence 0.20.
  - Acting per action type. The dispatch check for the commit (section 7 §7.2).
  - Native dialogs and pop-up windows.
  - **The prelude:** replay `sign_in`, then start the task at its entry page. No loop inside the prelude.
  - **The commit:** the live re-check, then `commit_intent` written durably, then the action, then the effect block.
  - Outputs: raw in memory for the delivery window. Masked on disk, with warning `outputs_masked`.
  - A masked screenshot and snapshots on every failure.
- **Task discovery starts after the prelude.** `discover` replays the sealed `sign_in` first (section 6 §5.5).
- **In this milestone, any unexpected screen is a hard failure.** Recovery comes in M06. A commit-step failure ends `failed` with commit `uncertain`.

### Commands

- `replay <app>/<capability>@<major> --mode … --inputs <file> […]` and `replay --request <file>`.
- The start confirmation for supervised runs: on a terminal, in place; elsewhere, through `operator decide`.
- Ctrl-C once ends the run at the next safe point. A second Ctrl-C warns, then kills.
- `--reveal-outputs`, with the rules of section 9 §7.3.
- `run status [--wait] | list | show`, and `run sweep` for crashed replays.

### Library and other files

| File | Agent | Owner |
|---|---|---|
| `library/specs/kvfcu/open_share_subaccount.json`, `.missing.json`, `.at_limit.json` | Skeletons with `spec new` | Fills in goals, inputs, outputs, effect, and example values |
| `library/specs/kvfcu/find_account_by_reference.json`, `.not_found.json` | Same | Same |
| `library/artifacts/kvfcu/find_account_by_reference/1.0.0/` | — | Reviews and seals |
| `library/artifacts/kvfcu/open_share_subaccount/1.0.0/` | — | Reviews, decides the recovery link, seals |
| `demo/valid.json`, `missing.json`, `at_limit.json`, `bad.json`, `auth.json` | Writes them (build plan §9) | Reviews in git |

**Example values for discovery:** valid `100114`, missing `100101`, at limit `100254`. The demo files use other members, so data from discovery and demos never mix. Never `100240`.

## Not in this milestone

- Handlers, packs, retries, and reconciliation. M06.
- The image clue. M08.
- The score store and full check 7. M10.
- Takeovers. M07.

## Tasks, in order

- [x] 1. Write the request, result, run spec, and `run.json` schemas.
- [x] 2. Write the pre-run checks, test first. Checks 6 to 9 report every problem at once.
- [x] 3. Write the minimal resolver and the request index.
- [x] 4. Write settle, condition waits, and the outcome race.
- [x] 5. Write clue voting. Test that a renamed button fails, ties are ambiguous, and the evidence floor holds.
- [x] 6. Write acting, the dispatch check, dialogs, and pop-ups.
- [x] 7. Write the commit path: live re-check, durable `commit_intent`, the effect block.
- [x] 8. Write the executor and the prelude. Run the full path on the snapshot surface.
- [x] 9. Write the `replay` and `run` commands, the start confirmation, Ctrl-C, and `--reveal-outputs`.
- [x] 10. Write the sweep for crashed replays.
- [ ] 11. Make `discover` start with the prelude. Write the five spec skeletons.
- [ ] 12. Stop. Ask the owner to run the discoveries in the order below.
- [ ] 13. Write the demo files. Write the live demo test and the member canary test.

**Discovery order for the owner.** The check needs an account with a known reference. The first run makes one.

1. `discover …/open_share_subaccount.json`. A candidate with a recovery placeholder. Approve the Confirm click in the mailbox.
2. `discover …/find_account_by_reference.json`. Its example reference is run 1's run ID.
3. `discover …/find_account_by_reference.not_found.json --candidate <id from 2>`.
4. Review and seal `find_account_by_reference@1.0.0`.
5. `discover …/open_share_subaccount.missing.json --candidate <id from 1>`, then `.at_limit.json` the same way.
6. Decide the recovery link to `find_account_by_reference@1`. Confirm the at-limit refusal means "no change". Seal `open_share_subaccount@1.0.0`.

## Test gate

### Automated (CI `check` job)

- [ ] Pre-run checks: each rejection code, in order. A rejected request still gets a run ID and a short log.
- [ ] Request index: a true repeat returns the stored result; a changed request with the same ID gives `request_id_reused`.
- [ ] Settle and wait, outcome race, clue voting, unknown logic, dispatch, native dialog (section 7 §21).
- [ ] Write-ahead: a failed durable write means the action is never sent. The run fails `evidence_write_failed`.
- [ ] Live re-check: riskier words on the commit control block the click.
- [ ] Determinism: two runs on the snapshot surface give the same step trace.
- [ ] Output rules: terminal delivery; piped outputs masked; `--reveal-outputs` refused off loopback.
- [ ] Unattended replay is `rejected`, `context_not_approved`, exit 4.
- [ ] Sweep: a crash after `commit_intent` leaves commit `uncertain` and prints the `reconcile` command.

### Live (`npm run test:live`)

- [ ] The prelude signs in, then starts the task.
- [ ] Demo path steps 4 and 5 (section 9 §13.2). No model needed.
- [ ] Two replays with the same inputs give the same step trace.
- [ ] Member canary: replay for the member in `canary_members`, in a temporary data root. Never hardcode it. The scan finds neither the number nor the returned numbers.

### Owner checks

- [ ] Five real discoveries done, in the order above. Both artifacts sealed.
- [ ] `demo/valid.json`: `success`, with the account number on the terminal.
- [ ] `demo/missing.json`: `business_outcome`, `member_not_found`, exit 2.
- [ ] `demo/at_limit.json`: `business_outcome`, commit `refused`. If the app shows the limit before Confirm, commit is `not_sent`. Note which.
- [ ] `demo/bad.json`: `rejected`, `invalid_input`, exit 4.

## Evidence produced

- **A2:** `find_account_by_reference` discovery, positive and `not_found`.
- **A3:** `open_share_subaccount` discovery: positive with the approval in its mailbox, missing, and at limit.
- **A4, rest:** the two new sealed artifacts.
- **A5, A6, A7:** the three replays above.

## Done when

- The brief's core thread works: goal, real discovery, sealed artifact, deterministic replay, typed result.
- A business outcome and a bad input each end cleanly, with the right status and exit code.
