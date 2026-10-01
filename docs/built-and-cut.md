# What was built, and what was cut

State on 2026-10-01. Sources: the ticked boxes in `docs/milestones/`, `git log`, build plan §12, and `docs/decisions.md`.

Terms:
- **Built, not proven live** means the code and its offline tests pass. No live run or evidence item exists yet.
- **Owner step** means a seal, approval, live run, or publish that only the owner may do.

Real state of the repo: `library/artifacts/` holds one sealed artifact, `kvfcu/sign_in@1.0.0`. `open_share_subaccount` is still a candidate. `evidence/` holds only its README. No `REPORT.md` exists. No git tag exists.

## Per milestone

**M00 Foundation** (`3d5ac09`). Built: repo, tooling, docs check, CI `check` job. Owner steps: none open. Not built: nothing.

**M01 Core seams** (`445592b`, `895f189`). Built: ports, stores, locks, policy merge, CLI shell, staff, settings. Owner seals done. Not built: nothing.

**M02 Surface and gate** (`225bac6`, `7168d1b`). Built: Playwright surface, safety gate, redaction, canary scan. Owner checks done. Not built: the object form of `extra_origins` (decision 2026-09-28).

**M03 Live discovery** (`6b4965c`, `7901a76`). Built: discovery loop, Claude planner, mailbox approvals. The owner ran the real `sign_in` discovery. Not built: nothing.

**M04 Recorder and review** (`62bef30`, `1e9880e`). Built: recorder, candidate review, sealing. The owner sealed `sign_in@1.0.0`. Not built: patch merge and patch commands (by design).

**M05 Replay core** (`dc3e402`, `dd09386`). Built: replay engine, commit path, `replay` and `run` commands, sweep.
- Owner steps not run: task 12, the three real discoveries; review and seal of `open_share_subaccount@1.0.0`; the four demo runs.
- Built, not proven live: the live demo test and the member canary test.
- Not built: `find_account_by_reference`. The artifact uses a reconciliation waiver instead.

**M06 Ladder, reconciliation, certify case** (`4fa1916`, `090dcb5`, `8834e4a`). Built: rung 1, reconciliation, harness, `certify case`, pack and fixture formats.
- Owner steps not run: seal suite, test data, and faults; one `certify case` per profile; fixtures; seal both packs; evidence A8 to A10.
- Not built: the two packs are not drafted, because they need fixtures from live captures.

**M07 Handoff, publish, drafts** (`1a4824e`, `7a9977a`). Built: control lease, operator mailbox, handoff, crash sweep, `evidence publish` and `verify`, `test:safety`.
- Owner steps not run: A11 live handoff with two terminals; publish set A; tag `v0.1-thin-slice`.
- Built, not proven live: both live certify tests (`830df5e`).

**M08 Visual clue** (`18b4829`, `408286b`). Built: region and image clues, voting, `certify --kind quick`, `--instance`.
- Owner step not run: the stripped-button drill (B1).
- Built, not proven live: the live quick-batch test.

**M09 Models on the ladder** (`db2c95e`, `8dc643f`, `e16285a`). Built: reviewer adapter, rungs 2 and 3 wiring, reconciliation second opinion, table fakes, `thresholds` and `jev report` commands.
- Owner steps not run: B2 unknown pop-up case with real models; seal and approve the threshold record.
- Not built: the jev adapter (tasks 1 and 3). It needs the owner's official SDK docs and key. Rung 2 runs only on fakes.
- Built, not proven live: the reviewer. One live fault-table test exists (`cdba451`).

**M10 Certify and approval** (`f8b7b6f`, `861bbcf`, `7c1a0f8`, `3b23c3f`). Built: score store, trust state machine, full batches, six-rule gate, approval family, resolver and check 7, stability and twins, tuned timeouts, guided walk.
- Owner steps not run: seal the two new suites (one `sign_in` suite is drafted); three full batches; three approvals as `op_022` (B3, B4).
- Not built: the `quick` batch in the CI `live` job. Decision 2026-09-26 keeps live tests local. CI needs a decision on how it gets the bank app.
- Consequence: no key is `approved`, so unattended replay stays rejected.

**M11 Live trust and drift** (`38cc5e1`, `108c7f6`, `937c593`, `474b166`, `334e857`). Built: live scores, demotion rules, early warnings, drift reader, alerts, major records, pack impact and regression batches, reconciliation autonomy. One live degrade test passes (`6da7521`).
- Owner steps not run: gate check of `intyy trust list`; optional major seal.
- Not built: the lakeshore probe (task 7), `clue_drift` (needs patch drafting), and the "one app version" pattern.
- Built, not proven live: everything except the degrade test. Autonomy cannot earn real evidence without a real jev.

**M12 Final write-up** (`1b29129`, `59dec9c`, `dcfebf3`). Built: README update, evidence index set B rows, repo audit script. This file is task 1.
- Not done: `REPORT.md` (tasks 2 to 4), evidence verify, and the fresh-clone test. The owner publishes set B items that exist.

## Cut line (build plan §12)

| # | Item | Status |
|---|---|---|
| 1 | Lakeshore probe (B5) | Not built. Owner-only. Files not drafted |
| 2 | Major records, pack regression, reconciliation autonomy | Built, not proven live |
| 3 | Drift reader, alerts, early warnings | Built, not proven live. `clue_drift` not built: it needs patch drafting |
| 4 | Live scores and demotion | Built. One live test passes |
| 5 | Guided walk for `trust approve` | Built, not proven live |
| 6 | Tuned timeouts | Built, not proven live. Needs full batches |
| 7 | Stability curve and twin runs | Built, not proven live. Needs full batches |
| 8 | Full certify and approval | Built, not proven live. No key is approved |
| 9 | Reviewer LLM, rung 3 | Built. Live evidence is one fault-table test |
| 10 | jev, rung 2 | Not built. Needs the owner's SDK docs and key. Only fakes exist |
| 11 | Stripped-button drill (B1) | Built, not proven live. Owner step |
| 12 | The visual clue | Built, not proven live. Quick-batch test exists |

Also not built, outside §12: patch drafting and the patch merge (build plan §13.5), the CI `live` quick batch, and the two draft packs.

## Stretch goals (build plan §7.4)

The plan claims two: confidence and approval, and multi-run stability.
- **Confidence and approval.** The code supports it: scorer, six-rule gate, trust states, `trust approve`, check 7. The unattended rejection is in place. Claimable after the owner's M10 batches and approvals. Today it has no run evidence.
- **Multi-run stability.** The code supports it: stability levels, seeds, twin runs, fault-aware judge. Claimable after the owner's M10 full batches. Until then, claim the design only.
- **Assisted fallback.** The plan does not claim it. Rung 3 (the reviewer) is this goal under another name. The REPORT must say so plainly. Rung 3 has no live evidence beyond one fault-table test.
- **Do not claim** jev, drift alerts, or reconciliation autonomy as results. jev has no adapter. The others have no real evidence.
