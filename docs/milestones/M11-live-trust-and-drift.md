# M11 — Live trust and drift

> **Phase:** B · **Size:** M · **Depends on:** M10 · **Status:** in progress

## Read first

- Section 8 §2.2 (machines may take trust away), §5.5 (live lines), §11.9 (deprecating and retiring a major), §12 (live scores and demotion), §13.1 to §13.3 (drift reader), §14.2 (reconciliation autonomy), §15 (pack, engine, and jev trust), §16.2, §16.3 (worked examples), §18 (tests).
- Section 9 §9.4 (`trust exclude`), §9.5 (autonomy), §9.6 (majors), §9.7 (alerts and drift), §8.5 (`pack impact`).
- Updates file §11.2 (the lakeshore probe).
- Build plan §13.5 (patches and the probe).

## Goal

Trust that was given can be taken away by evidence from live runs, and shared changes are checked before they go live.

## Why now

- **An approval is not forever.** Live runs must be able to demote a key without a human.
- **It is the first milestone to cut.** Its tasks run in reverse cut order: the most cuttable comes last.

## Delivers

### Code, in build order

1. **Live lines and live scores** (section 8 §12). Every replay writes a live line. App failures do not count. *(Cut 4.)*
2. **The two demotion rules:** below 0.90 over 20 or more runs; three recipe failures in a row at one step. `trust exclude` and `restore`.
3. **Early warnings, the drift reader, and alerts** (section 8 §12.4, §13.1 to §13.3). *(Cut 3.)*
4. **Major records** and check 4's `major_retired` reason. *(Cut 2.)*
5. **Pack regression:** `pack impact`, `certify --kind regression --pack … --all-affected`, and the coverage check in `pack approve`. *(Cut 2.)*
6. **Reconciliation autonomy:** the evidence count, grant, revoke, and the reset on each revocation path. *(Cut 2.)*
7. **The lakeshore probe,** optional. *(Cut 1, first to go.)*

### Commands

- `trust exclude`, `alert list | show | act | dismiss`, `drift report`.
- `major show | deprecate`.
- `pack impact`, `certify --kind regression --pack <scope>@<rev> --all-affected`.
- `trust autonomy`, `trust autonomy grant | revoke`.

### Library files

| File | Agent | Owner |
|---|---|---|
| `library/majors/kvfcu/open_share_subaccount@1/1.json` | Drafts it | Seals as `op_017`, approves as `op_031` |
| `library/settings/lakeshore/1.json`, `library/policy/tenant/lakeshore/1.json`, `library/testdata/lakeshore/kvfcu/1.json` | Drafts them, only if the probe runs | Seals as `op_017`, approves as `op_022` |

## Not in this milestone

- Patch drafting, patch merge, and a patched lakeshore drill. Designed only (build plan §13.5).
- Tag autonomy grants and threshold calibration. Designed only.
- Clue weight calibration. Designed only.

## Tasks, in order

- [x] 1. Write live lines and the live score. Test that each failure code lands in its class.
- [x] 2. Write the window and streak rules. Test degrading at the edges, exclusion, and restore.
- [ ] 3. Write early warnings, the drift reader, and alerts. Test the handler set tie-in with fixtures.
- [ ] 4. Write major records and `major_retired`.
- [ ] 5. Write `pack impact`, regression batches, and the coverage check.
- [ ] 6. Write reconciliation autonomy. Test the balance rule and each revocation path.
- [ ] 7. Only if time allows: draft the lakeshore files. Stop. Ask the owner to run the probe below.

**The lakeshore probe (B5), for the owner:**

1. Add `INTYY_LAKESHORE_KVFCU_OPERATOR_USERNAME`, `…_PASSWORD`, and `INTYY_LAKESHORE_REQUEST_INDEX_KEY_K1` to `.env`.
2. Seal and approve the three lakeshore files.
3. Restart the bank app with `KVFCU_VARIANT=lakeshore`.
4. `intyy certify kvfcu/open_share_subaccount@1.0.0 --tenant lakeshore --kind quick --instance variant=lakeshore`
5. Restart the bank app as keystone.
6. Read the vote lines. Note which clues differed and whether the margins held. A `quick` batch is never approval-grade.

## Test gate

### Automated (CI `check` job)

- [x] Live classes; window and streak rules; exclusion and restore (section 8 §18).
- [ ] Handler set tie-in: a drop after a hash change names the pack revision.
- [ ] Autonomy: the balance rule; each revocation path resets the evidence.
- [ ] `pack approve` refuses without regression coverage, once a key is approved.
- [ ] A retired major gives `capability_not_found`, reason `major_retired`, naming the successor.

### Live (`npm run test:live`)

- [ ] In a temporary data root: replays write live lines, and three recipe failures in a row at one step degrade the key.

### Owner checks

- [ ] `intyy trust list` shows the three keystone keys still `approved` in the real state.
- [ ] If run: the probe's findings are written down for the REPORT's heterogeneity section.

## Evidence produced

- **B5, optional:** the lakeshore probe.
- **Updated trust snapshots** for B3, if live scores changed them.

## Done when

- A machine can take trust away on evidence. Only a human gives it back.
