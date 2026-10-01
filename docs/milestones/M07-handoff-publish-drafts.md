# M07 — Handoff, publish, drafts

> **Phase:** A · **Size:** L · **Depends on:** M06 · **Status:** in progress

## Read first

- Section 7 §2.4, §2.5 (principles), §12 (control lease), §13 (intervention request, all), §14 (human action capture), §15 (watchers), §16 (handback and reverify), §17 (crash and restart), §20 (worked example: supervisor approval), §21 (tests).
- Section 6 §10.5 (takeover during discovery).
- Section 5 §12 (learned handlers: drafts from takeovers).
- Section 4 §7.10 (humans during a takeover), §8.10 (human typing), §14 (how the canary scans work).
- Section 9 §6.6 (publishing evidence), §10.4, §10.5 (operator commands, mailbox), §13 (demo path).
- Updates file §11.1 (`--operator mailbox`), §12 (publish extras).
- Build plan §11 (evidence plan), §14 (README and REPORT).
- `docs/outlines/README-outline.md`, `docs/outlines/REPORT-outline.md`.
- `docs/formats/a11y-snapshot.md` (the accessibility snapshot that draft handlers and their `fire` fixtures read; built in M02).

## Goal

A human takes over the live browser session and hands it back, set A is published, and the repo can be submitted.

## Why now

- **Handoff is the last core requirement** (brief §3.6). It completes the thin slice.
- **From here on, stopping at any milestone boundary still leaves a complete submission** (build plan §2.4).

## Delivers

### Code

- **`src/core/handoff/`:**
  - The lease: `bot`, `human`, `nobody`, with transitions and tokens. Bot actions are refused unless the lease is `bot`.
  - Claims: explicit (`operator claim`) and implicit (human input from the replay's staff ID).
  - Human input while the bot drives pauses the run: takeover reason `unexpected_human_input`.
  - Capture of human clicks and typing, through the same redaction. Native dialogs answered by `operator dialog`.
  - Watchers on the commit step's checkpoint while a human drives.
  - Handback: reverify, forward search, "the human moved past the outputs", reverify failed.
  - Draft handlers from takeovers (`intyy.handler_draft/1.0`).
- **Takeover during discovery** (section 6 §10.5).
- **The crash sweep:** every row of section 7 §17.
- **`certify case --operator mailbox`:** interventions go to the real mailbox. A human answers from another terminal.
- **`src/core/evidence/`:** publish and verify, with the extras of updates file §12.
  - Copies each run's sealed artifact after a hash check.
  - Scans for `canary_members` and every secret value bound in settings, in memory. One hit refuses.
  - Warns above 60 MB. Writes `manifest.json`.
- **`npm run test:safety`:** runs the safety and canary tests and writes `evidence/tests/safety.json`.

### Commands

- `operator claim | release | dialog`, and `operator decide` for takeovers.
- `certify case … --operator scripted|mailbox`.
- `evidence publish | verify`.
- `pack draft list | show` for drafts from takeovers. Review and accept stay in M09 or later.

### Files

| File | Agent | Owner |
|---|---|---|
| `README.md` | Drafts it from the outline | Edits, then runs every command in it |
| `REPORT.md` | Drafts it from the outline | Edits. Owns every claim in it |
| `evidence/README.md` | Drafts the index table from build plan §11 | Checks each row against the files |

## Not in this milestone

- A remote operator console. Designed only (section 7 §19).
- Accepting draft handlers into packs.
- Anything in phase B.

## Tasks, in order

- [x] 1. Write the lease and its tests: a stale token is blocked; no human-to-bot shortcut; human input pauses the bot.
- [x] 2. Write claims, `operator claim | release | dialog`, and takeover decisions. Test exclusive claims and two claimers.
- [x] 3. Write capture and watchers.
- [x] 4. Write handback, reverify, and forward search. Test: credits finished fills only; stops at `read` steps; needs `confirmed` to cross the commit.
- [x] 5. Write the handoff test: a scripted "human" takes over, acts, and hands back.
- [x] 6. Write draft handlers from takeovers, with a golden test.
- [x] 7. Write takeover during discovery.
- [x] 8. Finish the crash sweep. Test each row of section 7 §17.
- [ ] 9. Add `--operator mailbox` to `certify case`.
- [ ] 10. Write `evidence publish | verify` and `npm run test:safety`.
- [ ] 11. Stop. Ask the owner to run the live handoff (A11) with two terminals.
- [ ] 12. Draft `README.md`, `REPORT.md`, and `evidence/README.md` from the outlines.
- [ ] 13. Stop. Ask the owner to publish set A, run `evidence verify`, and tag `v0.1-thin-slice`.

**The live handoff (A11), for the owner:**

1. Terminal 1: `intyy certify case kvfcu/open_share_subaccount@1.0.0 --class valid --profile supervisor_needed --operator mailbox`
2. Terminal 2: `intyy operator list`, then `intyy operator claim <run_id>`.
3. In the visible browser, do the supervisor approval. Type the supervisor's credentials yourself.
4. Terminal 2: `intyy operator release <run_id> --note "Supervisor approved."`
5. Terminal 1 prints the result: `success`, commit `confirmed`, one intervention.

## Test gate

### Automated (CI `check` job)

- [ ] Lease, mailbox, handoff, forward search, crash sweep (section 7 §21).
- [ ] Mailbox: exclusive claim; a second claimer exits 6; atomic writes; `closed.json` on each ending.
- [ ] Draft golden test: a saved takeover log always gives the same draft handler.
- [ ] Evidence publish: a canary hit refuses; links resolve; artifact copies match their hashes; the manifest is written.
- [ ] Secret canary and member canary still pass. The known-limit test still runs, marked expected.

### Live (`npm run test:live`)

- [ ] The handoff test on the bank app, with the scripted "human".
- [ ] `certify case … --profile supervisor_needed` with the scripted operator ends with the expected escalation.

### Owner checks

- [ ] A11 ran as above. The mailbox shows the claim, the release, and the captured human actions, masked.
- [ ] `intyy evidence verify` is clean on the published set A.
- [ ] You ran every README command once, from the top.
- [ ] `REPORT.md` has the brief's seven headings, in order.

## Evidence produced

- **A11:** the live handoff run, with its mailbox.
- **A12:** `evidence/tests/safety.json`.
- **Set A, published:** A1 to A12, with `evidence/README.md` and `manifest.json`.

## Done when

- **The thin slice is done.** Every core requirement of brief §3 has working code and published evidence.
- The repo is submittable as it stands. Tag `v0.1-thin-slice`.
