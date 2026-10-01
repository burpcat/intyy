# M10 — Certify and approval

> **Phase:** B · **Size:** L · **Depends on:** M07; M08 and M09 if built · **Status:** in progress

## Read first

- Section 8 §2 (principles), §4 (trust states), §5 (score store), §6.1, §6.2 (suites, test data, including `setup`), §7.1 to §7.3 (batch kinds, what a full batch runs, seeds), §8 (judging, all), §9 (scores, the gate, tuned timeouts), §10 (approval), §11 (resolver), §14.3 (tag agreement), §16.1 (worked example), §18 (tests).
- Section 9 §9.1 (certify), §9.3, §9.4 (approval screen, approval family), §9.8 (score rebuild), §15 (worked example).
- Section 3 §4.8, check 7.

## Goal

A key earns trust from a full certify batch and a human approval, and only then runs unattended.

## Why now

- **It is one of the two stretch goals the REPORT claims:** confidence and approval (build plan §7.4).
- **Its tasks are ordered so the cuttable ones come last** (build plan §12, cuts 5 to 8).

## Delivers

### Code, in build order

1. **The score store** (section 8 §5): three files per key, history lines, the record rebuilt from them. Every batch kind now writes a `batch` history line.
2. **The scorer:** outcome score, locator margin, coverage.
3. **`full` batches:** baseline, matrix, extra, drills. Each case follows section 8 §7.4.
4. **The gate** (section 8 §9.5). Each rule can fail it alone.
5. **The approval family** (section 9 §9.4): `trust list | show | history | review | approve | reject | restore | reinstate | demote | retire`.
   - Four eyes. Acknowledged fragile steps. `--expect-record` refuses after the record changed.
   - The approval screen renders the same text from the same record.
6. **The full resolver and pre-run check 7:** `context_not_approved`, `reconciliation_not_approved`, `session_not_approved`. Linked capabilities.
7. **`tags report`** from the tag agreement data.
8. **Stability:** the curve at entropy 0.05, 0.15, 0.30, twin runs, and the fault-aware judge. *(Cut 7.)*
9. **Tuned timeouts:** candidates from one batch, tested by the next, installed by approval. *(Cut 6.)*
10. **The guided walk for `trust approve`.** It issues the same commands as the flags. *(Cut 5, first to go.)*

- **If M08 was skipped,** build the `quick` kind first, as M08 describes.
- **If M09 was cut,** rungs 2 and 3 are off everywhere. Batches then test the ladder live runs use, so they stay approval-grade. Record this in `docs/decisions.md`.

### Commands

- `certify <key> [--kind full|quick|regression]`. `regression` is used from M11.
- The trust family above, `trust rebuild`, `tags report`.

### Library files

| File | Agent | Owner |
|---|---|---|
| `library/suites/kvfcu/sign_in@1/1.json` | Drafts it | Seals as `op_017`, approves as `op_031` |
| `library/suites/kvfcu/find_account_by_reference@1/1.json` | Drafts it, with a `setup` run that opens an account | Same |

## Not in this milestone

- Live scores and demotion. M11.
- Pack regression batches. M11.
- Reconciliation autonomy. M11.

## Tasks, in order

- [x] 1. Write the score store and the record rebuild. Golden test: same lines, same record bytes.
- [x] 2. Write the trust state machine. Test every transition; nothing moves up without a staff ID.
- [x] 3. Write the scorer and the `full` batch runner.
- [x] 4. Write the gate. Test each rule failing alone.
- [x] 5. Write the approval family, the approval screen, and `--expect-record`.
- [x] 6. Write the resolver and check 7, with linked capabilities.
- [ ] 7. Draft the two new suites. Stop. Ask the owner to seal and approve them.
- [ ] 8. Add a `quick` batch to the CI `live` job, with jev and the reviewer faked.
- [ ] 9. Stop. Ask the owner to run the batches and approvals below. This is the minimum for B3 and B4.
- [x] 10. Write stability, twins, and the fault-aware judge.
- [x] 11. Write tuned timeouts.
- [x] 12. Write the guided walk for `trust approve`.

**Batches and approvals, for the owner.** Order matters: sign-in and the check come first, because the commit capability links to them.

1. Before any approval: `intyy replay kvfcu/open_share_subaccount@1 --mode unattended --inputs demo/valid.json --authorization demo/auth.json`. Expect `rejected`, exit 4.
2. As `op_017`: `intyy certify kvfcu/sign_in@1.0.0`. Then as `op_022`: `intyy trust review …`, then `intyy trust approve … --expect-record sha256:…`.
3. The same for `kvfcu/find_account_by_reference@1.0.0`.
4. The same for `kvfcu/open_share_subaccount@1.0.0`.
5. Repeat step 1. Expect `success`, exit 0.

## Test gate

### Automated (CI `check` job)

- [x] Record rebuild golden test; state machine; lock and atomic write (section 8 §18).
- [x] Verdicts, gate, approval rules, resolver.
- [x] `--expect-record` refuses after the record changed. Approval screen golden test.
- [x] Check 7: unattended open-share is rejected until sign-in, the check, and open-share are all approved.
- [x] If built: fault-aware judge and tuned timeouts.

### Live (`npm run test:live`)

- [ ] A `quick` batch passes on the bank app, with jev and the reviewer faked.

### Owner checks

- [ ] Three `full` batches passed their gates. Three keys approved at keystone by `op_022`.
- [ ] Unattended replay: rejected before, `success` after.

## Evidence produced

- **B3:** the three batch reports and trust snapshots. Failed runs publish; passing batch runs do not (build plan §11.3).
- **B4:** the unattended replay, rejected, then `success`.

## Done when

- A sealed recipe is not trusted until a batch and a second person say so, and the tests prove it.
