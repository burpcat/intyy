# intyy — Section 9: interfaces

> **Status:** complete, 25 Sep 2026.
> **Formats defined:** `intyy.config/1.0` (root file), `intyy.staff/1.0`, `intyy.index/1.0` (store index lines), `intyy.lock/1.0`, `intyy.claim/1.0`, `intyy.release/1.0`, `intyy.decision/1.0`, `intyy.effect_update/1.0`, `intyy.publish/1.0`.
> **Depends on:** sections 1 to 8, `CONTRACT.md` 1.1.0.
> **Used by:** section 10.
> **Changes to sections 1 to 8:** `intyy-design-updates-from-section-9.md`.
> **Level:** interfaces and behavior. Port shapes use short TypeScript-like sketches. They are not code.
> **Names in examples:** app `kvfcu`, tenants `keystone` and `lakeshore`, staff `op_017` (reviewer) and `op_022` (approver).

---

## Contents

1. [Purpose](#1-purpose)
2. [Design principles](#2-design-principles)
3. [New words](#3-new-words)
4. [Interfaces in one view](#4-interfaces-in-one-view)
5. [Ports](#5-ports)
6. [Data root and file locations](#6-data-root-and-file-locations)
7. [The CLI](#7-the-cli)
8. [Authoring commands](#8-authoring-commands)
9. [Trust commands](#9-trust-commands)
10. [Run commands](#10-run-commands)
11. [Capability catalog](#11-capability-catalog)
12. [Locks](#12-locks)
13. [Demo path and runs without live services](#13-demo-path-and-runs-without-live-services)
14. [Command reference](#14-command-reference)
15. [Worked example: from goal to unattended replay](#15-worked-example-from-goal-to-unattended-replay)
16. [Tests that prove it](#16-tests-that-prove-it)
17. [How this meets the brief](#17-how-this-meets-the-brief)
18. [Rejected options](#18-rejected-options)
19. [Items parked for other sections](#19-items-parked-for-other-sections)
20. [Terms used in this section](#20-terms-used-in-this-section)

---

## 1. Purpose

- **Sections 2 to 8 designed data and behavior.** This section designs the seams around them.
- **Three kinds of seam:**
  - **Ports:** how the core talks to browsers, models, humans, the harness, and files.
  - **Files:** where every store, evidence folder, lock, and mailbox lives.
  - **Commands:** how staff and callers drive intyy from a terminal.
- **Brief 3.7 asks for a clear seam** between "how we perceive and act" and "the recorded flow." The surface port is that seam.

---

## 2. Design principles

### 2.1 The core sees ports, never tools

- **The core knows no browser, model, or file format.** It calls ports.
- **Adapters implement ports.** Playwright, Claude, jev, and plain files are adapters.
- **The CLI wires adapters to ports at start-up.** Nothing else chooses an adapter.
- **Why:** a desktop surface or a database is a new adapter. The core does not change (section 1 §4).

### 2.2 Structure enforces safety, not discipline

- **The gate holds the only hands.** No other module can act on a screen (5.2).
- **Models and logs accept masked data only.** A raw value does not fit the type (5.1).
- **Replay code cannot import the harness.** A CI test checks it (section 8 §6.5).
- **Why:** a rule that depends on every developer remembering it will fail. A type or an import check does not forget.

### 2.3 Expected trouble is a value; a bug is an error

- **A port returns its expected failures as values.** Example: the connection closed.
- **Only bugs throw.** A thrown error ends the run as `internal_error`.
- **Why:** section 3 separates "nothing happened" from "something broke." Ports keep that line from the bottom up.

### 2.4 Every command is scriptable

- **Every decision has a flag form.** Interactive screens are a thin shell over the same commands.
- **Why:** tests, CI, and certify need no human at the keyboard. Humans still get a guided walk.

### 2.5 Nothing sensitive on the command line or on disk

- **Input values come from a file or standard input.** Never from flags.
- **Raw outputs print only to an interactive terminal** (section 4 §9.14).
- **Why:** flags land in shell history and process lists. Other users on the machine can read both.

### 2.6 Humans review files; the CLI guards the rules

- **Everything a human reviews and seals lives in git,** as plain files.
- **The CLI checks roles, four eyes, schemas, and loader rules** before it writes.
- **Why:** git gives review and history for free. The CLI stops a bad file before it lands.

### 2.7 One machine, plain files, named seams to scale

- **Locks, mailboxes, and indexes are files** on one machine.
- **Each has a named replacement at scale:** a lock service, a web console, a database.
- **Why:** the brief rewards a small, correct system and warns against infrastructure (brief §7).

---

## 3. New words

| Word | Meaning | Example |
|---|---|---|
| **Port** | An interface the core calls to reach the outside | The surface port |
| **Adapter** | Code that implements a port for one tool | The Playwright adapter |
| **Fake twin** | An adapter for tests that needs no live tool | A snapshot surface that answers from saved screens |
| **Wiring** | Choosing adapters for ports when the CLI starts | `--models off` wires no jev and no reviewer |
| **Eyes** | The read-only half of the surface port | Observe the screen, take a screenshot |
| **Hands** | The acting half of the surface port. Only the gate holds it | Click, type, navigate |
| **Masked value** | A value that went through redaction. Models and logs accept only these | `[pii]`, `{input.member_id}` |
| **Outcome** | A port's answer: a value, or a named expected failure | `{ ok: false, failure: "connection_closed" }` |
| **Library** | The folder of reviewed files, in git | Artifacts, packs, policy |
| **State** | The folder of runtime files, outside git | Scores, evidence, locks |
| **Store index** | A per-store log of seals and approvals, with content hashes | `library/artifacts/index.jsonl` |
| **Key notation** | A short way to write a key on the command line | `kvfcu/open_share_subaccount@1.0.0+p3` |
| **Publish** | Copy chosen runs and records from state into the repo's `/evidence/` | Publish the reply-lost run |
| **Exclusive origin** | A bank app address that allows one run at a time | The local test bank app (CONTRACT §2) |
| **Staff file** | The reviewed list of staff IDs and their roles per tenant | `library/staff.json` |

---

## 4. Interfaces in one view

| Layer | Holds | Built now |
|---|---|---|
| **Entry** | The `intyy` CLI. It wires adapters to ports | One process per command |
| **Core** | Orchestrator, discovery, recorder, replay, ladder, handoff, certify, scorer, drift reader, and the gate | All plain code |
| **Ports** | Surface (eyes and hands), planner, classifier, reviewer, operator, harness, secrets, clock and IDs, stores, locks | Interfaces plus contract tests |
| **Adapters** | Playwright, Claude, jev, mailbox, kvfcu harness, environment variables, system clock, plain files | Each with a fake twin |

- **One process per command** in the build. A replay command hosts its run until the run ends (10.2).
- **The operator talks to a run through files,** from another terminal (10.4).
- **Designed only:** a service host that runs many runs and serves an API. It reuses the same core and ports.

---

## 5. Ports

### 5.1 Rules for every port

**Shape:**

```ts
/** A port's answer. Expected trouble is a value. Bugs throw. */
type Outcome<T, F extends string> =
  | { ok: true; value: T }
  | { ok: false; failure: F; detail?: string };  // detail is masked text
```

- **Every operation is async** and takes an abort signal.
- **Time limits live in the core,** not in adapters. Section 7 §8 limits stay in one place.
- **Each port lists its failure names.** The core maps each one to a failure code or a ladder event.
- **Inputs and outputs are Zod types.** The same schemas validate files and messages.

**Masked values:**

```ts
/** A branded type. Only the redaction module can make one. */
type Masked<T> = T & { readonly __masked: unique symbol };
```

- **Model ports and the evidence store accept `Masked` data only.** Raw data is a type error.
- **Why a type:** section 4 masks at write time. The type makes "forgot to mask" fail to compile.

**Secrets:**

- **A `Secret` is an opaque object.** It prints as `[secret]`.
- **Only the hands adapter and the keyed-hash function can open it.**

**Contract tests:**

- **Each port has one test suite.** It runs against the real adapter and the fake twin.
- **Why:** a fake that behaves unlike the real tool makes every other test lie.

### 5.2 Surface port: eyes and hands

**Job:** perceive and act on one live session. This is brief 3.7's seam.

**Split in two:**

| Half | Holds | Given to |
|---|---|---|
| **Eyes** | Observe, screenshot, snapshots, crops, events | Engine, watchers, recorder, scorer |
| **Hands** | Act | The gate only |

- **The gate is the only module that receives hands.** A CI test checks that no other module imports the hands type.
- **So "every action crosses the gate" is true by construction** (section 1 §4).
- **The executor, ladder, handlers, and reviewer** call `gate.act(...)`. The gate checks, then acts.

**Session:**

```ts
interface SurfaceSession {
  /** Opens a fresh session with the network guard already set. */
  open(cfg: {
    origin: string; allowlist: Allowlist; viewport: Viewport;
    locale: string; timeZone: string; visible: boolean;
  }): Promise<Outcome<{ eyes: Eyes; hands: Hands }, "browser_failed" | "unreachable">>;
  close(): Promise<void>;
}
```

- **The network guard lives in the adapter,** because only the adapter sees every request.
- **A contract test proves it blocks** an outside host and a denied path.

**Eyes:**

```ts
interface Eyes {
  /** Every element of the active page and its frames, with clues and state. */
  observe(): Promise<Outcome<Observation, "page_gone">>;
  screenshot(): Promise<Outcome<Png, "page_gone">>;             // raw; the core masks it
  snapshots(): Promise<Outcome<{ dom: string; a11y: string }, "page_gone">>;
  crop(el: ElementRef): Promise<Outcome<Png, "stale_element">>;
  /** Navigation, requests, page changes, dialogs, pop-ups, human input, transport trouble. */
  events(): AsyncIterable<SurfaceEvent>;
}
```

| `Observation` holds | Notes |
|---|---|
| Location path, active page, open pop-ups | Section 7 §9.2 |
| Elements: role, role group, clues, state, box | Section 7 §6.1 |
| A native dialog as elements | Section 7 §9.1 |
| Field state | Values of secret-filled fields report `filled: true` only |

| `SurfaceEvent` | Used by |
|---|---|
| `navigation_started`, `navigation_done` | Settle (section 7 §5.1) |
| `request_started`, `request_done` | Quiet. Static files excluded |
| `page_changed` | Condition waits |
| `dialog_opened`, `dialog_closed`, `popup_opened`, `popup_closed` | Active page |
| `human_input` | Capture and lease (section 7 §12.4, §14). Raw value in memory only |
| `connection_closed`, `browser_error_page` | Transport failures (section 7 §7.3) |
| `network_blocked` | The guard's log line |

- **`ElementRef` is valid until the next page change.** A stale reference returns `stale_element`. The core votes again.
- **Picture likeness stays in the core.** Eyes return pixels. Plain code compares them.

**Hands:**

```ts
interface Hands {
  /** Performs one resolved action. Secrets arrive as opaque values. */
  act(a: ResolvedAction, lease: LeaseToken): Promise<Outcome<ActResult, "stale_element">>;
}
type ActResult = {
  dispatched: true | false | "unknown";                              // section 7 §7.2
  transport?: "connection_closed" | "browser_error_page" | "navigation_timeout";
};
```

- **A transport failure is part of the answer,** not a thrown error. The ladder decides what it means.
- **Answering a native dialog** is a click on its Accept or Dismiss element. No extra operation.

**Other surfaces (designed only):**

| Surface | Eyes | Hands | `path` clue |
|---|---|---|---|
| Legacy web | Same Playwright adapter | Same | Frame-aware DOM path |
| Desktop | OS accessibility tree | OS input events | Accessibility path |
| No tree at all | Screen pixels plus a vision model | OS input at coordinates | None. `region` and `image` carry the vote |

- **Artifacts, clues, and role groups stay the same.** Only the adapter changes.
- **The desktop network guard** becomes an allowed-program list. Designed only.

### 5.3 Model ports: planner, classifier, reviewer

**Three ports, one per job:**

```ts
interface Planner {                 // discovery LLM (section 6)
  next(turn: Masked<PlannerTurn>): Promise<Outcome<PlannerReply, ModelFailure>>;
}
interface Classifier {              // jev (section 5 §10)
  trouble(input: Masked<JevTroubleInput>): Promise<Outcome<JevTroubleOutput, ModelFailure>>;
  reconcile(input: Masked<JevReconcileInput>): Promise<Outcome<JevReconcileOutput, ModelFailure>>;
}
interface Reviewer {                // reviewer LLM (section 5 §11)
  fixStep(input: Masked<ReviewerInput>): Promise<Outcome<ReviewerOutput, ModelFailure>>;
  secondOpinion(input: Masked<JevReconcileInput>): Promise<Outcome<JevReconcileOutput, ModelFailure>>;
}
type ModelFailure = "timeout" | "unavailable" | "refused" | "invalid_output";
```

- **Why three ports, not one:** each job has its own input, output, fake, and failure rule. One generic port would hide those.
- **The core owns prompt text and output schemas,** by prompt version. The adapter owns the provider's API.
- **A different model may need a new prompt version.** Both are frozen per run (section 3 §6.5).

**Every call is written before it is sent:**

1. **The core serializes the masked input once.**
2. **It writes those bytes to `llm/`** through the evidence store.
3. **It passes the same bytes to the adapter.**
4. **It writes the reply** the same way.

- **So the stored copy is the sent copy** (section 3 §7.1). A write failure stops the call.

**Failures:**

| Port | On a `ModelFailure` |
|---|---|
| Classifier | `needs_review`, confidence 0 (section 5 §10.7) |
| Reviewer | Takeover, `stuck` |
| Planner | One retry. Then the run fails with new code `model_unavailable`, transient |

### 5.4 Operator port

**Job:** carry intervention requests to humans, and their answers back.

```ts
interface OperatorPort {
  open(req: Masked<Intervention>): Promise<Outcome<Handle, "write_failed">>;
  /** The next claim, release, decision, or dialog answer. The core owns the deadline. */
  next(h: Handle): Promise<Outcome<OperatorEvent, "closed">>;
  close(h: Handle, how: "resolved" | "timed_out" | "run_ended"): Promise<void>;
}
type OperatorEvent =
  | { kind: "claimed"; staff: string; implicit: boolean }
  | { kind: "released"; staff: string; note?: string }
  | { kind: "decided"; staff: string; decision: string; outcome?: string; note?: string }
  | { kind: "dialog"; staff: string; answer: "accept" | "dismiss" };
```

| Adapter | Used by |
|---|---|
| Mailbox | Every real run. Files in the run folder (10.5) |
| Scripted | Certify (section 8 §7.6); the handoff test |
| Fake | Unit tests |

- **The terminal prompt is not an adapter.** It is a mailbox client, like `intyy operator`. Both write the same files.
- **Deadlines use the clock port** in the core. Adapters never time out a human.

### 5.5 Harness port

Operations from section 8 §6.5, with their shapes:

```ts
interface Harness {
  features(): Promise<Outcome<Set<HarnessFeature>, "unreachable">>;
  reset(): Promise<Outcome<void, HarnessFailure>>;
  setChaos(c: { entropy?: number; seed?: string }): Promise<Outcome<void, HarnessFailure>>;
  addFaults(f: NamedFault[]): Promise<Outcome<void, HarnessFailure>>;
  clearFaults(): Promise<Outcome<void, HarnessFailure>>;
  faultLog(): Promise<Outcome<FaultLogEntry[], HarnessFailure>>;
  /** Raw notes text in memory only. The scorer stores match results, never values. */
  oracle(notes: Secret): Promise<Outcome<OracleAnswer, HarnessFailure>>;
  setClock(date: string | null): Promise<Outcome<void, HarnessFailure>>;
}
type HarnessFailure = "unsupported" | "unreachable" | "rejected";
```

- **The kvfcu adapter speaks plain HTTP from Node,** to the settings origin. Never through the browser.
- **`features` probes the fault log endpoint.** A 404 means test mode is off: no features (CONTRACT §4).
- **The adapter refuses** unless the app's settings say `environment: test`.

### 5.6 Secret port

```ts
interface Secrets {
  resolve(b: SecretBinding): Promise<Outcome<Secret, "missing">>;
}
```

- **Built source:** environment variables (section 4 §8.3). **Designed:** the bank's vault.
- **Used by:** the start check, injection at act time, and the request index key.

### 5.7 Clock and ID port

```ts
interface Clock { now(): Date; after(ms: number): Promise<void>; }
interface Ids { runId(): string; batchId(): string; leaseToken(): string; alertId(): string; }
```

- **Waits still end on state** (section 7 §2.1). Timers serve polls and deadlines only.
- **Fakes:** a clock that moves only when a test says so, and seeded IDs. Golden tests need both.

### 5.8 Store ports

**Four shapes, typed per record kind:**

| Shape | Behavior | Record kinds |
|---|---|---|
| **Document store** | Candidate, then sealed revision. Some also approved in-file | Artifacts, patches, packs, policy layers, settings, suites, test data sets, fault profile sets, threshold records, major records |
| **Candidate store** | A folder per artifact candidate: linked runs, decisions, regenerated files | Artifact candidates |
| **Log store** | Append-only lines, plus records rebuilt from them | Score history and live lines, alerts, evidence indexes, the request index |
| **Evidence store** | Run folders and batch folders. Masked data only | Runs, batches, mailboxes |

```ts
interface DocumentStore<T> {
  get(id: DocId, rev: Rev): Promise<Outcome<Sealed<T>, "not_found" | "hash_mismatch">>;
  list(filter: DocFilter): Promise<DocSummary[]>;
  putCandidate(id: DocId, doc: T, staff: string): Promise<Outcome<void, "invalid" | "conflict">>;
  seal(id: DocId, staff: string): Promise<Outcome<{ rev: Rev; hash: string }, "invalid" | "rule">>;
  approve(id: DocId, rev: Rev, staff: string): Promise<Outcome<void, "rule">>;
}
```

- **One implementation per shape.** A Zod schema per record kind types it.
- **Why not one store per kind:** ten kinds would repeat the same file logic ten times.
- **Why not one store for all:** sealing, appending, and run folders behave differently.
- **`rule` failures** carry the rule's name: four eyes, role, missing second look, failed regression.

**Evidence store extras:**

- **`appendEvent(line, { durable: true })`** forces the line to disk. The commit write-ahead rule needs it (section 3 §6.6).
- **A failed write** returns `write_failed`. The run maps it to `evidence_write_failed`.

**Locks** have their own small port: `acquire`, `release`, `inspect` (section 12).

### 5.9 Fake twins

| Port | Real adapter in the build | Fake twin |
|---|---|---|
| Surface | Playwright, visible Chromium | Snapshot surface: answers from fixtures and scripted screen graphs (section 5 §13.2) |
| Planner | Claude Sonnet 5 | Cassette: replays masked replies from a saved discovery run, turn by turn |
| Classifier | jev | Table: answers by fault style or by input hash |
| Reviewer | Claude Sonnet 5 | Table |
| Operator | Mailbox | Scripted |
| Harness | kvfcu over HTTP | In memory, with a fault log and an oracle |
| Secrets | Environment variables | A map |
| Clock, IDs | System | Manual clock, seeded IDs |
| Stores, locks | Plain files | In memory. Contract tests also run the file adapters in a temporary folder |

- **The cassette stops the test loudly** when an observation differs from the recorded one. It never guesses.
- **Why a cassette for the planner only:** it tests the discovery loop in CI with a real model's replies. jev and the reviewer need exact answers per case, so tables fit better.
- **No cassette for the surface.** Timing changes screens. Fixtures and the local bank app cover it.

---

## 6. Data root and file locations

### 6.1 Two parts: library and state

> **Changed by section 10:** model_keys fixed; canary_members added. See `intyy-design-updates-from-section-10.md` §12.

| Part | Holds | In git? | Why |
|---|---|---|---|
| **Library** | Everything a human reviews and seals | Yes | Review and history for free (principle 2.6) |
| **State** | Scores, evidence, locks, mailboxes, the request index | No | Runtime data. It grows with every run |

- **The root file `intyy.json`** marks the data root. The CLI walks up from the current folder to find it. `--root` overrides.

```json
{
  "schema": "intyy.config/1.0",
  "library": "library",
  "state": "state",
  "publish": "evidence",
  "default_tenant": "keystone",
  "model_keys": { "claude": "ANTHROPIC_API_KEY", "jev": "JEV_API_KEY" }
}
```

- **`model_keys` names environment variables,** never values. Variable names here are placeholders; section 10 fixes them.

### 6.2 Library layout

```
library/
  staff.json                                         staff IDs and roles (7.7)
  specs/<app>/<spec_name>.json                       run specs (section 6 §6)
  candidates/<app>/<capability>/<candidate_id>/
    runs.json                                        linked discovery runs, positive and negative
    decisions.jsonl                                  review decisions, append only
    candidate.json                                   regenerated after each decision. Never hand-edited
    issues.json                                      regenerated review issues
  artifacts/<app>/<capability>/<version>/
    artifact.json
    crops/<target_id>.png
  artifacts/index.jsonl
  patches/<tenant>/<app>/<capability>@<major>/<rev>.json
  packs/global/<rev>.json
  packs/app/<app>/<rev>.json
  packs/app_version/<app>/<pattern>/<rev>.json      "*" becomes "x" in the folder name: 9.x
  packs/tenant/<tenant>/<app>/<rev>.json
  fixtures/<app>/<fixture_id>/                       meta.json, a11y.yaml, dom.html, screen.png
  drafts/handlers/<app>/<draft_id>/                  draft.json plus its fixture folder
  drafts/patches/<tenant>/<app>/<capability>@<major>/<draft_id>.json
  policy/global/<rev>.json
  policy/app/<app>/<rev>.json
  policy/tenant/<tenant>/<rev>.json
  settings/<tenant>/<rev>.json
  suites/<app>/<capability>@<major>/<rev>.json
  testdata/<tenant>/<app>/<rev>.json
  faults/<app>/<rev>.json
  thresholds/<app>/<jev_version>/<rev>.json
  majors/<app>/<capability>@<major>/<rev>.json
```

- **Each store folder has its own `index.jsonl`** (6.4).
- **A candidate revision** is `<rev>.candidate.json`. Sealing renames it to `<rev>.json`.
- **Folder names never decide meaning.** The file's own fields do. The loader checks that both agree.
- **Why fixtures sit per app:** fixture IDs are shared across packs (section 5 §13.1).

### 6.3 State layout

```
state/
  trust/
    scores/<tenant>/<app>/<capability>@<version>/<app_version>/<patch>/
      history.jsonl  live.jsonl  record.json         section 8 §5.2. <patch> is "base" or "p3"
    alerts/<tenant>.jsonl
  evidence/
    <tenant>/index.jsonl                             one line per run status change
    <tenant>/runs/<run_id>/                          section 3 §7.1, plus mailbox/ (10.5)
    <tenant>/batches/<batch_id>/                     plan.json, report.json
  var/
    locks/runs/<run_id>.lock
    locks/instances/<origin_key>.lock
    locks/scores/<tenant>.lock
    request-index/<tenant>.jsonl                     keyed hashes only (section 4 §8.11)
    tmp/                                             staging for atomic writes
```

- **The evidence root moves** from the repo's `/evidence/` to `state/evidence/`. The repo's `/evidence/` gets published copies (6.6).
- **The trust store moves out of git** during work. Its files stay plain and reviewable. Published snapshots go to `/evidence/`.
- **Why:** hundreds of dev runs and thousands of live lines would bury the reviewer. Publishing picks what matters.

### 6.4 Store indexes and sealing

**One index line per seal or approval** (`intyy.index/1.0`):

```json
{ "event": "sealed", "kind": "artifact", "id": "kvfcu/open_share_subaccount", "rev": "1.0.0",
  "path": "kvfcu/open_share_subaccount/1.0.0/artifact.json", "hash": "sha256:9c1e…",
  "by": "op_017", "at": "2026-09-26T08:00:00Z" }
```

- **The hash covers the file without its `approved` block.** Approval stamps a sealed file. It does not change its content.
- **Approving writes the `approved` block once,** and appends an `approved` index line. The block never changes again.
- **The loader checks the hash** on every read. A mismatch stops the load loudly.
- **Why one index per store, not one for all:** packs and artifacts have different reviewers. Smaller files, fewer merge conflicts.

**Four eyes on every approved-in-file document:**

- **The approver is never the sealer.** Packs, policy layers, settings, suites, test data sets, fault profile sets, threshold and major records.
- **Section 8 set this rule for keys.** This section extends it to every approval. Same reason: nobody trusts their own work into production.

### 6.5 What goes in git

| Folder | In git | Notes |
|---|---|---|
| `library/` | Yes | Reviewed through pull requests and the CLI |
| `state/` | No | Listed in `.gitignore` |
| `evidence/` | Yes | Published copies only |
| `.env` | No | Secret values. `.env.example` lists names only |

### 6.6 Publishing evidence

> **Changed by section 10:** Publish copies artifacts, places trust snapshots, warns on size. See `intyy-design-updates-from-section-10.md` §12.

**Job:** copy chosen runs and records into the repo's `/evidence/`, safely.

```
intyy evidence publish <run_id | batch_id | key> … [--with-runs all]
```

| Publishing a… | Copies |
|---|---|
| Run | Its folder, its mailbox, and every linked run: parent, children, setup runs |
| Batch | `plan.json`, `report.json`, and every run whose verdict is not `pass`. `--with-runs all` copies all |
| Key | A trust snapshot: `history.jsonl`, `record.json`, and the plan and report of each batch its history names |

**Before copying, the command checks:**

1. **Each `run.json` hash** against the tenant index.
2. **A canary scan:** the secret canary and the member canary (section 1 §16) must appear nowhere. Any hit refuses the whole publish.
3. **Links resolve:** every run and batch a published file names is published too.

- **It writes `evidence/manifest.json`** (`intyy.publish/1.0`): what, by whom, when, and source hashes.
- **The layout mirrors `state/evidence/`,** so paths inside `run.json` still work.
- **Which runs to publish:** section 10.

---

## 7. The CLI

### 7.1 Command grammar

**One rule: a command that opens a browser is a top-level verb. Everything else is a noun, then a verb.**

| Top-level verbs | Opens a browser for |
|---|---|
| `discover` | A discovery run |
| `replay` | A replay run |
| `certify` | A certify batch |
| `reconcile` | A manual reconciliation check |

| Nouns | Manage |
|---|---|
| `spec`, `candidate`, `artifact`, `patch`, `pack`, `fixture` | Recipes and handlers |
| `policy`, `settings`, `suite`, `testdata`, `faults` | Rules, facts, and certify inputs |
| `trust`, `major`, `alert`, `drift`, `jev`, `tags` | Trust and drift |
| `run`, `operator`, `evidence`, `capability`, `staff` | Runs, humans, publishing, the catalog |

**Verbs mean the same thing on every noun:**

| Verb | Means |
|---|---|
| `list`, `show` | Read only |
| `new`, `edit` | Make or change a candidate. `edit` opens `$EDITOR`, then validates |
| `check` | Validate a candidate. Writes nothing |
| `seal` | Freeze a candidate. Reviewer role |
| `second-look` | Confirm a lowered risk flag. Another reviewer |
| `approve` | Stamp a sealed revision. Approver role, not the sealer |

- **Why this rule:** the four run verbs are what a reader of the README types. Everything else groups by what it manages.

### 7.2 Key notation

```
kvfcu/open_share_subaccount@1.0.0         no patch
kvfcu/open_share_subaccount@1.0.0+p3      patch revision 3
kvfcu/open_share_subaccount@1             a caller's name: the major only
```

- **The tenant comes from `--tenant`.** The app version comes from that tenant's settings. `--app-version` overrides for reading.
- **Why they are not in the notation:** they are context, not recipe. The same notation works at every bank.

### 7.3 Global flags

> **Changed by section 10:** The CLI loads .env without overriding set variables. See `intyy-design-updates-from-section-10.md` §12.

| Flag | Meaning | Default |
|---|---|---|
| `--root <dir>` | Data root | The nearest `intyy.json` |
| `--tenant <id>` | Which bank | `default_tenant` in `intyy.json` |
| `--staff <id>` | Who runs the command | `INTYY_STAFF` |
| `--json` | Print one JSON document on standard output | Off |
| `--reveal-outputs` | Print raw sensitive outputs when output is not a terminal | Off. Rules below |
| `--models off` | Run with jev and the reviewer switched off | Models on |

**`--reveal-outputs` (section 4 §9.14):**

- **Only on `replay` and `reconcile`.**
- **Only when the app's settings say `environment: test`,** and the origin is loopback. Otherwise the command refuses.
- **A warning goes to standard error.** The run log records `outputs_revealed: true`, never the values.
- **On a terminal it changes nothing.** Raw outputs already print there.

**`--models off`:**

- **Only on `replay`, `certify`, and `reconcile`.** Discovery needs its model.
- **It can only switch rungs off,** like a policy layer. It is frozen in `ladder` and logged.
- **A certify batch run with it is a drill.** It did not test the ladder that live runs use.

### 7.4 Output rules

| Stream | Carries |
|---|---|
| **Standard output** | The command's answer only |
| **Standard error** | Progress, warnings, and errors. Always masked by the text rules |

| Output goes to | Answer format | Raw sensitive outputs |
|---|---|---|
| A terminal | Human text | Printed. This is the delivery (section 3 §5.13) |
| A pipe or file | Human text, or JSON with `--json` | Masked, unless `--reveal-outputs` |

- **`--json` prints exactly one document.** For runs, it is the result contract (section 3 §5).
- **Why JSON only on request:** piping into `less` should not surprise anyone. Scripts ask for JSON.
- **Progress lines** follow the run log: one short line per step, ladder rung, or intervention.

### 7.5 Exit codes

| Code | Meaning |
|---|---|
| 0 | Done. For runs: `success`. For certify: gate passed or batch complete |
| 1 | Usage error, or intyy failed to produce an answer |
| 2 | Run ended in `business_outcome` |
| 3 | Run not final: `running` or `escalated` (`run status` only) |
| 4 | Run `rejected` |
| 5 | Run `failed`, or a certify gate failed |
| 6 | Refused by a rule: role, four eyes, second look, freshness, a changed record |
| 7 | A file failed its schema or loader checks |
| 8 | Busy: a lock is held |

- **Why a business outcome is not 0:** a script that ignores it would treat "no such member" as success. `grep` sets the same example: no match is a valid answer, and not 0.
- **Why codes never overlap:** a script can branch on the number alone.

### 7.6 Interactive and scripted

- **Every command works with flags alone.** No prompt appears when input is not a terminal.
- **A few commands also offer a guided walk on a terminal:** `candidate review`, `trust approve`, `pack draft review`.
- **The walk issues the same commands** as the flags. Tests cover the flags; the walk adds nothing new.
- **A missing required flag with no terminal** exits 1 and names the flag.

### 7.7 Identity: staff and callers

**The staff file** (`library/staff.json`, `intyy.staff/1.0`):

```json
{
  "schema": "intyy.staff/1.0",
  "staff": [
    { "id": "op_017", "roles": { "*": ["operator", "reviewer"] } },
    { "id": "op_022", "roles": { "keystone": ["approver"], "lakeshore": ["approver"], "*": ["operator"] } },
    { "id": "op_031", "roles": { "*": ["approver"] } }
  ]
}
```

- **Roles per tenant.** `*` means every tenant.
- **Shared documents need the role on `*`:** global and app policy; global, app, and app-version packs; suites; fault profile sets; threshold and major records.
- **Changes go through git review,** not the CLI. The loader checks each tenant has at least one approver.
- **Known limit:** in the build, identity is self-declared (update file, section 4). **Designed:** the bank's identity provider.

**Who runs a command:**

| Identity | From | Needed by |
|---|---|---|
| Staff | `--staff` or `INTYY_STAFF` | Every command that writes, and supervised runs |
| Caller | `--agent` or `INTYY_AGENT`, plus the tenant | `replay` only. Default `cli:<staff>` |

- **Unattended replay may run with no staff ID.** Then human input cannot claim implicitly. A takeover waits for `operator claim`.
- **Implicit claims** (section 7 §12.4) use the replay process's staff ID.

### 7.8 Every command starts with a sweep

- **Each command first sweeps for crashed runs** (section 7 §17). It reads the tenant index and the run locks.
- **It takes well under a second.** It prints one line only when it closed a run.
- **Example:** "Closed 1 crashed run. 1 needs a manual reconcile. See `intyy run sweep`."

---

## 8. Authoring commands

### 8.1 Run specs and discovery

| Command | Does | Role |
|---|---|---|
| `spec new <app>/<capability>` | Writes a skeleton. Proposes sensitivity labels from the app policy's label words | Operator |
| `spec edit <name>` | Opens `$EDITOR`, then runs `check` | Operator |
| `spec check <name>` | Schema, plus section 6 rules: distinct example values, labels set, correlation for commits, notes length | Any |
| `discover <spec> [--candidate <id>]` | Runs discovery. Success writes or extends a candidate and prints its ID | Operator |

- **`--candidate` attaches a negative run** to an existing candidate (section 6 §14.8).
- **Example values in a spec file must be fake.** The loader accepts them only for apps whose settings say `test`.
- **On a production app** (only where the bank opted in, section 4 §10.6), `discover` reads example values from standard input instead.
- **Why:** a spec file lives in git. Real member data must never reach it.

### 8.2 Candidate review and sealing

| Command | Does |
|---|---|
| `candidate list`, `candidate show <id>` | Steps, targets, outcomes, and the issue count |
| `candidate issues <id>` | Blocking issues first, then warnings (section 6 §14.15) |
| `candidate review <id>` | The guided walk (below) |
| `candidate decide <id> <what> <subject> <value> [--note]` | Records one decision. Regenerates the candidate. Prints the new issues |
| `candidate adopt <id> <outcome> pack:<handler_id>` | Adopts a pack outcome for a negative run's screen |
| `candidate seal <id> --version <semver>` | Seals, if all four rules pass |

**`<what>` values:** `tag`, `risk`, `sensitivity`, `outcome_name`, `refusal`, `waiver`, `recovery`, `edit`. Section 6 §15 lists what each records.

- **Decisions append to `decisions.jsonl`.** The last decision on a subject wins. Nothing is deleted.
- **The recorder regenerates the candidate** after each decision (section 6 §14.1).
- **Adoption is offered** when a pack handler of class `business_outcome` fires on a negative run's final screen. The CLI dry-runs the pack's detectors to find it.

**The guided walk, in order:**

1. **Blocking issues,** one at a time.
2. **Tags,** action by action, with the masked screenshot's path.
3. **Risk flags,** lowered ones first, beside the rules' class and reason.
4. **Sensitivity labels, outcome names, refusals.**
5. **The recovery link or waiver.**
6. **The `about` text.**
7. **Warnings.** Read only.

**Sealing:**

- **Reviewer role.** The four sealing rules apply (update file from section 8, section 6).
- **The CLI proposes the version bump.** It compares the contract with the previous version by section 2 §5.2.
- **A smaller bump than the rules need** is refused. A larger one is allowed, with a note.
- **Sealing moves crops** into `artifacts/<app>/<capability>/<version>/crops/`, and appends an index line.
- **It prints the next command:** certify, in key notation.

### 8.3 Second look

```
intyy candidate second-look <id> <subject> --agree  --note "Remind Later only snoozes a banner."
intyy candidate second-look <id> <subject> --disagree --note "It may dismiss a KYC task for good."
intyy pack second-look <scope> <handler_id>/<action> --agree | --disagree
```

- **Another reviewer.** The CLI refuses the staff ID that made the `risk` decision.
- **`--agree`** records `risk_second_look`. The blocking issue clears.
- **`--disagree`** records a `risk` decision of `irreversible`, by the second reviewer.
- **Why disagreeing needs no third person:** raising risk is always allowed. Machines and humans may raise it; only lowering needs two people.
- **`candidate issues`** lists every lowering still waiting for a second look.

### 8.4 Patches and patch drafts

| Command | Does | Role |
|---|---|---|
| `patch new <app>/<cap>@<major>` | A candidate at the next revision, copied from the latest sealed one | Reviewer |
| `patch edit`, `patch check` | Edit, then merge with every sealed base version this tenant could run. Each merge must pass the loader | Reviewer |
| `patch seal` | Seals. Records a `patch` decision | Reviewer |
| `patch draft list`, `patch draft show <id>` | Drafts from section 8 §13.4, with source runs and observed values | Any |
| `patch draft accept <id>` | Turns the draft into the next candidate revision | Reviewer |
| `patch draft reject <id> --reason` | Closes the draft. Its alert becomes `dismissed` | Reviewer |

- **All patch commands take `--tenant`.** Patches belong to one bank.
- **A sealed patch is a new key.** It starts as draft and needs certify (update file from section 8, section 2).

### 8.5 Packs, draft handlers, and fixtures

| Command | Does | Role |
|---|---|---|
| `pack edit <scope>` | A candidate revision from the latest sealed one | Reviewer |
| `pack check <scope>` | Loader checks, plus the fixture suite for this pack and every merged set it touches | Any |
| `pack dry-run <scope> [--run <run_id> \| --fixtures]` | Which detectors fire on which screens | Any |
| `pack draft list`, `pack draft show <id>` | Draft handlers (section 5 §12.2) | Any |
| `pack draft review <id>` | The guided walk of section 5 §12.5 | Reviewer |
| `pack draft accept <id> --into <scope> [--id <handler_id>]` | Adds it to that scope's candidate. Needs one `no_fire` fixture | Reviewer |
| `pack draft reject <id> --reason` | Closes the draft | Reviewer |
| `pack seal <scope>` | Seals. Lowered flags need a second look | Reviewer |
| `pack impact <scope> <rev>` | Lists approved keys whose handler set hash would change | Any |
| `pack approve <scope> <rev>` | Needs a passing regression batch for each key in `pack impact` | Approver, not the sealer |
| `fixture new --from <run_id> <seq> --kind trouble\|normal` | Saves a masked screen as a fixture | Reviewer |
| `fixture list`, `fixture show <id>` | Read only | Any |

- **Scope names:** `global`, `app:kvfcu`, `app_version:kvfcu:9.*`, `tenant:keystone:kvfcu`.
- **Regression batches run through `certify`** (9.1). `pack approve` only checks their reports.

### 8.6 Policy and settings

| Command | Does | Role |
|---|---|---|
| `policy edit <layer>` | Layers: `global`, `app:<app>`, `tenant:<tenant>` | Reviewer |
| `policy check <layer>` | Loader checks. A loosening fails loudly (section 4 §4.3) | Any |
| `policy seal <layer>`, `policy approve <layer> <rev>` | Seal, then stamp | Reviewer, then approver |
| `policy effective --app <app>` | Prints the merged policy for the tenant, with its hash | Any |
| `settings edit`, `settings check`, `settings seal`, `settings approve` | One file per tenant | Reviewer, then approver |
| `settings check --secrets` | Checks that every bound variable has a value. Prints names, never values | Operator |

- **Global and app layers need roles on `*`** (7.7).

### 8.7 Suites, test data, and fault profiles

| Command | Scope | Role to approve |
|---|---|---|
| `suite edit\|check\|seal\|approve <app>/<cap>@<major>` | One capability major, every tenant | Approver on `*` |
| `testdata edit\|check\|seal\|approve <app>` | One tenant, one app | Approver for that tenant |
| `faults edit\|check\|seal\|approve <app>` | One app | Approver on `*` |

- **`testdata check` refuses** an app whose settings say `production` (section 8 §6.2).
- **`suite check`** lists `extra` cases that name steps missing from a sealed version.

---

## 9. Trust commands

### 9.1 Certify

> **Changed by section 10:** certify case gains --operator mailbox. See `intyy-design-updates-from-section-10.md` §12.

```
intyy certify <key> [--kind full|quick|regression] [--pack <scope>@<rev>] [--instance k=v,…]
              [--plan-only] [--models off]
intyy certify case <key> --class <class> --profile <profile> [--at <anchor>]
intyy certify rerun <batch_id> <case_id>
intyy certify report <batch_id>
```

**Before the first run, `certify` checks:**

1. **Operator role** for the tenant.
2. **Settings say `environment: test`.**
3. **The suite, test data set, and fault profile set** are sealed and approved.
4. **Harness features.** Missing ones become coverage gaps (section 8 §6.5).
5. **The instance lock is free.** Certify never waits for it (12.2).

**Then it:**

1. **Writes `plan.json`,** and prints a summary: case count, estimated time, instance facts, drill or not.
2. **Stops here with `--plan-only`.**
3. **Runs every case.** One progress line per case on standard error.
4. **Writes `report.json`** and the `batch` history line.
5. **Prints the gate result.** Exit 0 if passed, 5 if not.

**One-case batches:**

| Command | Makes | Use |
|---|---|---|
| `certify case` | A `quick` batch: one clean baseline run for the route map, then the chosen case | Show a fault path on demand, like reply lost |
| `certify rerun` | A `quick` batch that repeats one case with the same seed and plan entry. It records `rerun_of` | Reproduce a failure |

- **Neither is approval-grade.** Both are `quick` batches (section 8 §7.1).
- **Why `certify case`:** section 1 §19 promised "commit reply lost proves the reconciliation path on demand." This is that command.

**Regression batches for a pack:**

```
intyy pack impact app:kvfcu 5
intyy certify --kind regression --pack app:kvfcu@5 --all-affected
```

- **`--all-affected`** runs one regression batch per key that `pack impact` lists, one after another.
- **The candidate revision is used** for these batches only. Live runs never see it.

### 9.2 Declaring instance facts

**The problem:** CONTRACT §4 options are set when the bank app starts. No endpoint reports them. intyy cannot read them.

**Decision:** the operator declares them per batch.

- **Default:** the test data set's `instance` (section 8 §6.2).
- **Override:** `--instance variant=lakeshore,strip_semantics=1,drop_labels=0.3,label_seed=7,delay_scale=0.2`.
- **Any difference from the default** makes the batch a drill. The plan says so before the first run.
- **The plan records the declaration** with the staff ID. The approver sees who declared it.

**Two cross-checks:**

- **Delay scale:** step times against nominal delays in the fault log (section 8 §9.6).
- **Unexpected drift:** baseline votes with differing clues that the last approved batch did not show. The report warns: "the instance may differ from its declaration."

- **Known limit:** a wrong declaration can still pass as approval-grade. The staff ID signs it; the cross-checks catch the common cases.

### 9.3 The approval screen

`intyy trust review <key> [--batch <id>]` renders section 8 §10.3 in three blocks.

| Block | Holds | Effect |
|---|---|---|
| **Blocks approval** | Gate failures, a stale batch, unapproved links, the approver's role, sealer rules | Any item here: `trust approve` refuses |
| **Needs your note** | Fragile steps | Each needs `--ack <step>` |
| **Read before you approve** | Lowered flags with both staff IDs, coverage gaps, stability and twins, timeouts to install, jev table, autonomy readiness, burn-in runs, open sealing warnings | Shown. No action needed |

- **The screen ends with the record hash.** `trust approve` must quote it (9.4).
- **It fits one terminal screen.** `--full` adds detail. Each line names the report file for more.

**Example, shortened:**

```
KEY   kvfcu/open_share_subaccount@1.0.0   tenant keystone   app 9.2
NEW   first approval in this context
BATCH batch_2026-09-26_3fk8q2m7xa   full   72 runs   fresh

BLOCKS APPROVAL            none

NEEDS YOUR NOTE
  open_member   margin 0.24 (median 0.52)   winner 0.91   differing: none

READ BEFORE YOU APPROVE
  lowered flags   click_remind_later: unsure → idempotent   op_017, second look op_022
  coverage gaps   hang with the window closed; logout with the window closed
  stability       0.05: 80% pass   0.15: 40% pass, 1 unexplained   0.30: 20% pass   twins 0.2 at 0.30
  timeouts        installs defaults; candidates click_search 10 s, click_submit 15 s
  jev             step 5 right, 0 wrong   reconciliation 4 right, 0 wrong   autonomy: earning
RECORD sha256:7d20a1…
```

### 9.4 The approval family

| Command | Does | Role |
|---|---|---|
| `trust list [--state <state>]` | Keys for the tenant, with state | Any |
| `trust show <key>`, `trust history <key>` | Record and history lines | Any |
| `trust review <key> [--batch <id>]` | The approval screen | Any |
| `trust approve <key> --batch <id> --ack <step>… --note <text> --expect-record <hash>` | Approves (section 8 §10.5) | Approver, not the sealer |
| `trust reject <key> --batch <id> --note <text>` | Records a rejection | Approver |
| `trust restore <key> (--batch <id> \| --after-exclusion) --note <text> --expect-record <hash>` | Restores a degraded key (section 8 §10.8) | Approver |
| `trust reinstate <key> --reason <text>` | Retired back to draft | Approver |
| `trust demote <key> --reason <text>` | Approved to degraded | Operator or approver |
| `trust retire <key> --reason <text>` | Retires | Operator or approver |
| `trust exclude <key> <run_id>… --reason <text>` | Removes runs from the live window (section 8 §12.5) | Approver |

**Two rules shape the roles:**

- **Giving trust needs an approver.** Approve, restore, reinstate, exclude.
- **Taking trust away needs any operator or approver.** Demote and retire.
- **Why:** principle 2.2 of section 8. Stopping a bad recipe should be easy. Starting one should not.

**`--expect-record`:**

- **The approver quotes the record hash** from the screen they read.
- **If the record changed since,** the command refuses (exit 6) and shows what changed.
- **Why:** a demotion or a new batch may land between reading and approving. Nobody approves a state they did not see.
- **On a terminal,** the guided walk asks for each `--ack`, the note, and the first 6 characters of the hash.

### 9.5 Autonomy, thresholds, and tags

| Command | Does | Role |
|---|---|---|
| `trust autonomy <key>` | The autonomy record (section 8 §14.2) | Any |
| `trust autonomy grant <key> --expect-record <hash>` | Grants, when `ready` | Approver |
| `trust autonomy revoke <key> --reason <text>` | Revokes. Evidence resets | Operator or approver |
| `jev report <app> [--jev <version>]` | Pooled, labelled jev calls: right, wrong, below threshold, per answer type | Any |
| `thresholds show <app>` | The app-level record and every context tightening | Any |
| `tags report <app>` | Tag agreement per model, prompt, and tag type (section 8 §14.3) | Any |

- **Designed only:** `thresholds propose` and `tags grant`. Section 8 keeps both as reports in the build.

### 9.6 Majors

| Command | Does | Role |
|---|---|---|
| `major show <app>/<cap>@<major>` | The major record, and each tenant's retire date | Any |
| `major deprecate <app>/<cap>@<major> --successor <major> --retires-on <date> --reason <text>` | Writes the next revision of the major record (section 8 §11.9) | Approver on `*` |

### 9.7 Alerts and drift

| Command | Does | Role |
|---|---|---|
| `alert list [--state open]` | Open alerts for the tenant, newest first | Any |
| `alert show <id>` | Pattern, keys, evidence runs, suggested fix | Any |
| `alert act <id> --with <draft_id \| batch_id \| pack rev \| note>` | Marks it acted, with what was done | Operator |
| `alert dismiss <id> --reason <text>` | Marks it dismissed | Operator |
| `drift report [--since <date>]` | The patterns of section 8 §13.2, with change points | Any |

- **The drift reader also runs after every score write** (section 8 §13.1). The report command only shows its view.

### 9.8 Score rebuild

```
intyy trust rebuild [<key> | --all] [--from-evidence]
```

- **Rebuilds `record.json`** from history and live lines, under the score lock.
- **`--from-evidence`** first recreates `live.jsonl` from `run.json` files (section 8 §5.2).
- **It prints the difference** between the old and new record. Exit 0 either way.

---

## 10. Run commands

### 10.1 Replay

```
intyy replay kvfcu/open_share_subaccount@1 --mode supervised --inputs inputs.json [--request-id <id>]
             [--authorization auth.json] [--agent <id>] [--pin <key>] [--models off]
intyy replay --request request.json
```

- **Two forms, one request.** Flags build the same request object as section 3 §4.1. Mixing the two forms is a usage error.
- **Inputs come from a file, or `-` for standard input.** Never from flags (principle 2.5).
- **Authorization** comes from a file too. It holds a consent reference and staff ID.
- **`--request-id`** defaults to `cli-<staff>-<time>`. It is printed, so a repeat can reuse it.
- **`--pin <key>`:** supervised only, operator role. It goes into the internal run spec (section 8 §11.5).

**On a supervised run:**

- **On a terminal,** the start confirmation appears in the same terminal.
- **Elsewhere,** the run waits for `operator decide <run_id> approved`.

**The answer:**

- **On a terminal:** a short human summary, with raw outputs. This is the delivery.
- **With `--json`:** the result contract.
- **Exit code** by status (7.5).

### 10.2 Waiting, polling, and the delivery window

**Decision: the replay command hosts its run until the run ends.**

- **Why:** raw outputs live only in the hosting process's memory (section 3 §5.13). A detached host would need a local server to hand them over. That is infrastructure a CLI build does not need.
- **So a CLI replay always ends with a final status.** A long takeover keeps it waiting. The operator works from another terminal.

**`wait_ms` in the CLI:**

- **At `wait_ms`,** standard error prints the interim status and the run ID. The command keeps waiting.
- **Standard output still gets one document:** the final result.

**Polling from elsewhere:**

```
intyy run status <run_id> [--wait <ms>]
```

- **Returns the stored result,** from `run.json`. Sensitive outputs are masked, with warning `outputs_masked`.
- **Exit 3** while the run is not final. `--wait` polls the index until final or the time ends.
- **A repeat of the same request ID** from another process returns the same stored result.

**Designed only:** a service host keeps runs and the delivery window in one long-lived process. It answers polls with raw outputs during the window, as section 3 describes. The CLI then becomes one of its clients.

### 10.3 Stopping a run

| Action | Effect |
|---|---|
| Ctrl-C once | Asks the engine to end the run, `ended_by_operator`, at the next safe point |
| Ctrl-C again | Kills the process. A later sweep closes the run (section 7 §17) |

- **The next safe point is never mid-commit.** A commit in flight settles or reconciles first, as usual.
- **Before a kill,** standard error warns: "A kill now may leave the commit uncertain."

### 10.4 Operator commands

| Command | Does | Needs a claim? |
|---|---|---|
| `operator list [--mine]` | Open interventions: run, capability, kind, reason, step, deadline, claimed by | — |
| `operator show <run_id>` | The open request, masked, with its screenshot path and allowed decisions | — |
| `operator claim <run_id>` | Takes a takeover. Moves the deadline (section 7 §13.3) | — |
| `operator release <run_id> [--note]` | Hands back. The bot reverifies | Yes, by the claimer |
| `operator decide <run_id> <decision> [--outcome <code>] [--note]` | Answers any kind | Takeovers only |
| `operator dialog <run_id> accept\|dismiss` | Answers a native dialog during a takeover | Yes, by the claimer |

- **Operator role** for the run's tenant.
- **`decide` checks the request's allowed decisions,** and for `set_outcome`, its declared outcome codes.
- **`list` reads the tenant index.** A run whose last status is `escalated` has an open request.
- **`show` prints the screenshot path.** The operator opens it; the live screen is the visible browser.

### 10.5 Mailbox records

**Location:** inside the run folder, one subfolder per intervention.

```
runs/<run_id>/mailbox/
  01_approval/          request.json  decision.json  closed.json
  02_takeover/          request.json  claim.json  dialogs.jsonl  release.json  closed.json
```

| File | Written by | Format |
|---|---|---|
| `request.json` | Engine | `intyy.intervention/1.0` (section 7 §13.1) |
| `claim.json` | Operator CLI, or the engine for an implicit claim | `intyy.claim/1.0`: staff ID, time, `implicit` |
| `release.json` | Operator CLI | `intyy.release/1.0`: staff ID, time, note |
| `decision.json` | Operator CLI | `intyy.decision/1.0`: staff ID, time, decision, outcome, note |
| `dialogs.jsonl` | Operator CLI | One line per native dialog answer |
| `closed.json` | Engine | How it closed: `resolved`, `timed_out`, or `run_ended` |

- **Claims use exclusive create.** A second claimer fails with exit 6. No race.
- **Every other write is atomic:** write to `var/tmp`, then rename.
- **Notes pass the text rules** before they are written. Staff may type member details by mistake.
- **Why in the run folder:** interventions are evidence. Brief 3.6 asks to record what the human did. One folder holds it all.

### 10.6 Manual reconcile

**When:** a run is final with commit `uncertain`. Examples: a crash after `commit_intent` (section 7 §17), or an unanswered reconciliation decision.

```
intyy reconcile <run_id> --inputs inputs.json
```

1. **The operator re-enters the parent's inputs.** intyy never stored them, by design.
2. **The CLI checks them** against the request index's keyed hash, while the entry exists (7 days by default). A mismatch refuses.
3. **After the entry expires,** the CLI warns and requires a `--note`.
4. **It starts a child run:** kind `reconciliation`, `purpose: commit_check`, supervised, with the parent's check capability.
5. **Plain code, jev, or a human decides** the answer, as in section 7 §11.

**A final result never changes.** The finding is a new record:

```json
{ "schema": "intyy.effect_update/1.0", "parent_run_id": "run_2026-09-24_h2d6w8q1zm",
  "check_run_id": "run_2026-09-25_4mz8c1q7vd", "finding": "found_by_check",
  "decided_by": "code", "staff_id": "op_017", "at": "2026-09-25T09:12:40Z" }
```

- **Written as `effect_update.json`** in the parent's folder. The tenant index gets an `effect_updated` line.
- **`run status` and repeats of the parent's request ID** return the original result plus new warning `effect_updated`. Its message names the finding and the check run.
- **Why not rewrite the result:** evidence must not change after the fact. A new record keeps both the old answer and the truth.

### 10.7 Crash sweep report

```
intyy run sweep [--force-unlock <lock> --reason <text>]
```

- **Lists runs the sweep closed,** with their commit state. Uncertain ones show the `reconcile` command to run.
- **`--force-unlock`** removes a lock held by another machine. Operator role. The reason goes into the lock log.

**Other run commands:** `run list [--since]`, `run show <run_id>` (masked summary and file index).

---

## 11. Capability catalog

**Job:** show which capabilities a tenant can call, and how.

| Command | Does |
|---|---|
| `capability list [--callable unattended\|supervised]` | Names at `@major`, effect, state in this context, deprecation |
| `capability describe <app>/<cap>@<major> [--format tool]` | `about`, inputs and outputs as JSON Schema, outcomes, effect, caller rules |

- **`--format tool`** prints a tool definition an agent can load: name, description, and input schema (section 2 §12.9).
- **The caller rules** of section 3 §5.14 go into the description, as that section asks.
- **Invoking is `replay`:** by name, with typed inputs checked against the contract.

**Push-back on scope:**

- **Brief §8 lists this as a stretch goal.** It also says: pick at most one or two.
- **Section 8 already builds two:** confidence and approval, and multi-run stability.
- **So this is built as operator tooling,** because staff need it anyway. It is not claimed as a third stretch goal.
- **Designed only:** an MCP or HTTP adapter that exposes list, describe, and invoke to agents. It sits on the service host (10.2).

---

## 12. Locks

### 12.1 Three locks

| Lock | File | Held by | For how long |
|---|---|---|---|
| **Run** | `var/locks/runs/<run_id>.lock` | The run's process | The whole run. It marks the run as alive |
| **Instance** | `var/locks/instances/<origin_key>.lock` | A run or a batch on an exclusive origin | The run, or the whole batch |
| **Score** | `var/locks/scores/<tenant>.lock` | Any score writer | Append and rebuild only. Seconds |

**Lock file** (`intyy.lock/1.0`): owner (run ID or batch ID), process ID, host, command, staff ID, start time.

- **Every lock uses exclusive create.** Two takers can never both win.
- **Why files:** one machine, zero infrastructure. **Designed:** a lock service for many machines.

### 12.2 The instance lock

**Which origins:** every origin whose settings say `environment: test`. Production origins take none.

- **Why test only:** CONTRACT §2 makes faults, counters, and data global to a test instance. Production apps serve many users anyway.
- **Origin key:** scheme, host, and port. Example: `http_127.0.0.1_8080`.

**Who takes it:**

| Command | Waits for it? | Why |
|---|---|---|
| `certify` | No. Fails fast, exit 8 | A batch holds it for up to an hour. Waiting helps nobody |
| `discover` | No. Fails fast | A long, attended run. The operator can start it later |
| `replay` | Yes, up to 30 s (`--lock-wait`) | Replays are short. The next one often follows within seconds |
| `reconcile` | Yes, up to 30 s | Same |

- **A busy lock stops the command before any run exists.** No run ID, no log. The request ID stays free for a retry.
- **Standard error names the holder:** command, staff ID, and start time.
- **Child runs share their parent's hold.** Reconciliation children and certify cases check the owner and pass.

### 12.3 Order and stale locks

- **Order:** instance, then run, then score. The score lock never waits on another lock. No deadlock can form.
- **Score lock wait:** up to 10 s. After that, an alert. The run's result never changes (section 8 §5.6).
- **Stale on this machine:** the holder's process is gone. The next taker removes it and logs `stale_lock_cleared`.
- **Held from another machine:** always treated as held. `run sweep --force-unlock` with a reason clears it.

---

## 13. Demo path and runs without live services

**The brief asks for** exact commands to run the agent on a goal, then replay the result (brief §6). Section 10 writes the README. These are the commands.

### 13.1 Setup

> **Changed by section 10:** Exact bank app options. See `intyy-design-updates-from-section-10.md` §12.

1. **Start the bank app** with test mode on: `make up` in its repo (CONTRACT §1).
2. **Copy `.env.example` to `.env`.** Fill in bank credentials, bound in settings, and model keys.
3. **Check:** `intyy settings check --secrets` and `intyy staff whoami`.

### 13.2 The path

> **Changed by section 10:** Adds the handoff demo. See `intyy-design-updates-from-section-10.md` §12.

| # | Command | Result |
|---|---|---|
| 1 | `intyy discover library/specs/kvfcu/open_share_subaccount.json` | A real LLM run. Prints a candidate ID |
| 2 | `intyy candidate review <id>` | Tags, risks, labels, outcomes decided |
| 3 | `intyy candidate seal <id> --version 1.0.0` | A sealed artifact |
| 4 | `intyy replay kvfcu/open_share_subaccount@1 --mode supervised --inputs demo/valid.json` | `success`, with the account number |
| 5 | `intyy replay … --inputs demo/missing.json` | `business_outcome`, `member_not_found`. Exit 2 |
| 6 | `intyy certify case kvfcu/open_share_subaccount@1.0.0 --class valid --profile reply_lost` | The reply-lost path: `success`, `found_by_check` |

- **The session capability comes first** at a new bank. The library ships `kvfcu/sign_in@1.0.0` already sealed, from the real discovery run.
- **Step 4 is supervised** because the key is still draft. Unattended needs certify and approval (section 15).
- **Short path:** skip steps 1 to 3 and replay the artifact the library ships.

### 13.3 Without live services

- **The bank app is local.** The only live services are the model APIs.
- **`--models off`** runs replay, certify, and reconcile with no model. Trouble that needs jev or the reviewer climbs to a human.
- **Discovery needs a live model.** The published `/evidence/` shows a real run instead.
- **CI uses fake twins** for every model (5.9). No key is needed.

---

## 14. Command reference

**Roles:** O operator, R reviewer, A approver, — anyone with a staff ID. **Lock:** I instance, S score.

### 14.1 Runs

| Command | Role | Lock | See |
|---|---|---|---|
| `discover <spec> [--candidate <id>]` | O | I, fail fast | 8.1 |
| `replay <cap@major> --inputs <file> …` or `replay --request <file>` | Caller identity. The start confirmation needs O; `--pin` needs O | I, waits 30 s | 10.1 |
| `certify <key> [--kind …] [--pack …] [--instance …] [--plan-only]` | O | I, fail fast; S | 9.1 |
| `certify case <key> --class … --profile … [--at …]` | O | I, S | 9.1 |
| `certify rerun <batch> <case>` | O | I, S | 9.1 |
| `certify report <batch>` | — | — | 9.1 |
| `reconcile <run_id> --inputs <file>` | O | I, waits 30 s | 10.6 |
| `run list`, `run show`, `run status [--wait]` | — | — | 10.2, 10.7 |
| `run sweep [--force-unlock …]` | — ; O to unlock | — | 10.7 |
| `operator list`, `operator show` | O | — | 10.4 |
| `operator claim`, `release`, `decide`, `dialog` | O | — | 10.4 |

### 14.2 Authoring

| Command | Role | See |
|---|---|---|
| `spec new`, `spec edit` | O | 8.1 |
| `spec check` | — | 8.1 |
| `candidate list`, `show`, `issues` | — | 8.2 |
| `candidate review`, `decide`, `adopt` | R | 8.2 |
| `candidate second-look` | R, not the decider | 8.3 |
| `candidate seal --version` | R | 8.2 |
| `artifact list`, `artifact show`, `artifact verify` | — | 6.4 |
| `patch new`, `edit`, `seal`; `patch draft accept`, `reject` | R | 8.4 |
| `patch check`, `patch draft list`, `show` | — | 8.4 |
| `pack edit`, `seal`, `second-look`; `pack draft review`, `accept`, `reject` | R | 8.5 |
| `pack check`, `dry-run`, `impact`, `pack draft list`, `show` | — | 8.5 |
| `pack approve` | A on the pack's scope, not the sealer | 8.5 |
| `fixture new` | R | 8.5 |
| `policy`, `settings`, `suite`, `testdata`, `faults`: `edit`, `seal` | R | 8.6, 8.7 |
| Same nouns: `check` | — | 8.6, 8.7 |
| Same nouns: `approve` | A, not the sealer | 8.6, 8.7 |
| `policy effective` | — | 8.6 |
| `settings check --secrets` | O | 8.6 |

### 14.3 Trust, drift, and publishing

| Command | Role | Lock | See |
|---|---|---|---|
| `trust list`, `show`, `history`, `review` | — | — | 9.3, 9.4 |
| `trust approve`, `reject`, `restore`, `reinstate`, `exclude` | A | S | 9.4 |
| `trust demote`, `retire` | O or A | S | 9.4 |
| `trust autonomy`; `autonomy grant` | —; A | S | 9.5 |
| `trust autonomy revoke` | O or A | S | 9.5 |
| `trust rebuild` | O | S | 9.8 |
| `jev report`, `thresholds show`, `tags report` | — | — | 9.5 |
| `major show`; `major deprecate` | —; A on `*` | — | 9.6 |
| `alert list`, `show`; `alert act`, `dismiss` | —; O | — | 9.7 |
| `drift report` | — | — | 9.7 |
| `evidence publish` | R | — | 6.6 |
| `evidence verify` | — | — | 6.6 |
| `capability list`, `describe` | — | — | 11 |
| `staff whoami`, `staff check` | — | — | 7.7 |

- **`evidence verify`** runs the publish checks on `/evidence/` as it stands: hashes, canaries, links.
- **`staff check`** validates the staff file. **`staff whoami`** prints the staff ID and its roles.

---

## 15. Worked example: from goal to unattended replay

Keystone, app 9.2. The library already holds approved policy, settings, packs, suite, test data, and fault profiles.

| # | Who | Command | Result |
|---|---|---|---|
| 1 | `op_017` | `intyy discover library/specs/kvfcu/open_share_subaccount.json` | Candidate `cand_7h2k` |
| 2 | `op_017` | `intyy discover library/specs/kvfcu/open_share_subaccount.missing.json --candidate cand_7h2k` | Outcome `member_not_found` attached |
| 3 | `op_017` | `intyy candidate review cand_7h2k` | Lowers "Remind Later" from unsure. One issue left: a second look |
| 4 | `op_022` | `intyy candidate second-look cand_7h2k click_remind_later --agree --note "…"` | Issue clears |
| 5 | `op_017` | `intyy candidate seal cand_7h2k --version 1.0.0` | Prints the key: `kvfcu/open_share_subaccount@1.0.0` |
| 6 | `op_017` | `intyy replay kvfcu/open_share_subaccount@1 --mode unattended --inputs a.json` | `rejected`, `context_not_approved`, `not_approved`. Exit 4 |
| 7 | `op_017` | `intyy certify kvfcu/open_share_subaccount@1.0.0` | 72 runs. Gate passed. Exit 0 |
| 8 | `op_022` | `intyy trust review kvfcu/open_share_subaccount@1.0.0` | The screen of 9.3. Record `sha256:7d20a1…` |
| 9 | `op_022` | `intyy trust approve … --batch batch_…3fk8q2m7xa --ack open_member --note "…" --expect-record sha256:7d20a1…` | `approved` |
| 10 | agent | `intyy replay kvfcu/open_share_subaccount@1 --mode unattended --inputs a.json --json` | `success`. Exit 0 |
| 11 | `op_017` | `intyy evidence publish kvfcu/open_share_subaccount@1.0.0 run_…` | Trust snapshot, batch report, and the run in `/evidence/` |

**Why step 6 matters:** the rejection is the design working. A sealed recipe is not a trusted recipe.

**What if step 9 came after a live demotion?** The record hash changed. The command refuses, exit 6, and prints the new `degraded` line.

**A takeover during step 10, from another terminal:**

1. `intyy operator list` shows the run, kind `takeover`, reason `needs_human_handler`.
2. `intyy operator claim run_…` takes the lease. The operator works in the visible browser.
3. `intyy operator release run_… --note "Supervisor approved."` hands back. The bot reverifies and continues.
4. **The replay command in the first terminal** then prints the final result.

---

## 16. Tests that prove it

| Test | Proves | In CI? |
|---|---|---|
| Port contract suites | Each real adapter and its fake twin behave the same, for every operation they share | Yes. Real surface on the local bank app |
| Hands import check | No module except the gate imports the hands type | Yes |
| Masked type check | A raw string does not type-check where a masked value is required | Yes, compile-time |
| Harness boundary | No replay-path module reaches the harness port (section 8) | Yes |
| Network guard | The surface adapter blocks an outside host and a denied path | Yes |
| Model call order | The stored `llm/` bytes equal the sent bytes; a failed write stops the call | Yes |
| Planner cassette | A saved discovery run replays in CI; a changed observation stops it loudly | Yes |
| Store sealing | Seal writes the index; hash excludes `approved`; a changed file fails to load | Yes |
| Four eyes | Every approve refuses the sealer; second look refuses the decider | Yes |
| Second look disagree | Records `irreversible` by the second reviewer | Yes |
| Exit codes | Each status and refusal maps to its code | Yes |
| Output rules | Terminal versus pipe; `--json` prints one document; reveal refused off loopback | Yes |
| No inputs on flags | No command accepts an input value as a flag | Yes |
| Mailbox | Exclusive claim; two claimers; atomic writes; `closed.json` on each ending | Yes |
| Locks | Busy, fail fast, bounded wait, child shares the hold, stale cleared, other host held | Yes |
| `--expect-record` | Approve refuses after the record changed | Yes |
| Manual reconcile | Hash check of re-entered inputs; `effect_update` written; warning on status and repeats | Yes |
| Evidence publish | Canary hit refuses; links resolve; manifest written | Yes |
| Sweep at start | Every command closes crashed runs first | Yes |
| Approval screen | A saved record renders the same text | Yes, golden |
| Demo path | Section 13.2 steps 4 to 6 on the local bank app | Yes, models faked |

---

## 17. How this meets the brief

| Brief asks | Where |
|---|---|
| §6 README: how to set up and run; keys and config; running without live services | 6.1, 13.1, 13.3 |
| §6 Demo path: exact commands to run the agent on a goal, then replay | 13.2 |
| §6 `/evidence/` with artifact and logs from both runs | 6.6 |
| 3.1 The agent interacts with a real UI; bias to surfaces with no clean DOM | 5.2: one surface port for web, legacy web, desktop, and pixels |
| 3.3 Report a clear, structured result | 7.4, 7.5, 10.1 |
| 3.4 The agent must not act outside the allowlist | 5.2: the gate holds the only hands; the guard lives in the adapter |
| 3.4 Never persist secrets or raw sensitive data | 2.5, 5.1, 6.6, 10.5 |
| 3.6 Route a request with context; take over the live session; hand back | 10.4, 10.5 |
| 3.6 Know who is, or should be, in control | 10.4, 10.5: claims and the lease |
| 3.7 The seam between perceiving and the recorded flow | 5.2 |
| §7 Clear boundaries, appropriate simplicity | 2.7, 4, 12 |
| §8 Agent-facing capability interface | 11: built as tooling, not claimed |

---

## 18. Rejected options

| Option | Why rejected |
|---|---|
| One generic model port | Each job has its own schema, fake, and failure rule. One port would hide them |
| One store interface per record kind | Ten copies of the same file logic |
| One store interface for everything | Sealing, appending, and run folders behave differently |
| The executor holds the surface directly | "Every action crosses the gate" would depend on discipline |
| Adapters enforce time limits | Limits would scatter. The core owns them once |
| A detached run host with a local server | Infrastructure to hand raw outputs across processes. The CLI does not need it |
| A local web server for operators | Files do the job (section 7 §13.4) |
| Input values as flags | Shell history and process lists expose them |
| JSON by default when piped | Surprising for humans. Scripts can ask |
| Exit 0 for a business outcome | Scripts would treat "not found" as success |
| Review only through interactive screens | Untestable, and certify has no human |
| Hand-editing candidates in an editor | Section 2: every change is a recorded decision |
| Evidence in git by default | Hundreds of dev runs would bury the reviewer |
| The trust store in git during work | Live lines grow with every run. Snapshots publish instead |
| One index file for all stores | Merge conflicts, and one file mixing different reviewers |
| Rewriting a final result after a manual reconcile | Evidence must not change. A new record instead |
| Approving without a record hash | A change between reading and approving would go unseen |
| Reading instance facts from the bank app's own files | intyy may rely only on CONTRACT |
| An instance lock on production origins | Real apps serve many users. The rule is about test instances |
| Waiting for the instance lock during certify | A batch holds it for up to an hour |
| Verbs-first grammar for every command | Fifty verbs with no grouping |
| A catalog server or MCP adapter in the build | A third stretch goal. The brief says one or two |

---

## 19. Items parked for other sections

> **Changed by section 10:** Items for section 10 are resolved. See `intyy-design-updates-from-section-10.md` §12.

| Item | Section |
|---|---|
| Source code layout. This section fixed where data lives; section 10 fixes where code lives | 10 |
| Milestone specs, including which ports and commands each milestone delivers, and M6 (certify and trust) | 10 |
| `CLAUDE.md`; README and REPORT outlines, using 13 for the README's commands | 10 |
| Model key variable names, and `.env.example` | 10 |
| Which runs, batches, and trust snapshots to publish to `/evidence/` | 10 |
| What the library ships: sealed `sign_in`, the discovered artifact, suites, test data, fault profiles, the staff file | 10 |
| Placeholder renames (`sparrow-core` to `kvfcu`, `bank_a` to `keystone`); US redaction examples | 10 |
| Canary member: missing from `CONTRACT.md` 1.1.0 | 10 |
| The stripped-button demo | 10 |
| Restricted-user case: a second credential set | 10 |
| Whether to build patch drafting and the lakeshore drill | 10 |
| Service host with API, delivery window, and catalog adapter | After the take-home |
| Identity provider, lock service, vault source | After the take-home |
| Bank settings certify target, as a format change | After the take-home |

---

## 20. Terms used in this section

| Term | Meaning |
|---|---|
| Port | An interface the core calls to reach the outside |
| Adapter | Code that implements a port for one tool |
| Fake twin | A test adapter that needs no live tool |
| Contract test | One test suite run against a port's real adapter and its fake |
| Wiring | Choosing adapters for ports when the CLI starts |
| Eyes | The surface port's read-only half |
| Hands | The surface port's acting half. Only the gate holds it |
| Outcome | A port's answer: a value, or a named expected failure |
| Masked value | A value that went through redaction, marked by its type |
| Cassette | A fake planner that replays a saved run's model replies |
| Library | Reviewed, sealed files, in git |
| State | Runtime files: scores, evidence, locks. Not in git |
| Store index | A log of seals and approvals, with content hashes |
| Candidate revision | An unsealed document: `<rev>.candidate.json` |
| Key notation | `app/capability@version+p<rev>` on the command line |
| Publish | Copying chosen runs and records into `/evidence/` |
| Guided walk | An interactive screen that issues the same commands as flags |
| Record hash | The hash of a key's `record.json`. Approvals must quote it |
| Instance facts | How the test bank app was started. Declared per batch |
| Exclusive origin | A test app address that allows one run at a time |
| Mailbox | Files in the run folder for requests, claims, and decisions |
| Effect update | A new record of a manual reconciliation's finding |
| Service host | A long-lived process for runs and an API. Designed only |
