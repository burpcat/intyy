# What was built, and what was cut

State on 2026-10-02. Sources: the ticked boxes in `docs/milestones/`, `git log`, build plan §12, `docs/decisions.md`, and the status column of `evidence/README.md`.

Terms:
- **Built, not proven live** means the code and its offline tests pass. No live run or evidence item exists yet.
- **Owner step** means a seal, approval, live run, or publish that only the owner may do.

Real state of the repo: `library/artifacts/` holds sealed `kvfcu/sign_in@1.0.0` and `kvfcu/open_share_subaccount` up to `1.0.3`. Both keys are approved. The packs, suites, test data, faults, and the jev threshold record are sealed and approved. `evidence/` holds set A items A1 to A12 and set B items B1 to B4. `REPORT.md` exists. The tag `v0.1-thin-slice` exists.

## Per milestone

**M00 Foundation** (`3d5ac09`). Built: repo, tooling, docs check, CI `check` job. Owner steps: none open. Not built: nothing.

**M01 Core seams** (`445592b`, `895f189`). Built: ports, stores, locks, policy merge, CLI shell, staff, settings. Owner seals done. Not built: nothing.

**M02 Surface and gate** (`225bac6`, `7168d1b`). Built: Playwright surface, safety gate, redaction, canary scan. Owner checks done. Not built: the object form of `extra_origins` (decision 2026-09-28).

**M03 Live discovery** (`6b4965c`, `7901a76`). Built: discovery loop, Claude planner, mailbox approvals. The owner ran the real `sign_in` discovery. Not built: nothing.

**M04 Recorder and review** (`62bef30`, `1e9880e`). Built: recorder, candidate review, sealing. The owner sealed `sign_in@1.0.0`. Not built: patch merge and patch commands (by design).

**M05 Replay core** (`dc3e402`, `dd09386`). Built: replay engine, commit path, `replay` and `run` commands, sweep.
- Owner steps done: the real discoveries and the demo runs (A2, A3, A5 to A7). `open_share_subaccount` is sealed.
- Not built: `find_account_by_reference`. The artifact uses a cited reconciliation waiver instead (decisions 2026-10-01 and 2026-10-02).

**M06 Ladder, reconciliation, certify case** (`4fa1916`, `090dcb5`, `8834e4a`). Built: rung 1, reconciliation, harness, `certify case`, pack and fixture formats.
- Owner steps done: suite, test data, faults, fixtures, and both packs are sealed. A8 to A10 are published.

**M07 Handoff, publish, drafts** (`1a4824e`, `7a9977a`). Built: control lease, operator mailbox, handoff, crash sweep, `evidence publish` and `verify`, `test:safety`.
- Owner steps done: A11 live handoff, tag `v0.1-thin-slice`, the set A manifest with a clean `evidence verify`.

**M08 Visual clue** (`18b4829`, `408286b`). Built: region and image clues, voting, `certify --kind quick`, `--instance`.
- Owner step done: the stripped-button drill (B1). It ends in a safe escalation, not a pass.

**M09 Models on the ladder** (`db2c95e`, `8dc643f`, `e16285a`). Built: jev adapter, reviewer adapter, rungs 2 and 3 wiring, reconciliation second opinion, table fakes, `thresholds` and `jev report` commands.
- Owner steps done: B2 unknown pop-up with real models; the threshold record for `jev-1.13.0` is sealed and approved.

**M10 Certify and approval** (`f8b7b6f`, `861bbcf`, `7c1a0f8`, `3b23c3f`). Built: score store, trust state machine, full batches, six-rule gate, approval family, resolver and check 7, stability and twins, tuned timeouts, guided walk.
- Owner steps done: full batches and approvals for the two keys (B3, B4). Unattended replay is `rejected` before approval and `success` after.
- Not built: the `quick` batch in the CI `live` job. Decision 2026-09-26 keeps live tests local.

**M11 Live trust and drift** (`38cc5e1`, `108c7f6`, `937c593`, `474b166`, `334e857`). Built: live scores, demotion rules, early warnings, drift reader, alerts, major records, pack impact and regression batches, reconciliation autonomy. One live degrade test passes (`6da7521`).
- Not needed: the optional major seal. `library/majors/` does not exist.
- Not built: the lakeshore probe (task 7), `clue_drift` (needs patch drafting), and the "one app version" pattern.
- Built, not proven live: everything except the degrade test.

**M12 Final write-up** (`1b29129`, `59dec9c`, `dcfebf3`, `b4d5803`). Built: README update, evidence index, repo audit script, this file, `REPORT.md`.
- Owner step done: the fresh-clone test of the short demo path.
- Owner steps open: the boxes left in the M12 spec (reading the REPORT aloud, defending each section, the public repo and tag `v1.0`).

## Cut line (build plan §12)

| # | Item | Status |
|---|---|---|
| 1 | Lakeshore probe (B5) | Cut. Files not drafted |
| 2 | Major records, pack regression, reconciliation autonomy | Built, not proven live |
| 3 | Drift reader, alerts, early warnings | Built, not proven live. `clue_drift` not built: it needs patch drafting |
| 4 | Live scores and demotion | Built. One live test passes |
| 5 | Guided walk for `trust approve` | Built |
| 6 | Tuned timeouts | Built |
| 7 | Stability curve and twin runs | Built. Measured in the full batches (B3) |
| 8 | Full certify and approval | Built. Both keys approved (B3, B4) |
| 9 | Reviewer LLM, rung 3 | Built. Live evidence: B2 and one fault-table test |
| 10 | jev, rung 2 | Built. Live evidence: B2 |
| 11 | Stripped-button drill (B1) | Run. Ends in a safe escalation |
| 12 | The visual clue | Built. Drilled in B1 |

Also not built, outside §12: patch drafting and the patch merge (build plan §13.5), and the CI `live` quick batch.

## Stretch goals (build plan §7.4)

`REPORT.md` claims two: confidence and approval, and multi-run stability.
- **Confidence and approval.** Scorer, six-rule gate, trust states, `trust approve`, check 7. Evidence: B3 and B4.
- **Multi-run stability.** Stability levels, seeds, twin runs, fault-aware judge. Evidence: the B3 batch reports.
- **Assisted fallback.** Not claimed. Rung 3 (the reviewer) is close to it, and `REPORT.md` says so.
- **Not claimed as results:** drift alerts, major records, pack regression, and reconciliation autonomy. They have no live evidence.
