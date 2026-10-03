# Repo audit, 2026-10-02

This audit checks the repo against the brief, the design, `CONTRACT.md`, the milestone specs, and `CLAUDE.md`. It ran after M12.

Terms:
- **safe** means no behavior change, and no sealed or published file is touched.
- **owner** means anything else. Only the owner approves and does these.

Precedence: the brief, then the section 10 updates file, then the topic's own section, then section 1.

## Findings

| ID | Area | Kind | Where | Rule broken | Proposed fix | Class | Result |
|---|---|---|---|---|---|---|---|
| E1 | E | missing | `README.md:14` ("What you need") | Task area E: link the bank app for its own needs | Link "kvfcu" to the bank app repo | safe | fixed `da7d5f7` |
| E2 | E/C | dangling | `README.md:24` `git clone <intyy repo URL> intyy` | Brief §6.1: exact setup commands. A placeholder breaks step 1 | Use `https://github.com/burpcat/intyy.git`, the repo's `origin` | safe | fixed `da7d5f7` |
| E3 | E | missing | `REPORT.md:24`, the first mention of kvfcu | Task area E: one link where the test target is first named | Link it to the bank app repo, with commit `3652883` | safe | fixed by owner-tasks `f4e56cf` |
| E4 | E | missing | `evidence/README.md` intro | Task area E: evidence names the repo and commit it ran against | Add one line naming the repo and commit `3652883e…` | owner (hashed) | fixed by owner-tasks `98e747a` |
| E5 | E/C | dangling | `docs/outlines/README-outline.md:33` `<bank app repo URL>` | Task area C: no placeholders | Use the real URL | safe | fixed `da7d5f7` |
| A1 | A | deviation | `REPORT.md`, 1,735 words (about 3.5 pages) | Brief §6.2: "~1–3 pages" | Trim about 250 words, mostly from Cuts and Safety | owner | fixed by owner-tasks `f4e56cf`: 1,626 words |
| A2 | A | dangling | `evidence/README.md:35`, the Set A row says "pending" | Brief §6.3. The index says only verified items stay | Owner runs `intyy evidence publish`, then `verify`, then flips the row | owner | fixed by owner-tasks `98e747a`: row `published`, verify clean |
| A3 | A | scope creep | `REPORT.md:43`, "`capability describe --format tool` exports it as a tool definition" | Brief §8: at most one or two stretch goals. REPORT claims two. This line reads like a third, the capability interface | Mark it "not claimed as a stretch goal", or cut it | safe | fixed by owner-tasks `f4e56cf`: "built as tooling, not claimed" |
| B1 | B | deviation | `docs/built-and-cut.md:3,9,30,42` and the cut table | Its own header, "State on 2026-10-01". It says no REPORT, evidence holds only a README, one sealed artifact, jev not built, packs not drafted. All five are false now | Re-date the file and correct the five claims | safe | fixed `3ed9a5c`, `dcaadc0` |
| B2 | B | conflict | `src/core/model/run.ts` `DiscoveryRunJson` vs section 3 §7.3 | Discovery `run.json` lacks `parent_run_id`, `batch_id`, `request_id`, `result`, `frozen`, `files`, `retention`. It adds `spec`, `code`, `started_at`, `ended_at`, `counts`. The code cites an owner decision of 2026-09-29 that `decisions.md` does not hold | One `decisions.md` line. No schema change | owner | fixed `55978b5`: decision line |
| B3 | B | deviation | `docs/milestones/M08-visual-clue.md`, Delivers: "with `pngjs`" | `decisions.md` chose `node:zlib`. The code follows the decision | Correct the spec text | safe | fixed `01189bf` |
| B4 | B | missing | `library/majors/` is absent | M11 Delivers: `majors/kvfcu/open_share_subaccount@1/1.json` | Owner seals it, or drops the row | owner | rejected: major records are optional, none was needed |
| B5 | B | deviation | M05 and M10 specs list `find_account_by_reference` | `decisions.md` dropped it | Annotate the rows "dropped, see decisions.md" | safe | fixed `01189bf` |
| B6 | B | scope creep | `library/specs/kvfcu/count_member_subaccounts.json`, `library/suites/kvfcu/count_member_subaccounts@1/1.candidate.json` | Build plan §9 does not name them. The capability was never sealed | Delete both, or keep them and log a decision | owner | fixed `55978b5`, `0f66180`: kept, never sealed, decision line |
| B7 | B | scope creep | `library/drafts/packs/*`, `library/drafts/policy/app-kvfcu-rev5.json`, `library/drafts/suites/open_share_subaccount-rev2.json` | Section 9 §6.2 names only `drafts/handlers` and `drafts/patches` | Keep them and log a decision, or delete them | owner | fixed `55978b5`: kept, decision line |
| B8 | B | conflict | `docs/decisions.md` M08 entry vs M10 entry and `src/cli/commands/certify.ts` | The M08 entry says `certify` without `--kind` means `full`, "not built". M10 built `full` as the default | Add a line that marks the M08 entry superseded | safe | fixed `e2e564c` |
| B9 | B | conflict | `docs/decisions.md` M10 entries | One entry says a waiver is never a direct review choice. `open_share_subaccount@1.0.3` carries a waiver | Add a line that marks the waiver as the recorded exception | safe | no change needed: the 2026-10-01 M05 line on cited waivers allows it |
| B10 | B | deviation | Build plan §5.2 layout vs the tree | It names `core/ladder/`, `cli/walks/`, `tests/golden/`. The tree has `core/replay/ladder.ts`, no walks, `tests/fixtures/golden/`. It also has extra core folders, CLI files, scripts, and `docs/formats/` | One `decisions.md` line listing the differences | owner | fixed `55978b5`: decision line |
| B11 | B | conflict | CLI: `candidate new`, `thresholds edit\|check\|seal\|approve`, `major seal\|approve` | Section 9 §14 does not name them. They come from M09, M11, and `decisions.md` | One `decisions.md` line mapping each command to its source | owner | fixed `0f66180`: README names `candidate new` |
| B12 | B | dangling | `docs/milestones/M12-final-write-up.md:52,69,70,71` unticked | Owner steps: stop and ask, fresh-clone test, defend sections, public repo and tag | Owner does them | owner | blocked: owner steps. The fresh-clone box is ticked (`7f29f07`) |
| B13 | B | conflict | `docs/decisions.md` M09 entry "No threshold record is drafted in `library/` yet" | `library/thresholds/kvfcu/jev-1.13.0/1.json` exists now | Add a superseding line | safe | fixed `e2e564c` |
| C1 | C | dangling | Tracked docs cite `CLAUDE.md` and `START-HERE.md`. `.gitignore:17-18` keeps both out of git | A reviewer's clone holds references to files it lacks | Track `CLAUDE.md`, or accept the references | owner | fixed `55978b5`: decision line, ignored on purpose |
| C2 | C | dangling | `.gitignore:16` comment `# bs` | Code style: plain words | Rename the comment | safe | fixed `ee75f9a` |
| C3 | C | dangling | `docs/handoff.md`, `docs/owner-tasks.md` are untracked | Task area C | Commit them or ignore them. Other sessions own them | owner | rejected: the owner never commits these files |
| C4 | C | missing | `.env.example` lacks `INTYY_AGENT`, read at `src/cli/commands/replay.ts:341` | Task area C: every env var in code is in `.env.example` | Add a commented line | safe | fixed `048c280` |
| N1 | A | deviation | `README.md` full path, step 6 and the reconciliation note | They named the unsealed `count_member_subaccounts@1` check and expected commit `found_by_check`. `1.0.3` uses a cited waiver, and A8 shows `escalated`, `reconciliation_waived`, commit `uncertain` | Describe the cited-waiver path. Keep the check JSON for apps with a readable check | safe | fixed `0f66180` |

## Checked and clean

- **E:** the README clone command uses the bank app repo and the folder `kvfcu-bank`. The checkout uses the pinned commit. `bankapp.json` holds the repo, commit, contract, and origin.
- **A:** REPORT has the seven headings in brief order. Their "1." to "7." numbers mirror the brief's own list. README covers setup, keys, running without live services, and the demo. Each requirement §3.1 to §3.7 maps to code and evidence. No secrets are tracked.
- **B:** the artifact's ten top-level blocks match section 2. The result envelope and status variants match section 3 §5.1. The request matches section 3 §4.1. Each Zod schema has a file in `schemas/`. No milestone "Not in" item exists. A spot check of 30 decisions found no other contradiction.
- **C:** no TODO, FIXME, or HACK markers. No `.skip` or `.only`. No debug prints or commented-out code in `src/`. Nothing in `src/` imports `tests/`. No runtime state is tracked. `npm run docs:verify` passes. The candidate unused exports are all used.
- **D:** the safety, canary, and evidence tests pass: 171 pass, 1 expected fail. `npm run audit` is clean. Only the harness adapter, its fake, and `scripts/bankapp-smoke.ts` call `/__test__/`. Every policy revision denies it. No code names the footer link host, and the allowlist rejects any other origin. The canary member appears only in design docs, `intyy.json`, config, and tests.

## Summary

Counts: missing 5, deviation 5, conflict 5, scope creep 3, dangling 7. Total 25: 13 safe, 12 owner.

Top five risks:
1. E2: the README's first setup command holds a placeholder URL. A fresh-clone reviewer fails at step 1.
2. A1: REPORT runs about 3.5 pages. The brief asks for about 1 to 3.
3. B1: `docs/built-and-cut.md` says no REPORT exists and jev is not built. The repo contradicts itself.
4. E3 and E4: REPORT and the evidence index do not name the bank app repo or commit.
5. A2: the evidence Set A manifest and verify row is still "pending".

## Results (2026-10-02)

Found during the fixes: N1. Total 26 rows.
- **Fixed:** 22. 17 by this audit, 5 by the owner-tasks session on REPORT and evidence.
- **No change needed:** 1 (B9).
- **Rejected:** 2 (B4, C3).
- **Blocked on the owner:** 1 (B12).

Note: B3 and B5 edited `docs/milestones/` before the owner-tasks session asked that nobody edit it. Revert `01189bf` if the specs must stay as written.

Final checks on branch `audit-2026`:
- `npm run check` passes.
- `npm run test:safety`: 172 passed, 0 failed, 1 expected failure. Only the `generated_at` time in `evidence/tests/safety.json` changed, so that file was reverted.
- `intyy evidence verify`: clean, 105 items, 792 files. This run had no `.env`, so it scanned no secret values. The owner-tasks run was clean too.
- `npm run test:live`: not run here. The live tests read the bank login from `.env`, and agents never read it. The owner runs it. This branch changes no code.
