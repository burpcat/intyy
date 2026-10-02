# M12 — Final write-up and evidence

> **Phase:** C · **Size:** S · **Depends on:** M07, plus whatever phase B finished · **Status:** in progress

## Read first

- Build plan §7.4 (stretch goals claimed), §11 (evidence plan), §12 (the cut line), §14 (README and REPORT), §15 (how this meets the brief).
- `docs/outlines/README-outline.md`, `docs/outlines/REPORT-outline.md`.
- The current `README.md`, `REPORT.md`, and `evidence/README.md`.
- `docs/decisions.md`, all of it.

## Goal

A cold reader can clone, run, and understand the submission, and every claim in the write-up points to evidence.

## Why now

- **It is last,** so the write-up describes what was really built.
- **It is never cut.** A strong build with a weak write-up fails the brief's communication test.

## Delivers

### Files

| File | Agent | Owner |
|---|---|---|
| `REPORT.md` | Updates the M07 draft: built versus cut, phase B results, honest limits | Edits to final. Under 3 pages. Owns every claim |
| `README.md` | Updates commands and the evidence list | Runs every command from a fresh clone |
| `evidence/README.md` | Adds set B rows that exist. Removes rows for cut items | Checks each row |

### Checks

- **`evidence verify`** is clean on the final `/evidence/`.
- **The fresh-clone test:** both repos cloned side by side into an empty folder, then the README followed word for word.
- **A repo audit:** no brief PDF, no `.env`, no `state/`, no trace files in git history.

## Not in this milestone

- New features. If a gap appears, write it under "Cuts" in `REPORT.md`.
- Sending the submission email. The owner does it (brief §11).

## Tasks, in order

- [x] 1. List what was built, per milestone, from the specs' ticked boxes. List every cut item from build plan §12 that was not built.
- [x] 2. Update `REPORT.md` from the outline. Keep the brief's seven headings, exactly, in order.
- [x] 3. Check each REPORT claim links to code, a design section, or an evidence item. Remove any claim without one.
- [x] 4. Check the stretch goals claimed match what was built. Claim at most two. Name the rung 3 overlap.
- [x] 5. Update `README.md`: exact commands, the short and full demo paths, the handoff demo, running without live services.
- [x] 6. Update `evidence/README.md`. Stop. Ask the owner to publish set B items that exist.
- [x] 7. Run `intyy evidence verify`. Fix any problem it reports by republishing, never by editing evidence.
- [x] 8. Write the repo audit as a script in `scripts/`. Run it.
- [ ] 9. Stop. Ask the owner to run the fresh-clone test and read the final REPORT aloud once.

## Test gate

### Automated (CI `check` job)

- [x] `npm run check` is green on `main`. (2026-10-02: 1457 tests, 1 expected fail, audit clean)
- [x] `intyy evidence verify` is clean.
- [x] The repo audit script passes.

### Live (`npm run test:live`)

- [x] The full live suite passes on the pinned bank app commit. (2026-10-02: 15 files, 69 tests, bank at 3652883e)

### Owner checks

- [x] `REPORT.md` is under 3 pages, with the seven headings in order.
- [ ] The fresh-clone test worked from the README alone, including the short demo path with no model key.
- [ ] You can explain and defend every section of the REPORT (brief §9).
- [ ] The repo is public. Tag `v1.0`.

## Evidence produced

- **The final `/evidence/`:** set A, set B items built, `evidence/README.md`, `manifest.json`.

## Done when

- The submission runs from a fresh clone, reads clearly in under 3 pages, and proves each claim.
