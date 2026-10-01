# M09 — Models on the ladder

> **Phase:** B · **Size:** M · **Depends on:** M07 · **Status:** in progress

## Read first

- Section 5 §2.6 (every model touch is visible), §8.7 (rung 2), §8.8 (rung 3), §10 (jev, all), §11 (the reviewer, all).
- Section 4 §7.9 (helpers: handlers and the reviewer), §10.8 (other models).
- Section 7 §11 (reconciliation runs).
- Section 8 §8.5 (jev answers and truth), §14.1 (jev thresholds).
- Section 9 §5.3 (model ports), §5.9 (table fakes), §9.5 (`jev report`, `thresholds show`).
- Section 1 §19, "jev autonomy for reconciliation" (only the part before autonomy).

## Goal

Trouble that plain code cannot sort goes to jev, then to a one-step reviewer, before a human, with every model call recorded.

## Why now

- **Operators get fewer takeovers.** Rung 1 plus a human is safe but slow.
- **It comes after the thin slice.** It is on the cut line, at 9 and 10.

## Delivers

### Code

- **First, confirm jev's API.** The owner gives the official SDK docs. Never guess an API.
- **`src/adapters/jev/`:** the classifier port. Buckets `outcome`, `handler`, `needs_review`, `unsafe`, with a probability.
- **`src/adapters/claude/`, reviewer:** one step, one action, through the gate. Model `claude-sonnet-5`.
- **Table fakes** for both, answering by fault style or input hash.
- **The model call order** for both: bytes stored in `llm/` before sending.
- **Threshold records** per app and jev version (section 8 §14.1), with a loader.
- **Rungs 2 and 3 in the ladder.** Skipped while the helper window is closed. The tie rule's last step now reaches rung 2.
- **Reconciliation with jev:** plain code decides first. jev runs only when code is unsure. The reviewer checks every jev answer. A disagreement goes to a human.
- **`--models off`** switches rungs 2 and 3 off, frozen in `ladder`.
- **jev never claims `refused`.** Only plain code may say "nothing changed".

### Commands

- `thresholds show`, `jev report`.
- `thresholds edit | check | seal | approve`.

### Library files

| File | Agent | Owner |
|---|---|---|
| `library/thresholds/kvfcu/<jev_version>/1.json` | Drafts it from section 8 §14.1 defaults | Seals as `op_017`, approves as `op_031` |

## Not in this milestone

- Granting jev reconciliation autonomy. M11, and last in its order.
- Reviewing and accepting draft handlers the reviewer suggests. Later, if time allows.
- Threshold calibration. Designed only (section 1 §18).

## Tasks, in order

- [ ] 1. Stop. Ask the owner for jev's official SDK docs and key. Write the adapter only from those docs.
- [x] 2. Write the table fakes first. Write the jev path tests: each bucket, each threshold edge, timeout, bad output.
- [ ] 3. Write the jev adapter and the threshold loader.
- [x] 4. Write the reviewer adapter. Test: allowed action, blocked action, give up, no landing.
- [x] 5. Wire rungs 2 and 3 into the ladder. Test that helpers never act while the window is closed.
- [ ] 6. Wire jev and the second opinion into reconciliation. Test disagreement goes to a human.
- [ ] 7. Extend the LLM view test to jev and reviewer inputs.
- [ ] 8. Write `jev report` and `thresholds show`. Draft the threshold record. Stop. Ask the owner to seal and approve it.
- [ ] 9. Stop. Ask the owner to run the unknown pop-up case below.

**The unknown pop-up case (B2), for the owner:**

- `intyy certify case kvfcu/open_share_subaccount@1.0.0 --class valid --profile unknown_popup --at @step:<an open-window step>`
- Real models. Expect `success` with a recovery by rung 2 or 3, or an honest escalation.

## Test gate

### Automated (CI `check` job)

- [x] jev paths and reviewer paths (section 5 §16), with the table fakes.
- [x] Helpers never act while the helper window is closed.
- [ ] Reconciliation: code first, then jev, then the second opinion; disagreement reaches a human.
- [ ] Model call order for jev and the reviewer.
- [ ] `--models off` freezes rungs 2 and 3 off in `ladder`.
- [ ] LLM view: no canary value in any stored jev or reviewer input.

### Live (`npm run test:live`)

- [ ] The fault table still passes, with jev and the reviewer faked.
- [ ] `unknown_popup` now ends `recovers_or_escalates` through rungs 2 and 3, faked.

### Owner checks

- [ ] The threshold record is sealed and approved.
- [ ] B2 ran with real models. You read the `llm/` files for both rungs.

## Evidence produced

- **B2:** the unknown pop-up case, with rung 2 and rung 3 records.

## Done when

- The ladder climbs plain code, jev, reviewer, human, in that order, and every model touch is on disk.
