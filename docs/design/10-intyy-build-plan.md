# intyy — Section 10: build plan

> **Status:** complete, 25 Sep 2026. The last design section.
> **Depends on:** sections 1 to 9, `CONTRACT.md` 1.1.0, the interface.ai brief.
> **Changes to sections 1 to 9:** `intyy-design-updates-from-section-10.md`.
> **The Claude Code package:** `CLAUDE.md`, `.claude/settings.json`, `.env.example`, `.gitignore`, `docs/milestones/README.md` and `M00` to `M12`, `docs/outlines/README-outline.md`, `docs/outlines/REPORT-outline.md`, `START-HERE.md`.
> **Level:** plan and package. Code appears only as short examples where a rule needs one.
> **Names:** app `kvfcu`, tenants `keystone` and `lakeshore`, staff `op_017`, `op_022`, `op_031`.

---

## Contents

1. [Purpose](#1-purpose)
2. [Principles for the build](#2-principles-for-the-build)
3. [New words](#3-new-words)
4. [Decisions in one view](#4-decisions-in-one-view)
5. [Code layout](#5-code-layout)
6. [The bank app and the design docs](#6-the-bank-app-and-the-design-docs)
7. [Milestones](#7-milestones)
8. [CI](#8-ci)
9. [What the library ships](#9-what-the-library-ships)
10. [Configuration](#10-configuration)
11. [Evidence plan](#11-evidence-plan)
12. [The cut line](#12-the-cut-line)
13. [Parked items, settled](#13-parked-items-settled)
14. [README and REPORT](#14-readme-and-report)
15. [How this meets the brief](#15-how-this-meets-the-brief)
16. [Rejected options](#16-rejected-options)
17. [After the take-home](#17-after-the-take-home)
18. [Terms used in this section](#18-terms-used-in-this-section)

---

## 1. Purpose

- **Sections 1 to 9 say what intyy is.** This section says how to build it, in what order, and what to show.
- **The reader is a coding agent** (Claude Code) working one milestone at a time, and the owner who reviews each gate.
- **Everything here is a decision.** Where a choice was open, this section picks one and says why.

---

## 2. Principles for the build

### 2.1 The thin slice comes first

- **Thin slice:** the brief's full thread, done simply. Goal, real discovery, artifact, replay with errors, handoff, evidence.
- **Nothing deeper starts** until the thin slice passes its gate (M07).
- **Why:** the brief says "cut depth, not whole capabilities." A polished half fails that test.

### 2.2 No gate, no next step

- **Each milestone ends with a test gate:** automated tests, live checks, and manual items.
- **The agent does not start the next milestone's work early.**
- **Why:** a coding agent moves fast. Gates stop fast mistakes from piling up.

### 2.3 Humans do the human acts

- **The owner runs real model runs, reviews candidates, seals, and approves.** The agent builds the tools.
- **The agent never seals or approves real library files.** Tests use temporary data roots.
- **Why:** intyy's trust model says only humans give trust. The build process follows the same rule.

### 2.4 Build in value order

- **Later milestones are the first to go** if time runs out. So the most valuable work comes first.
- **Why:** stopping at any milestone boundary from M07 on still leaves a complete, submittable repo.

---

## 3. New words

| Word | Meaning | Example |
|---|---|---|
| **Milestone** | One unit of build work with its own spec file and test gate | M05, replay core |
| **Phase** | A group of milestones. A is the thin slice, B is depth, C is the finish | Phase A: M00 to M07 |
| **Owner** | The person who reviews gates and plays every staff role | Plays `op_017` and `op_022` |
| **Structure check** | A test that fails when code imports something it must not | Replay code importing the harness port |
| **Pointer note** | A one-line note added under a design heading, pointing to a section 10 change | "> Changed by section 10: see updates §7.3" |
| **Evidence set** | A named group of runs and records to publish | Set A: the thin slice's proof |
| **Canary member** | A seed member reserved for leak tests. It must appear in no file intyy writes | Member `100240` |
| **Probe** | A drill that runs an approved recipe at another tenant, with no patch, to measure the gap | The lakeshore probe |
| **Cut line** | The ordered list of what to drop when time runs out | First: the lakeshore probe |

---

## 4. Decisions in one view

| Question | Decision | Why |
|---|---|---|
| One package or workspaces? | **One npm package, with folders** | Workspaces add build setup. Import rules give the same boundaries (5.3) |
| How are import rules enforced? | **dependency-cruiser rules, run as a Vitest test, plus two lint rules** | A check that never forgets. Section 9 §2.2 |
| Where does the bank app live? | **A sibling repo, pinned by commit. Never inside intyy's tree** | The agent must not read the app's source (6.1) |
| Where do design docs go? | **`docs/design/`, with the file names as they are** | Fewer broken references |
| Fold the update files first? | **Already done. Sections 1 to 9 are amended in place** | Every section header says so. Section 1 §26, §27 confirm |
| Section 10's own changes? | **Renames by script in M00. Pointer notes under each changed heading** | A reviewable git diff. The agent sees each change where it reads |
| Is M1 to M7 still right? | **No. Thirteen milestones, M00 to M12, in three phases** | Old M4 and M6 were too big for one gate (7.2) |
| Is M6 too big? | **Yes. Split into M09 models, M10 certify and approval, M11 live trust** | Each gets a gate a person can check in one sitting |
| Does the thin slice touch every core requirement? | **Yes, by M07** | Table 7.3 |
| Is approval a core requirement? | **No. It is stretch goal §8. The thin slice rejects unattended runs** | Push-back in 7.4 |
| `CLAUDE.md` length | **Under 150 lines. No `@imports` of design docs** | Official guidance: under 200 lines. Imports would load 600 KB each session |
| Package manager | **npm** | Reviewers already have it |
| Canary member | **Reserve seed member `100240`** | No wait on the bank app's owner (13.2) |
| Stripped-button demo | **Record with the flag off. Drill with it on. The crop carries the vote** | Tests replay, which is the point (13.3) |
| Restricted-user case | **Build, thin. A second env file, loaded in a subshell** | No code or format change (13.4) |
| Patch drafting | **Not built. Designed** | A third stretch goal. The brief says one or two |
| Lakeshore drill | **A probe with no patch, optional, last in M11** | Cheap once certify exists. Measures the gap honestly |
| Model key names | **`ANTHROPIC_API_KEY`, `JEV_API_KEY`** | The Anthropic SDK reads the first by default |
| Screen recording | **None** | Our own evidence rules ban video. Frames are not masked |
| The brief PDF | **Never committed** | It is interface.ai's document |

---

## 5. Code layout

### 5.1 One package, folders

- **One `package.json`, one `tsconfig.json`, one build.**
- **Boundaries come from rules,** not from package walls (5.3).
- **Why:** a coding agent handles one package well. Workspaces add project references, several builds, and slow feedback.

### 5.2 Folder tree

```
intyy/
  CLAUDE.md                    rules for every agent task
  README.md  REPORT.md         written at M07 (draft) and M12 (final)
  intyy.json                   data root marker (section 9 §6.1)
  bankapp.json                 the bank app's repo URL and pinned commit
  .env.example                 variable names only
  .claude/settings.json        blocks the agent from reading .env files
  package.json  tsconfig.json  vitest.config.ts  eslint.config.js  .dependency-cruiser.cjs  .nvmrc
  src/
    ports/                     interfaces only: surface.ts, hands.ts, models.ts, operator.ts,
                               harness.ts, secrets.ts, clock.ts, stores.ts, locks.ts,
                               outcome.ts, masked.ts, secret.ts
    core/
      model/                   Zod schemas for every file format, and the condition evaluator
      safety/
        gate/                  the only module that holds hands
        policy/                layers, merge, allowlist, path matcher
        risk/                  classes, words, roles, context rules
        secrets/               binding, start check, injection
        redaction/             the only module that makes Masked values
        canary/                the canary scanner
      orchestrator/            run lifecycle, frozen facts, run specs, pre-run checks
      discovery/               the LLM loop, observation builder, tools, prompts
      recorder/                log to candidate
      replay/                  executor, waits, clue voting, acting, prelude, reconciliation
      ladder/                  packs, merge, handlers, helper window, resume rule, rungs
      handoff/                 lease, interventions, capture, watchers, reverify
      certify/                 runner, route map, scorer, gate. The only core user of the harness
      trust/                   score records, approval, resolver, live scores, drift
      evidence/                publish and verify
    adapters/
      playwright/  claude/  jev/  mailbox/  kvfcu-harness/  env-secrets/  system/  files/
    fakes/                     one fake twin per port
    cli/
      main.ts                  entry point
      wiring.ts                the only place that picks adapters
      commands/<noun>.ts       one file per noun, plus discover, replay, certify, reconcile
      output.ts  exit-codes.ts  walks/
  tests/
    unit/  contract/  golden/  structure/  types/  live/  fixtures/
  schemas/                     generated JSON Schema files, committed
  library/                     reviewed files, in git (section 9 §6.2)
  state/                       runtime files, git-ignored (section 9 §6.3)
  evidence/                    published copies, in git (section 9 §6.6)
  demo/                        demo input files, fake values
  docs/
    design/                    sections 1 to 10, the updates file, CONTRACT.md
    milestones/                M00 to M12 specs
    outlines/                  README and REPORT outlines
    typescript-refresher.md    written in M00, grows with the code
    decisions.md               build-time decisions, one line each
  scripts/                     docs renames, bank app smoke check, evidence helpers
```

- **Prompts are TypeScript modules** in `core/discovery/prompts/`, one per version. Core may not read files.
- **`fakes/` sits outside `tests/`** because `--models off` and certify wire some twins at run time.

### 5.3 Import rules and how they are enforced

| Rule | Enforced by |
|---|---|
| `src/core/` imports no adapter, no CLI, no Playwright, no model SDK, no `node:fs`, no `node:child_process` | dependency-cruiser |
| Only `core/safety/gate/`, `adapters/playwright/`, and `fakes/` import `ports/hands.ts` | dependency-cruiser |
| Only `core/certify/`, `adapters/kvfcu-harness/`, and `fakes/` import `ports/harness.ts` | dependency-cruiser |
| Only `cli/wiring.ts` imports adapter modules | dependency-cruiser |
| Only `core/safety/redaction/` may write `as Masked<…>` | ESLint `no-restricted-syntax` |
| No `Date.now()`, `new Date()`, `Math.random()`, or `setTimeout` in `src/core/` | ESLint. Use the clock and ID ports |
| A raw string does not fit where `Masked` is required | Type tests in `tests/types/` |

- **The rules run as one Vitest test** (`tests/structure/imports.test.ts`), so `npm test` covers them.
- **A self-test proves each rule fires:** a fixture folder holds one bad import per rule. Each must fail.

**The wiring passes the surface to the gate unopened.** A short example of the pattern:

```ts
// src/ports/surface.ts: anyone may import this file.
/** An unopened surface. Other modules can pass it on. Only the gate can open it. */
export type SurfaceFactory = { readonly __surfaceFactory: unique symbol };

// src/ports/hands.ts: only the gate, the Playwright adapter, and fakes may import this file.
/** The real shape behind a SurfaceFactory. Opening it yields eyes and hands. */
export interface SurfaceSession {
  open(cfg: SessionConfig): Promise<Outcome<{ eyes: Eyes; hands: Hands }, "browser_failed" | "unreachable">>;
  close(): Promise<void>;
}
/** Why a cast: the brand has no runtime form. Only this file knows the real shape. */
export const toFactory = (s: SurfaceSession) => s as unknown as SurfaceFactory;
export const fromFactory = (f: SurfaceFactory) => f as unknown as SurfaceSession;
```

- **Why:** the CLI must create the Playwright adapter. With this pattern it cannot call `open()` and get hands.

### 5.4 Where tests live

| Folder | Holds | Vitest project |
|---|---|---|
| `tests/unit/` | Plain-code logic, mirroring `src/` | `unit` |
| `tests/contract/` | One suite per port, run against the real adapter and its fake | `unit` for files and fakes; `live` for Playwright and the kvfcu harness |
| `tests/golden/` | Same input, same bytes: recorder, score record, approval screen, drafts | `unit` |
| `tests/structure/` | Import rules and their self-test | `unit` |
| `tests/types/` | Compile-time checks (`*.test-d.ts`) | `types` |
| `tests/live/` | Anything that touches the local bank app | `live`, one file at a time |
| `tests/fixtures/` | Masked saved logs, screens, cassettes | — |

- **Why a separate `tests/` folder:** tests may import anything. Keeping them out of `src/` keeps the import rules simple.
- **The `live` project runs one file at a time** and takes the instance lock (CONTRACT §2).

### 5.5 Tools and versions

| Area | Choice | Note |
|---|---|---|
| Runtime | Node.js 24 LTS, ES modules | `.nvmrc` pins it |
| Language | TypeScript, strict, plus `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` | Locked (section 1 §15) |
| Browser | `playwright` as a library, Chromium | Not `@playwright/test`. Vitest runs the tests |
| Schemas | Zod 4 and its built-in JSON Schema export | One source for types, checks, and agent-facing schemas |
| CLI | `commander` | Typed, mature, small |
| Discovery and reviewer | `@anthropic-ai/sdk`, model `claude-sonnet-5` | Pinned per prompt version, frozen per run |
| jev | jev's TypeScript SDK | M09 first confirms its API. No guessing |
| Images | `pngjs` for pixels. Text tags drawn in an offline Playwright page | No native build step |
| Tests | Vitest, with projects `unit`, `types`, `live` | — |
| Rules | dependency-cruiser, ESLint with typescript-eslint, Prettier | — |
| Dev runner | `tsx` | Builds use `tsc` |
| `.env` loading | Node's `util.parseEnv`. Copies only keys not already set | No extra package. Lets a subshell override (13.4) |

- **No database, queue, server, or native build dependency.** A new dependency needs a line in `docs/decisions.md`.

### 5.6 Scripts

| Script | Does |
|---|---|
| `npm run build` | Compiles to `dist/`. `npm link` then puts `intyy` on the path |
| `npm run check` | Type check, lint, structure, `unit` and `types` tests, schema freshness |
| `npm test` | `unit` and `types` projects |
| `npm run test:live` | The `live` project. Fails loudly if the bank app is down |
| `npm run schemas` | Writes JSON Schema files to `schemas/` |
| `npm run bankapp:smoke` | Checks the bank app answers at its origin, with test mode on |
| `npm run docs:renames` | Applies the section 10 renames and pointer notes. `docs:verify` greps for leftovers |
| `npm run test:safety` | Runs the safety and canary tests. Writes `evidence/tests/safety.json` (M07) |

---

## 6. The bank app and the design docs

### 6.1 The bank app lives beside the repo

- **Folder:** `../kvfcu-bank`, next to `intyy/`. Its URL and commit sit in `bankapp.json`.
- **Never a submodule or subfolder.** A coding agent reads what is in its tree. The bank app must stay a black box.
- **The only allowed knowledge:** `docs/design/CONTRACT.md`, a pinned copy of version 1.1.0.
- **Reviewers clone both,** side by side. The README gives exact commands.
- **CI checks out the pinned commit** into its own workspace. The agent never works there.

### 6.2 Design docs

- **`docs/design/` holds** sections 1 to 9 (current names), this file, the updates file, and `CONTRACT.md`.
- **Not the brief PDF.** It belongs to interface.ai and the repo is public.
- **`CLAUDE.md` points to sections by path.** It never imports them. Each milestone spec names the exact sections to read.

### 6.3 Update files: already folded

- **Every section header says "amended in place"** for sections 3 to 9. Section 1 §21 to §27 list what changed and say "applied there".
- **So the section 8 and 9 update files are history.** Do not give them to the agent.
- **Section 10's changes** go in through M00: a rename script plus pointer notes (updates file §2, §14).
- **Precedence for the agent:** the section 10 updates file, then the topic's own section, then section 1.

---

## 7. Milestones

### 7.1 The list

| # | Name | Phase | Size | Gate in one line |
|---|---|---|---|---|
| M00 | Foundation | A | S | `npm run check` green; docs renamed; bank app smoke passes |
| M01 | Core seams | A | M | Stores seal and hash; four eyes; exit codes; locks; policy loosening fails |
| M02 | Surface and safety gate | A | L | Section 4 §14 tests pass; network guard blocks on the live app |
| M03 | Live discovery | A | M | Cassette loop passes in CI; a real `sign_in` run exists |
| M04 | Recorder and review | A | L | Recorder golden test; `sign_in@1.0.0` sealed from the real run |
| M05 | Replay core | A | L | Demo steps 4 and 5 live; task capabilities discovered and sealed |
| M06 | Error ladder, reconciliation, certify case | A | L | Fault table rows for rung 1 pass live; reply lost ends `found_by_check` |
| M07 | Handoff, publish, drafts | A | L | Live handoff; set A published; README and REPORT drafts. **Thin slice done** |
| M08 | Visual clue | B | S | Stripped button wins in CI; the drill is published |
| M09 | Models on the ladder | B | M | jev and reviewer paths pass with fakes; unknown pop-up case live |
| M10 | Certify and approval | B | L | `quick` batch in CI; three keys approved at keystone; unattended success |
| M11 | Live trust and drift | B | M | Window and streak rules demote; optional lakeshore probe |
| M12 | Final write-up and evidence | C | S | REPORT under 3 pages; fresh-clone test; `evidence verify` clean |

- **Sizes are relative:** S about half an M, L about twice an M.
- **Each spec lives in `docs/milestones/`,** with goal, reading list, deliverables, tasks, gate, and evidence.

### 7.2 Old plan to new plan

| Old (section 1 §17) | New | Why it changed |
|---|---|---|
| — | M00 | Setup, docs, and renames need their own gate |
| M1 Surface and safety | M01, M02 | Stores, CLI shell, and policy come before the surface and gate |
| M2 Live discovery | M03, plus task runs in M05 | Task discovery needs the `sign_in` prelude, which is replay |
| M3 Recorder and schema | M04 | Same |
| M4 Replay and rung 1 | M05, M06 | Too big for one gate |
| M5 Handoff | M07 | Also publishes evidence and drafts the write-up |
| Visual clue | M08 | Same |
| M6 jev, reviewer, certify | M09, M10, M11; `certify case` moves to M06 | Too big. Fault evidence needs `certify case` early |
| M7 Write-up and evidence | Drafts in M07, final in M12 | A submittable repo exists from M07 on |

**The dependency that forced the reorder:** task discovery starts after the `sign_in` prelude (section 6 §5). The prelude replays a sealed `sign_in`. So the chain is: discover `sign_in` (M03), seal it (M04), replay it (M05), then discover tasks (M05).

**Why `certify case` moves to M06:** faults must land at exact steps. Only the route map can place them (section 8 §6.4). The reply-lost and handoff evidence both need it.

### 7.3 The thin slice covers every core requirement

| Brief | Milestone |
|---|---|
| 3.1 Goal-driven agent loop | M03 (`sign_in`), M05 (task runs) |
| 3.2 Structured artifact | M04, M05 |
| 3.3 Replay and errors | M05 (success, outcomes, bad input), M06 (recoverable, hard failures, reconciliation) |
| 3.4 Safety | M01 (policy), M02 (gate, redaction), M05 (commit rules), M07 (publish canary scan) |
| 3.5 Evidence | M01 (evidence store), M02 (masked captures), M05 (failure captures) |
| 3.6 Handoff | M03 (approvals), M06 (requests), M07 (takeover of the live session) |
| 3.7 Heterogeneity (design) | M01 to M02 (ports with fakes), M07 (REPORT draft) |
| §6 README, REPORT, `/evidence/` | M07 drafts and set A; M12 final |

### 7.4 Push-back: stretch goals

- **The handoff said approval gating is core.** It is not. The brief lists it as stretch goal §8, "Confidence & approval."
- **Core 3.4 asks for conservative risky actions.** Authorization and the human yes cover that. Both are in the thin slice.
- **The thin slice still behaves correctly:** no score record means `draft`, so unattended requests are rejected (`context_not_approved`). This costs nothing.
- **The design now touches three stretch goals:** confidence and approval, multi-run stability, and assisted fallback (the reviewer is rung 3).
- **The brief says at most one or two.** So the REPORT claims two: confidence and approval, and multi-run stability.
- **Rung 3 is presented as part of the error ladder,** with the overlap stated plainly. Hiding it would look worse than naming it.
- **The build order keeps the core solid first.** M09 and M10 come after the thin slice, and both sit on the cut line.

### 7.5 Who does what

| Milestone | The agent builds | The owner does |
|---|---|---|
| M00 | Repo, tooling, docs script | Gives the bank app URL and commit. Reviews the rename diff |
| M01 | Stores, locks, CLI shell, policy and settings | Seals and approves the first policy and settings files |
| M02 | Surface adapter, gate, redaction | Checks the network guard on the live app |
| M03 | Discovery loop, mailbox approvals | **Writes the kvfcu app policy paths after a manual look.** Runs the real `sign_in` discovery |
| M04 | Recorder, candidate review, sealing | Reviews tags and risks. Seals `sign_in@1.0.0` |
| M05 | Replay engine | Writes task specs. Runs five real discoveries. Reviews and seals two artifacts |
| M06 | Ladder, packs, reconciliation, certify case | Captures fixtures. Reviews and seals packs, suite, test data, faults |
| M07 | Handoff, publish | Plays the operator in the live handoff. Publishes set A |
| M08 | Visual clue | Restarts the bank app with the strip flag. Runs the drill |
| M09 | jev and reviewer adapters | Gives the jev key. Runs the unknown pop-up case |
| M10 | Certify, scorer, approval, resolver | Runs three full batches. Approves as `op_022` |
| M11 | Live scores, drift | Runs the optional lakeshore probe |
| M12 | Final checks | Writes the final REPORT with the agent. Tests a fresh clone |

- **Why the owner writes app policy paths:** paths must come from the live app (CONTRACT, top). A manual look is how a real integration engineer starts.
- **The agent never probes the bank app's pages to learn them.** Library files may hold app knowledge from captured, masked screens. Source code never does.
- **The owner plays two staff IDs** for four eyes. The REPORT states this as a known limit of self-declared identity.

### 7.6 Pace and time box

- **Measure pace on M00 to M02.** Then set a time box for the rest.
- **If M07 is not done at 60% of the time box,** stop planning depth. Finish the thin slice and M12.
- **Why:** the design is large. The brief says the take-home should not take a month.

---

## 8. CI

| Job | Runs | Needs |
|---|---|---|
| `check` | Every push: `npm ci`, build, `npm run check` | Nothing live. No keys |
| `live` | Every push to `main`, and on demand: `npm run test:live` | The bank app at the pinned commit, test mode on, `KVFCU_DELAY_SCALE=0.1` |

- **CI never calls a live model.** Fake twins stand in (section 9 §5.9).
- **The `live` job writes throwaway teller credentials** into both `.env` files. No real secret exists.
- **The `live` job is one job,** so runs never overlap (CONTRACT §2).
- **If the bank app cannot run in CI,** `live` becomes a documented local step.
- **M00 decides from the owner's answers.** The owner says what `make up` needs. The agent never reads the bank app's repo.

---

## 9. What the library ships

| File | Made in | Sealed by, approved by |
|---|---|---|
| `staff.json`: `op_017` operator and reviewer on `*`; `op_022` operator and reviewer on `*`, approver at keystone and lakeshore; `op_031` approver on `*` | M01 | Git review. Not sealed |
| `policy/global/1.json` | M01 | `op_017`, `op_031` |
| `policy/tenant/keystone/1.json`: opts in `sign_in`, `find_account_by_reference`, `open_share_subaccount` | M01 | `op_017`, `op_022` |
| `settings/keystone/1.json`: origin `http://127.0.0.1:8080`, `environment: test`, app version `9.2`, `en-US`, `America/New_York`, secret bindings | M01 | `op_017`, `op_022` |
| `policy/app/kvfcu/1.json`: paths from the owner's manual look; harness path denied | M03 | `op_017`, `op_031` |
| `specs/kvfcu/sign_in.json` | M03 | Git review |
| `specs/kvfcu/find_account_by_reference.json`, `.not_found.json` | M05 | Git review |
| `specs/kvfcu/open_share_subaccount.json`, `.missing.json`, `.at_limit.json` | M05 | Git review |
| `candidates/kvfcu/…`: runs, decisions, regenerated candidates | M04, M05 | The audit trail of review |
| `artifacts/kvfcu/sign_in/1.0.0/` | M04 | `op_017`; second look `op_022` if a risk was lowered |
| `artifacts/kvfcu/find_account_by_reference/1.0.0/`, `open_share_subaccount/1.0.0/` | M05 | Same |
| `packs/global/1.json`, `packs/app/kvfcu/1.json` | M06 | `op_017`, `op_031` |
| `fixtures/kvfcu/…`: a `fire` and `no_fire` per handler | M06 | Git review |
| `suites/kvfcu/open_share_subaccount@1/1.json` | M06 | `op_017`, `op_031` |
| `testdata/keystone/kvfcu/1.json`: pools from CONTRACT §5, never `100240` | M06 | `op_017`, `op_022` |
| `faults/kvfcu/1.json`: the standard set of section 8 §6.3 | M06 | `op_017`, `op_031` |
| `thresholds/kvfcu/<jev_version>/1.json` | M09 | `op_017`, `op_031` |
| `suites/kvfcu/sign_in@1/1.json`, `suites/kvfcu/find_account_by_reference@1/1.json` | M10 | `op_017`, `op_031` |
| `majors/kvfcu/open_share_subaccount@1/1.json` | M11 | `op_017`, `op_031` |
| `settings/lakeshore/1.json`, `policy/tenant/lakeshore/1.json`, `testdata/lakeshore/kvfcu/1.json` | M11, only if the probe runs | `op_017`, `op_022` |

**Also in git, outside `library/`:**

- **`demo/valid.json`** (`100107`, `137.00`), **`demo/missing.json`** (`999001`), **`demo/at_limit.json`** (`100247`), **`demo/bad.json`** (a letter in the member number), **`demo/auth.json`** (a consent reference).
- **The short demo path** replays the shipped `open_share_subaccount@1.0.0`. No model key needed.

---

## 10. Configuration

### 10.1 `intyy.json`

```json
{
  "schema": "intyy.config/1.0",
  "library": "library",
  "state": "state",
  "publish": "evidence",
  "default_tenant": "keystone",
  "model_keys": { "claude": "ANTHROPIC_API_KEY", "jev": "JEV_API_KEY" },
  "canary_members": ["100240"]
}
```

- **`canary_members`** lists the reserved member numbers the canary scanner looks for (13.2).

### 10.2 intyy's `.env`

| Variable | Holds | Needed for |
|---|---|---|
| `ANTHROPIC_API_KEY` | Claude key | Discovery; the reviewer (M09) |
| `JEV_API_KEY` | jev key | Rung 2 (M09) |
| `INTYY_STAFF` | A staff ID from `staff.json` | Every command that writes |
| `INTYY_KEYSTONE_KVFCU_OPERATOR_USERNAME` | The teller's user name | Every run at keystone |
| `INTYY_KEYSTONE_KVFCU_OPERATOR_PASSWORD` | The teller's password | Same |
| `INTYY_KEYSTONE_REQUEST_INDEX_KEY_K1` | 64 hex characters, made once | The request index (section 4 §8.11) |

- **Names follow section 4 §8.3:** `INTYY_<TENANT>_<APP>_<NAME>`, bound explicitly in settings.
- **The secret names** are `operator_username` and `operator_password` (section 6 §6.4).
- **`.env.restricted`** holds the same two operator names with the restricted user's values (13.4).
- **Supervisor credentials are never bound.** A human types them during a takeover.

### 10.3 The bank app's `.env` (its own options, from CONTRACT §4)

| Option | Value for demos and evidence | Value for CI |
|---|---|---|
| `KVFCU_TEST_MODE` | `1` | `1` |
| `KVFCU_FIXED_DATE` | `2026-01-15` | `2026-01-15` |
| `KVFCU_VARIANT` | `keystone` | `keystone` |
| `KVFCU_DELAY_SCALE` | `1` | `0.1` |
| Teller, supervisor, restricted user names and passwords | Your choice | Throwaway values |

- **Published evidence uses delay scale 1.** Real delays are part of what it proves.
- **`make reset` in the bank app** gives clean data before a demo. Accounts opened stay until a reset.

---

## 11. Evidence plan

### 11.1 Sets and items

**Set A: the thin slice. Never cut. Published at M07.**

| ID | Item | Made by | Milestone | Shows |
|---|---|---|---|---|
| A1 | `sign_in` discovery run | `discover specs/kvfcu/sign_in.json` | M03 | 3.1: a real LLM run |
| A2 | `find_account_by_reference` discovery, positive and `not_found` | `discover …` twice | M05 | 3.1, the check capability |
| A3 | `open_share_subaccount` discovery: positive, with the irreversible approval in its mailbox; `member_not_found`; the at-limit outcome | `discover …` three times | M05 | 3.1, 3.2 outcomes, 3.4 |
| A4 | The three sealed artifacts, copied with their hashes | `evidence publish` | M04, M05 | 3.2 |
| A5 | Replay success, supervised | `replay … --inputs demo/valid.json` | M05 | 3.3 |
| A6 | Replay `member_not_found`, exit 2 | `replay … --inputs demo/missing.json` | M05 | 3.3, the brief's "replay that hits an error" |
| A7 | Replay at the limit: `business_outcome`, commit `refused` | `replay … --inputs demo/at_limit.json` | M05 | An outcome on the commit step |
| A8 | Reply lost: `success`, `found_by_check`, through a child run | `certify case … --profile reply_lost` | M06 | The hardest runtime case |
| A9 | Session expiry recovered by the `sign_in` handler | `certify case … --profile session_expire --at @step:<id>` | M06 | A recoverable condition |
| A10 | Restricted user: `failed`, `permission_denied` | `replay` in a subshell with `.env.restricted` | M06 | A permission denial |
| A11 | Live handoff: supervisor approval in the same browser | `certify case … --profile supervisor_needed --operator mailbox` | M07 | 3.6 |
| A12 | Safety and canary test report, as JSON | `npm run test:safety` | M07 | 3.4 |

**Set B: depth. Published if built.**

| ID | Item | Milestone | Shows |
|---|---|---|---|
| B1 | Stripped-button `quick` batch, a drill | M08 | Voting with no accessible name |
| B2 | Unknown pop-up handled by rungs 2 and 3 | M09 | The model rungs, bounded |
| B3 | Full batch reports and trust snapshots for the three keys | M10 | Confidence, approval, stability |
| B4 | Unattended replay: rejected before approval, `success` after | M10 | Draft to approved gating |
| B5 | Lakeshore probe, a drill | M11 | The cross-tenant gap, measured |

- **Minimum for the brief:** A1, A3, A4, A5, A6. Set A adds the rest.
- **A10's result depends on the app.** If the button is hidden from restricted users, the run escalates instead. Publish what happens and say so.

### 11.2 Layout of `/evidence/`

```
evidence/
  README.md                         index: item, what it shows, brief requirement, path, command
  manifest.json                     intyy.publish/1.0
  artifacts/kvfcu/<cap>/<version>/  copies of the sealed artifacts the runs used
  keystone/
    runs/<run_id>/                  mirrors state/evidence
    batches/<batch_id>/             plan.json, report.json
  trust/scores/keystone/…           trust snapshots: history.jsonl, record.json
  tests/safety.json                 A12
```

- **`evidence/README.md` is written by hand at M07,** and updated at M12.
- **Folder names `artifacts`, `trust`, and `tests` are reserved.** No tenant may use them.

### 11.3 Size and regeneration

- **Budget:** 60 MB for all of `/evidence/`. `evidence publish` warns above it.
- **Discovery runs publish in full,** including `llm/`. They are the heart of the brief.
- **Batches publish plan, report, and every run whose verdict is not `pass`** (section 9 §6.6).
- **Passing batch runs stay out.** `certify rerun <batch> <case>` reproduces any case from its seed.
- **Discovery cannot be regenerated byte for byte.** A model run differs each time. The published run is the proof.

### 11.4 Honesty labels

- **Runs before M09 have rungs 2 and 3 off.** Their frozen `ladder` facts say so. The evidence README says it once.
- **Drills are marked in their plans.** B1 and B5 are never approval-grade.
- **One person played every staff ID.** The evidence README says so.

---

## 12. The cut line

**Rule:** cut in this order. Stop cutting as soon as time allows.

| # | Cut | Milestone | What remains |
|---|---|---|---|
| 1 | Lakeshore probe (B5) | M11 | The REPORT describes the drill |
| 2 | Major records, pack regression batches, reconciliation autonomy | M11 | Designed. The REPORT says so |
| 3 | Drift reader, alerts, early warnings | M11 | The two demotion rules |
| 4 | Live scores and demotion | M11 | M11 gone. Approval still gates unattended runs |
| 5 | The guided walk for `trust approve` | M10 | Flags do the same job |
| 6 | Tuned timeouts | M10 | Artifact defaults |
| 7 | Stability curve and twin runs | M10 | One stretch goal claimed, not two |
| 8 | Full certify and approval | M10 | `certify case` stays. Unattended stays rejected |
| 9 | The reviewer LLM, rung 3 | M09 | Rung 2 climbs straight to a human |
| 10 | jev, rung 2 | M09 | Rung 1 plus a human. Safe, and slower for operators |
| 11 | The stripped-button drill (B1) | M08 | The visual clue and its CI test |
| 12 | The visual clue | M08 | DOM and accessibility clues only |

**Never cut:** M00 to M07 and M12. That is the brief's thread, `README.md`, `REPORT.md`, and evidence set A.

- **The order is the build order, reversed.** Tasks inside M10 and M11 are ordered so the cuttable ones come last.

---

## 13. Parked items, settled

### 13.1 Renames

- **Mechanical renames** across sections 1 to 9: `sparrow-core` to `kvfcu`, `bank_a` to `keystone`, `bank_b` to `lakeshore`, and more.
- **US examples replace Indian ones** in redaction: kinds, detectors, label words, money formats, names.
- **The full table** is in the updates file §2 and §3. M00 applies it by script and checks by grep.

### 13.2 Canary member

- **Decision:** seed member `100240` is the canary. It is valid, with room for sub-accounts (CONTRACT §5).
- **Rules:** it never appears in specs, test data pools, suites, demo files, fixtures, or docs examples.
- **The canary test** replays `open_share_subaccount` for `100240`. Then it scans every file intyy wrote.
- **It scans for** `100240`, and for the account and confirmation numbers the run returned in memory.
- **`evidence publish` scans** for `100240` and every secret value bound in settings, read in memory.
- **Known false alarm:** a JSON number like `"duration_ms": 100240` would match. It refuses the publish loudly. Re-run and publish again.
- **Why not wait for a contract change:** the build should not block on another party. A request is still sent (updates §13).

### 13.3 Stripped-button demo

- **Decision:** record once with `KVFCU_STRIP_SEMANTICS` off. Replay with it on. The recorded crop must carry the vote.
- **Why:** the demo proves replay survives a lost accessible name. Re-recording with the flag on would prove discovery instead.
- **Run as:** `certify kvfcu/open_share_subaccount@1.0.0 --kind quick --instance strip_semantics=1`, a drill.
- **If the image clue loses,** the run fails safely or escalates. Publish it anyway, with the vote lines. The REPORT says what happened.

### 13.4 Restricted-user case

- **Decision:** build it, thin. No code and no format change.
- **How:** `.env.restricted` binds the same two secret names to the restricted user's values.
- **Run it in a subshell,** so no value lands on the command line:
  `(set -a; . ./.env.restricted; set +a; intyy replay kvfcu/open_share_subaccount@1 --mode supervised --inputs demo/valid.json)`
- **This works because** intyy loads `.env` without overriding variables already set (5.5).
- **The `permission_denied` handler's `fire` fixture** comes from this run's screen (M06).

### 13.5 Patch drafting and the lakeshore drill

- **Patch drafting: not built.** It would be a third stretch goal (7.4). Section 8 §13.4 stays the design.
- **Tenant patches: format built, merge designed.** M04 builds the `intyy.patch/1.0` schema and loader checks. No merge, no patch commands.
- **Lakeshore probe: optional, last in M11.** Certify keystone's approved key at lakeshore, as a drill, with no patch.
- **It shows** which clues differ and whether margins hold. The REPORT uses it for §4, heterogeneity.
- **First on the cut line.**

### 13.6 Certify and trust milestones

- **M10, certify and approval:** score store, full batches, scorer, gate, approval, resolver, pre-run check 7, stability, tuned timeouts.
- **M11, live trust and drift:** live scores, demotion rules, drift reader, alerts, majors, pack regression, autonomy, the probe.
- **Gates:** section 8 §18, split by what each milestone builds. The M10 and M11 specs list the rows.

### 13.7 What the library ships

- **See section 9 of this file.** Three sealed artifacts from real runs, their candidates, packs, suites, test data, fault profiles, policy, settings, staff.

### 13.8 Model key names and `.env.example`

- **See 10.1 and 10.2.** The package includes `.env.example`.

### 13.9 What to publish

- **See section 11.**

---

## 14. README and REPORT

- **Outlines** live in `docs/outlines/`. The agent drafts both at M07 from them. The owner edits.
- **README:** setup for a cold reader, both repos, keys, running without live services, the demo path, the handoff demo.
- **REPORT:** the brief's seven headings, exactly, in order. About 1,700 words, under 3 pages.
- **The REPORT argues decisions.** Details stay in `docs/design/`, linked by section.

---

## 15. How this meets the brief

| Brief asks | Where |
|---|---|
| §5 A complete vertical slice touching every core requirement | 7.3; M00 to M07 |
| §5 Cut depth, not whole capabilities; say what you cut | 2.1, 12 |
| §6 `/README.md` with setup, keys, running without live services, demo path | 14; `docs/outlines/README-outline.md` |
| §6 `/REPORT.md` with seven headings, 1 to 3 pages | 14; `docs/outlines/REPORT-outline.md` |
| §6 `/evidence/`: artifact, discovery and replay logs, one error replay | 11; set A |
| §4 The discovery run must be real | A1 to A3 |
| §8 Pick at most one or two stretch goals | 7.4 |
| §9 Keep secrets out of the repo | 10.2, `.claude/settings.json`, canary scans |
| §9 Do not automate sites against their terms | The local bank app only; the NCUA link never followed |

---

## 16. Rejected options

| Option | Why rejected |
|---|---|
| npm workspaces per layer | Build overhead for an agent. Import rules give the same walls |
| The bank app as a submodule or subfolder | The agent would read its source. CONTRACT must stay the only truth |
| Rewriting sections 1 to 9 in this chat | The folds are done. Renames by script give a diff the owner can review |
| `@import` of design docs in `CLAUDE.md` | Loads 600 KB every session. Adherence drops as the file grows |
| One milestone for jev, reviewer, certify, and trust | No single sitting can check that gate |
| Task discovery before replay exists | The prelude needs replay. Discovery would have to fake sign-in |
| pnpm | One more install for every reviewer |
| Tests next to source files | Import rules would need many exceptions |
| Building patch drafting and a patched lakeshore drill | A third stretch goal. The brief asks for one or two |
| Claiming rung 3 without naming the overlap | Reviewers would see "assisted fallback" anyway |
| Waiting for a canary member in the contract | Blocks the build on another party |
| Re-recording with stripped buttons | Would test discovery, not replay robustness |
| A new tenant for the restricted user | Tenants are banks. A second env file is honest and free |
| Publishing every batch run | Size. Passing runs regenerate from their seeds |
| A screen recording | Our own rules ban video. Frames are not masked |
| Committing the brief PDF | Not ours to publish |
| The agent learning app paths by probing | Breaks "intyy's code never hardcodes the app." A human looks, then writes policy |

---

## 17. After the take-home

Not designed here. Listed so nobody builds them by accident.

- Service host with an API, the delivery window, and a catalog adapter (MCP or HTTP).
- Identity provider, lock service, vault source, signed authorization tokens.
- Bank settings certify target, as a format change.
- Remote operator console, desktop adapter, vision-driven discovery.
- Patch drafting, and a patched lakeshore drill.

---

## 18. Terms used in this section

| Term | Meaning |
|---|---|
| Milestone | One unit of build work with a spec and a test gate |
| Phase | A: thin slice. B: depth. C: finish |
| Thin slice | The brief's full thread, done simply |
| Owner | The person who reviews gates and plays every staff role |
| Structure check | A test that fails on a forbidden import |
| Pointer note | A one-line note under a design heading, pointing to a section 10 change |
| Evidence set | A named group of runs and records to publish |
| Canary member | Seed member `100240`, reserved for leak tests |
| Probe | A drill of an approved recipe at another tenant, with no patch |
| Cut line | The ordered list of what to drop first |
| SurfaceFactory | An unopened surface. Only the gate can open it |
