# M08 — Visual clue

> **Phase:** B · **Size:** S · **Depends on:** M07 · **Status:** in progress

## Read first

- Section 7 §6 (clue voting, all, especially §6.3 weights and §6.9 worked examples).
- Section 2 §13.2 (clues: `region` and `image`).
- Section 4 §9.12 (image crops).
- Section 6 §13 (fingerprint capture: crops before typing).
- Section 8 §7.1 (batch kinds, drills).
- Section 9 §9.1 (certify), §9.2 (declaring instance facts).
- Build plan §13.3 (the stripped-button demo).

## Goal

Replay finds a button with no name, text, or accessible name. It uses where the button is and how it looks.

## Why now

- **The brief favors approaches that work with no clean DOM** (brief §3.1). This is the cheapest proof.
- **It is the most protected item in phase B.** It is last on the cut line.

## Delivers

### Code

- **`certify <key> --kind quick`:** baseline for the first class, then the matrix on the commit step only (section 8 §7.1). No score store yet.
- **`--instance k=v,…`:** declared instance facts. Any difference from the test data set makes the batch a drill. The plan says so.
- **The `region` clue:** 1 within 3% of the viewport, falling to 0 at 20%.
- **The `image` clue:** picture likeness in plain code with `pngjs`. 1 at 0.90 or more, falling to 0 at 0.60.
- Crops come from the sealed artifact's `crops/` folder. A crop with a mask box in it is dropped.
- **An engine version bump.** Clue weights live in the engine. Every run logs the version.

### Commands

- `certify <key> --kind quick [--instance …] [--plan-only]`.

### Library files

- None.

## Not in this milestone

- Re-recording anything with the strip flag on. The demo tests replay, not discovery (build plan §13.3).
- `full` and `regression` batches, and the score store. M10.
- Vision-driven discovery. Designed only.

## Tasks, in order

- [x] 1. Add `certify --kind quick` and `--instance` on top of M06's case runner.
- [x] 2. Write the region clue and its degree edges.
- [x] 3. Write picture likeness and the image clue. Test the degree edges and the dropped masked crop.
- [x] 4. Add both clues to voting. Bump the engine version.
- [x] 5. Write the stripped-button test on the snapshot surface: no name, label, or text; region and image carry the vote.
- [x] 6. Check the renamed-button test still fails, and ties are still ambiguous.
- [ ] 7. Stop. Ask the owner to run the drill below.

**The drill (B1), for the owner:**

1. Restart the bank app with `KVFCU_STRIP_SEMANTICS=1`.
2. `intyy certify kvfcu/open_share_subaccount@1.0.0 --kind quick --instance strip_semantics=1`
3. Restart the bank app without the flag.
4. Publish the batch. If the image clue lost, the runs failed safely or escalated. Publish that too, with the vote lines.

## Test gate

### Automated (CI `check` job)

- [x] Clue voting: the stripped button wins; a renamed button fails; ties are ambiguous; evidence rules hold (section 7 §21).
- [x] Region and image degree edges.
- [x] A crop with a mask box in it is dropped. The target keeps its other clues.
- [x] A `quick` batch on the fake harness writes a plan and a report. A declared difference marks it a drill.
- [x] Determinism still holds: two runs, same trace.

### Live (`npm run test:live`)

- [ ] A `quick` batch on keystone, flag off, passes.

### Owner checks

- [ ] The drill ran. You read its vote lines and know which clues won.

## Evidence produced

- **B1:** the stripped-button `quick` batch, marked as a drill.

## Done when

- A button with no accessible name is still found, or refused safely, and the evidence shows why.
