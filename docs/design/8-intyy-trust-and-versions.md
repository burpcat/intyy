# intyy — Section 8: trust and versions

> **Status:** complete, 25 Sep 2026.
> **Formats defined:** `intyy.score/1.0` (record, history lines, live lines), `intyy.suite/1.0`, `intyy.testdata/1.0`, `intyy.faults/1.0`, `intyy.batch_plan/1.0`, `intyy.batch_report/1.0`, `intyy.thresholds/1.0`, `intyy.major/1.0`, `intyy.alert/1.0`.
> **Amended by section 9,** 25 Sep 2026: the trust store location and evidence publishing, batch kinds, the instance lock, approver and operator roles, four eyes on shared documents, the approval record hash check, and resolved parked items. Formats are not yet released, so they are amended in place.
> **Depends on:** sections 1 to 7, `CONTRACT.md` 1.1.0.
> **Used by:** sections 9 and 10.
> **Changes to sections 1 to 7:** `intyy-design-updates-from-section-8.md`.
> **Names in examples:** app `kvfcu`, tenants `keystone` and `lakeshore`. Member numbers come from CONTRACT §5. Screen text, route paths, and outcome codes not in CONTRACT are invented.

---

## Contents

1. [Purpose](#1-purpose)
2. [Design principles](#2-design-principles)
3. [New words](#3-new-words)
4. [Trust in one view](#4-trust-in-one-view)
5. [Score store](#5-score-store)
6. [Certify inputs](#6-certify-inputs)
7. [Certify batches and runs](#7-certify-batches-and-runs)
8. [Judging certify runs](#8-judging-certify-runs)
9. [Certify scores, the gate, and timeouts](#9-certify-scores-the-gate-and-timeouts)
10. [Approval](#10-approval)
11. [Resolver](#11-resolver)
12. [Live scores and demotion](#12-live-scores-and-demotion)
13. [Drift patterns and patch drafts](#13-drift-patterns-and-patch-drafts)
14. [Model trust](#14-model-trust)
15. [Pack, engine, and jev trust](#15-pack-engine-and-jev-trust)
16. [Worked examples](#16-worked-examples)
17. [Built, thin, or designed](#17-built-thin-or-designed)
18. [Tests that prove it](#18-tests-that-prove-it)
19. [How this meets the brief](#19-how-this-meets-the-brief)
20. [Rejected options](#20-rejected-options)
21. [Items parked for other sections](#21-items-parked-for-other-sections)
22. [Terms used in this section](#22-terms-used-in-this-section)

---

## 1. Purpose

- **Replay can run a recipe.** This section decides when intyy may run it with no human at the start.
- **Trust is per context:** one bank, one app version, one exact recipe.
- **Seven parts:** score store, certify, approval, resolver, drift, model trust, pack trust.
- **Stretch goals covered:** "Confidence and approval," "Multi-run stability," and part of "Canonicalization and cross-tenant reuse" (brief §8).

---

## 2. Design principles

### 2.1 Trust is earned per context, from evidence, and signed by a human

- **No record means draft.** A new version, patch revision, or app version starts with no trust.
- **Why:** a recipe that works at one bank may meet different screens at the next.

### 2.2 Machines may take trust away. Only humans give it

| Automatic (safe direction) | Human only |
|---|---|
| Demote a context | Approve or restore a context |
| Raise a jev threshold | Lower a jev threshold |
| Revoke model autonomy | Grant model autonomy |
| Block a pack revision after a failed regression | Roll a pack back |

- **Why:** the same rule as risk flags (section 4 §2.4). Machines raise risk; only humans lower it.

### 2.3 Test what you ship

- **Approval evidence must match what live runs freeze:** engine version and handler set.
- **Timeouts are approved only after a batch ran with them.**
- **Why:** evidence about a different setup is evidence about a different system.

### 2.4 Judge against truth, never against the run's own report

- **The scorer reads the bank app's fault log and oracle after each certify run.**
- **The run under test never sees them.** CONTRACT §8 forbids it, and so does good sense.
- **Why:** a run that grades itself cannot catch its own mistakes.

### 2.5 A wrong answer is worse than a failure

- **A failure is honest.** The caller learns nothing changed, or that the result is unknown.
- **A wrong answer lies.** Example: "no account opened" when one did.
- **One wrong answer in a batch blocks approval.** Failures at high chaos are expected.

### 2.6 Shared parts get regression checks. Capabilities get approval

| Part | Shared by | Trust comes from |
|---|---|---|
| Handler packs, engine, jev | Many contexts | A regression batch before it goes live (section 15) |
| Artifacts, patches, session and check capabilities | One context each | Per-context approval (section 10) |

- **Why:** section 5 §5.5. Approving shared parts per context multiplies review work by every bank.

### 2.7 One approved recipe per context

- **At most one approved key** per tenant, app version, and capability major.
- **Why:** the resolver never chooses between trusted recipes. An auditor sees exactly what ran.

---

## 3. New words

| Word | Meaning | Example |
|---|---|---|
| **Key** | The four facts that name one trusted recipe | `open_share_subaccount@1.2.0`, `keystone`, app `9.2`, patch 3 |
| **Score record** | The current trust state of one key | State `approved`, lowest margin 0.41 |
| **Certify suite** | The reviewed list of test cases for one capability major | Valid, missing, and at-limit members |
| **Case** | One test: inputs, faults, and the expected result | Valid member, reply lost after Submit, expect success |
| **Test data set** | Fake input values for one bank's test environment, in named pools | Pool `members.missing`: `999001`, `100101` |
| **Fault profile** | Faults to inject, placed at steps, not at URLs | A server error on the commit step's request |
| **Route map** | Which app requests each step sends, learned from a clean run | `click_submit` sends one `POST` (path invented) |
| **Batch** | All certify runs from one command, for one key | `batch_2026-09-25_3fk8q2m7xa` |
| **Verdict** | The scorer's judgment of one certify run | `pass`, `wrong` |
| **Oracle** | The bank app's test endpoint that says whether an account exists | CONTRACT §8 |
| **Twin runs** | Two runs with the same seed and inputs | Different step traces mean the run is flaky |
| **Gate** | The rules a batch must pass before a human may approve | Zero `wrong` verdicts |
| **Fragile step** | A step whose control only just wins the vote | Lowest margin 0.22 |
| **Harness** | An app's test-only controls: reset, faults, fault log, oracle | The bank app's `/__test__/` endpoints |
| **Live score** | The share of recent real runs that ended cleanly | 0.97 over the last 50 runs |
| **Regression batch** | A short certify run on approved contexts, before a shared part changes | Before pack revision 5 goes live |
| **Alert** | A drift finding written for an operator | "Only lakeshore: `search_button` label differs" |

---

## 4. Trust in one view

1. **A human seals an artifact or patch** (section 6 §15).
2. **Certify runs a batch** on the bank's test environment, with faults.
3. **The scorer judges each run** against the fault log and the oracle.
4. **The gate checks the batch.**
5. **A human approves.** The key becomes the context's one approved key. The previous one retires.
6. **Live runs write live lines.** A drop demotes the key. Unattended requests are then rejected.
7. **The drift reader proposes a fix:** a patch, a handler, or a new version. The fix is a new key. Back to step 2.

### 4.1 States

| State | Unattended | Supervised | Reached by |
|---|---|---|---|
| `draft` | Rejected | Allowed | No record, or never approved |
| `approved` | Allowed | Allowed | A human approves a passing batch |
| `degraded` | Rejected | Allowed | Live rules, a failed full batch, or a human |
| `retired` | Rejected | Only with an operator pin (11.5) | A newer key approved, or a human |

### 4.2 Transitions

| From | To | When | `by` |
|---|---|---|---|
| `draft` | `approved` | A human approves a passing, fresh batch (10.4) | Staff ID |
| `approved` | `approved` | A human re-approves a newer passing batch | Staff ID |
| `approved` | `degraded` | Window rule or streak rule (12.3) | `live_score` |
| `approved` | `degraded` | A full batch fails the gate | `certify` |
| `approved` | `degraded` | A human demotes it | Staff ID |
| `degraded` | `approved` | A human restores it (10.8) | Staff ID |
| `approved`, `degraded` | `retired` | A newer key for the same context and major is approved | `system` |
| any | `retired` | A human retires it | Staff ID |
| `retired` | `draft` | A human reinstates it | Staff ID |

- **Every transition is a history line** with `by`, a reason, and a time (5.4).
- **Nothing moves a key up without a staff ID.**

---

## 5. Score store

**Job:** hold approval, scores, tuned timeouts, and autonomy per key, as reviewable files.

### 5.1 The key

| Part | Example | Why it is in the key |
|---|---|---|
| `capability` | `kvfcu/open_share_subaccount@1.2.0` | Each exact version is a different recipe |
| `tenant` | `keystone` | Screens and data differ per bank |
| `app_version` | `9.2` | Vendor releases change screens |
| `patch_revision` | `3`, or `null` for no patch | A patch changes clues and condition text |

**Facts recorded, but kept out of the key:**

| Fact | Where it is recorded | Why not in the key |
|---|---|---|
| Engine version | Batch `under`, live lines | Shared. A regression batch covers it (15.5) |
| Handler set hash | Batch `under`, live lines | Section 5 §5.5: every pack change would demote every key |
| jev version | Batch `under`, live lines | Shared model. Regression covers it |
| Policy hash | Batch report | Policy only tightens. Pre-run check 9 catches what it blocks |
| Session and check keys used | Batch `under` | They have their own records and approvals |

- **Answer to the handoff question:** four parts. Engine version and handler set hash stay out.
- **They still matter.** Approval needs a batch that matches them (10.4, "fresh").

### 5.2 Three files per key

| File | Holds | How it is written |
|---|---|---|
| `history.jsonl` | Trust events: batch results, approvals, state changes, autonomy, exclusions | Append only |
| `live.jsonl` | One line per real run of this key | Append only |
| `record.json` | The current state | Rebuilt from the two logs, then replaced whole |

- **The record is a pure function of the two logs.** Same logs, same bytes. A golden test checks it.
- **Why rebuilt, not edited:** every state has a reason line in history. No one sets state by hand.
- **Why live lines sit apart:** thousands of runs a day would bury a reviewer.
- **`live.jsonl` is an index of evidence.** A rebuild command recreates it from `run.json` files.
- **No record file means draft.** The first batch or first live run creates the files.

**Two more record kinds, per capability rather than per key:**

- **Major record** (`intyy.major/1.0`): deprecation and retirement of a major version (11.9).
- **Threshold record** (`intyy.thresholds/1.0`): jev thresholds per app and jev version (14.1).

**Location:** the trust store lives in `state/trust/`, outside git. Its files stay plain and reviewable. `evidence publish <key>` copies a trust snapshot and its batch reports into `/evidence/` (section 9 §6.6).

### 5.3 Record fields

| Field | Meaning |
|---|---|
| `schema` | `"intyy.score/1.0"` |
| `key` | The four parts (5.1) |
| `hashes` | Artifact hash and patch hash, from the store index |
| `state`, `state_since`, `state_by`, `state_reason` | Current state and the history line that set it |
| `certify` | Latest full batch: ID, gate result, `under`, scores, fragile steps, stability curve |
| `regression` | Latest regression batch: ID, gate result, `under` |
| `approval` | Batch approved, staff ID, time, note, acknowledged fragile steps |
| `timeouts` | `approved` values, `candidate` values, and the batch behind each (9.6) |
| `thresholds` | Context tightenings of jev thresholds, if any (14.1) |
| `autonomy` | The reconciliation autonomy record (14.2) |
| `live` | Rolling score and counts over the window (12.3) |
| `alerts` | Open alert IDs for this key |

```json
{
  "schema": "intyy.score/1.0",
  "key": { "capability": "kvfcu/open_share_subaccount@1.0.0", "tenant": "keystone",
           "app_version": "9.2", "patch_revision": null },
  "hashes": { "artifact": "sha256:9c1e…", "patch": null },
  "state": "approved", "state_since": "2026-09-26T10:04:00Z", "state_by": "op_022",
  "state_reason": "Batch passed. Reviewed fragile step open_member.",
  "certify": {
    "batch": "batch_2026-09-26_3fk8q2m7xa", "gate": "passed",
    "under": { "engine": "0.4.0", "handler_set": "sha256:4b0a…", "jev": "jev@1.4.2",
               "session": "kvfcu/sign_in@1.0.0", "check": "kvfcu/find_account_by_reference@1.0.0" },
    "outcome_score": 1.0,
    "verdicts": { "pass": 56, "explained": 13, "assisted": 1, "unexplained": 2, "wrong": 0, "void": 0 },
    "margin": { "lowest": 0.24, "step": "open_member" },
    "fragile": ["open_member"]
  },
  "regression": null,
  "approval": { "batch": "batch_2026-09-26_3fk8q2m7xa", "by": "op_022", "at": "2026-09-26T10:04:00Z",
                "acknowledged": ["open_member"] },
  "timeouts": { "approved": {}, "approved_from": "batch_2026-09-26_3fk8q2m7xa",
                "candidate": { "click_search": 10000, "click_submit": 15000, "read_account_number": 5000 },
                "candidate_from": "batch_2026-09-26_3fk8q2m7xa" },
  "thresholds": null,
  "autonomy": { "state": "earning", "correct": 4, "found": 3, "not_found": 1, "wrong": 0 },
  "live": { "window": 50, "counted": 12, "clean": 12, "assisted": 0, "recipe_failures": 0,
            "app_failures": 1, "score": 1.0, "streak": null },
  "alerts": []
}
```

- **`timeouts.approved` is empty here.** The first batch ran with defaults, so defaults were what got tested (9.6).

### 5.4 History lines

Each line: `event`, `at`, `by`, `reason`, and event data.

| `event` | Data | Written by |
|---|---|---|
| `batch` | Batch ID, kind, gate result, report hash, `under` | Certify runner |
| `approved` | Batch ID, acknowledged fragile steps, note | Approval command |
| `rejected` | Batch ID, note | Approval command |
| `degraded` | Rule (`window`, `streak`, `certify`, `human`), evidence run IDs | Drift reader, runner, or command |
| `restored` | Batch ID, or the exclusion that cleared the rule | Approval command |
| `retired` | The newer key, or a staff reason | Approval command |
| `reinstated` | Staff reason | Approval command |
| `excluded` | Run IDs, reason | Approval command |
| `timeouts` | Values promoted from candidate to approved | Approval command |
| `autonomy` | `ready`, `granted`, or `revoked`, with evidence | Autonomy updater or command |
| `thresholds` | Tightened values and the batch that caused them | Runner |

- **`by` is a staff ID, or one of `live_score`, `certify`, `system`.**

### 5.5 Live lines

One line per real run of the key. Certify runs never write live lines.

| Field | Meaning |
|---|---|
| `run_id`, `at` | Which run, when it ended |
| `as` | `task`, `prelude` (a session key inside a task run), or `check` (a reconciliation child) |
| `mode` | `supervised` or `unattended` |
| `class` | `clean`, `assisted`, `recipe_failure`, `app_failure`, or `not_counted` (12.1) |
| `code`, `step` | Failure code and step, if any |
| `under` | Engine version, handler set hash, jev version |
| `margins` | Winner margin per target voted in this run |
| `differing` | Per target, the clues that differed, with their masked observed values (13.4) |

- **A prelude writes a line for the session key.** `sign_in` then gets live data from every task run.
- **A reconciliation child writes a line for the check key.**

### 5.6 Writers and locks

| Writer | Writes |
|---|---|
| Certify runner | `batch` and `thresholds` history lines |
| Replay, after `run_end` | Live lines for the task, session, and check keys |
| Approval commands | Approval, state, exclusion, timeout, and autonomy grant lines |
| Drift reader | `degraded` lines and alerts |
| Autonomy updater | `autonomy` lines |

- **One lock file per tenant,** held only while appending and rebuilding. Seconds at most.
- **Readers never lock.** The record is replaced by rename, so a reader sees a whole file.
- **Writes never race in the build anyway.** CONTRACT §2 allows one run at a time.
- **A failed score write never changes a run's result.** It writes an alert. The rebuild command repairs it from evidence.

---

## 6. Certify inputs

Three reviewed files feed certify. None holds real data.

| File | Scope | Says |
|---|---|---|
| Certify suite | One capability major | What to test, and what counts as right |
| Test data set | One tenant, one app, test environment only | Which fake values to use |
| Fault profile set | One app | Which faults exist, and how each must end |

### 6.1 Certify suite (`intyy.suite/1.0`)

| Field | Meaning |
|---|---|
| `schema`, `capability` | Format, and `app/capability@major` |
| `revision`, `reason` | Counts up from 1. Same idea as packs |
| `classes` | Input classes: ID, inputs, and the expected result |
| `matrix` | Which class runs the standard fault profiles (6.3) |
| `stability` | Class, entropy levels, seeds, and twins (9.3) |
| `drills` | Reconciliation drills: how many (14.2) |
| `extra` | Hand-written cases: faults at named steps, and their expected result |
| `setup` | Runs to do before a case, whose results feed its inputs |
| `provenance`, `approved` | Decisions, sealed, approved. Same as a pack file |

- **Why reviewed and approved:** the suite defines what "trusted" means. Changing it is a trust decision.
- **Why one per major:** minors keep the caller's contract. The same classes still apply.
- **An `extra` case may name a step missing from a version.** That case is `void`, and the report says why.

```json
{
  "schema": "intyy.suite/1.0",
  "capability": "kvfcu/open_share_subaccount@1",
  "revision": 1,
  "reason": "First suite.",
  "classes": [
    { "id": "valid", "inputs": { "member_id": "@members.valid", "deposit": "137.00" },
      "expect": { "status": "success", "commit": "confirmed" } },
    { "id": "missing", "inputs": { "member_id": "@members.missing", "deposit": "137.00" },
      "expect": { "status": "business_outcome", "outcome": "member_not_found", "commit": "not_sent" } },
    { "id": "at_limit", "inputs": { "member_id": "@members.at_limit", "deposit": "137.00" },
      "expect": { "status": "business_outcome", "outcome": "subaccount_limit_reached", "commit": "refused" } }
  ],
  "matrix": { "class": "valid", "profiles": "standard" },
  "stability": { "class": "valid", "levels": [0.05, 0.15, 0.30], "seeds": 5, "twins": true },
  "drills": { "count": 10 },
  "extra": [
    { "id": "supervisor_needed", "class": "valid",
      "faults": [ { "kind": "supervisor_required", "at": "@step:open_subaccount_form" } ],
      "expect": { "status": "escalated", "kind": "takeover", "reason": "needs_human_handler", "step": "click_submit" } }
  ],
  "setup": [],
  "provenance": { "decisions": [], "sealed": { "by": "op_017", "at": "2026-09-26T08:00:00Z" } },
  "approved": { "by": "op_022", "at": "2026-09-26T08:05:00Z" }
}
```

- **`subaccount_limit_reached` is invented,** and so is where it shows. Negative discovery finds the real code and step.
- **`@members.valid`** names a pool in the test data set (6.2).

**`setup`, for capabilities that need data first.** The check capability needs an account with a known reference.

```json
"setup": [ { "capability": "kvfcu/open_share_subaccount@1", "class": "valid" } ],
"classes": [
  { "id": "found", "inputs": { "reference": "@setup.0.run_id", "member_id": "@setup.0.inputs.member_id" },
    "expect": { "status": "success" } },
  { "id": "not_found", "inputs": { "reference": "run_2026-01-01_0000000000", "member_id": "@members.valid" },
    "expect": { "status": "business_outcome", "outcome": "not_found" } }
]
```

- **Setup runs are certify runs** with `purpose: setup`. They are logged, never scored.

### 6.2 Test data set (`intyy.testdata/1.0`)

| Field | Meaning |
|---|---|
| `tenant`, `app` | Which bank, which app |
| `revision` | Counts up from 1 |
| `pools` | Named lists of fake values |
| `instance` | The harness settings this bank's test app normally runs with |
| `business_date` | Fixed at batch start, when the harness can set it |

```json
{
  "schema": "intyy.testdata/1.0",
  "tenant": "keystone", "app": "kvfcu", "revision": 1,
  "pools": {
    "members.valid":    ["100107", "100114", "100121", "100128", "100135", "100142"],
    "members.at_limit": ["100247", "100254", "100261", "100268", "100275"],
    "members.missing":  ["999001", "100101", "100199", "100250", "123456"]
  },
  "instance": { "variant": "keystone", "strip_semantics": false, "drop_labels": 0, "label_seed": "0" },
  "business_date": "2026-01-15"
}
```

- **Values come from CONTRACT §5.** Fake people only.
- **The loader rejects a test data set** for any app whose bank settings say `environment: production`.
- **Values are still masked in logs,** like any input. Masking does not trust the word "fake."
- **Pick rule:** value = pool[(case number + repeat number) mod pool size]. Same plan, same values.
- **Why pools, not fixed values:** different members show different screens. Variety finds more.

### 6.3 Fault profile set (`intyy.faults/1.0`)

**Job:** list the faults an app's harness can inject, where to place them, and how each must end.

**A fault:**

| Field | Meaning | Example |
|---|---|---|
| `kind` | A harness fault kind | `server_error` (CONTRACT §6.2) |
| `at` | An anchor: where in the recipe | `@commit_point` |
| `which` | Which of the step's requests. Only `first` in 1.0 | `first` |

**Anchors:**

| Anchor | Means |
|---|---|
| `@step:<id>` | That step |
| `@commit_point` | The step in `recovery.commit_point` |
| `@each_request_step` | Every task step that sends a request. Expands into one case per step |

- **Why anchors, not route keys:** CONTRACT keeps routes to be discovered. Steps are what intyy knows.
- **The route map (6.4) turns an anchor into a route key and a count** at batch time.

**Expected ending, by helper window** (section 5 §8.2):

| Rule | Expected result |
|---|---|
| `recovers` | The class's own expected result |
| `fails:<code>` | `failed` with that code |
| `recovers_or_escalates` | The class result, or `escalated` takeover (`stuck` or `unsafe_state`) |
| `reconciles_found` | `success`, commit `found_by_check` |
| `reconciles_absent` | `success`, commit `confirmed`, one earlier attempt `absent_by_check` |

**The standard kvfcu set.** This is section 5 §14, written as data.

| Profile | CONTRACT kind | At | Window open | Commit step |
|---|---|---|---|---|
| `server_error` | `server_error` | `@each_request_step` | `recovers` | `reconciles_absent` |
| `maintenance` | `maintenance` | `@each_request_step` | `fails:app_error` | `reconciles_absent` |
| `known_popup` | `known_popup` | `@each_request_step` | `recovers` | `reconciles_absent` |
| `unknown_popup` | `unknown_popup` | `@each_request_step` | `recovers_or_escalates` | `reconciles_absent` |
| `session_expire` | `session_expire` | `@each_request_step` | `recovers` | `reconciles_absent` |
| `reply_lost` | `drop_after_confirm` | `@commit_point` | — | `reconciles_found` |

- **`reconciles_absent` needs a retry.** The scripted operator answers `retry` (7.6). The child run then commits.
- **Why every "before" fault on Commit ends in success:** the bank never saw the request. The check proves it. The retry opens the account once.
- **Styles with no named kind** (`blank`, `hang`, `unavailable`, `logout`) come only from entropy. Stability mode covers them (9.3).
- **Why not search for seeds that hit them:** CONTRACT does not publish its hash. intyy cannot predict a seed.

**The same file also holds two judge tables,** used in 8.4 and 8.5:

- **Explained endings:** which failures each fault style can honestly cause.
- **jev truth:** which jev answers are right for each fault style.

### 6.4 Route map

**Job:** learn which requests each step sends, so an anchor becomes an exact named fault.

1. **The first baseline run of a batch runs clean:** entropy 0, no named faults, after a reset.
2. **The scorer reads the fault log.** It holds every counted request, in arrival order, with its route counter.
3. **It aligns requests with action times** from the run log.
4. **A request after step K's action, and before the next action, belongs to step K.** Prelude requests belong to prelude steps.
5. **Result:** step to route key and counter. Example: `click_submit` → `POST /accounts/submit` (invented), count 1.

- **Counts repeat after a reset.** Same actions, same requests, same counters (CONTRACT §5, §6).
- **So `nth` from the clean run hits the same request in the case run.**
- **A step with no requests,** like a fill step, gets no matrix cases.
- **The map lives in the batch plan,** never in the artifact. Routes are app internals.
- **Known limit:** a request from a page timer would join the wrong step. The report flags any request far from every action.
- **Known limit:** with two named faults, the first may add a retry. Then the second may fire one request early. The standard set uses one named fault per case.

### 6.5 Harness port

**Job:** give certify the app's test-only controls, behind one seam.

| Operation | kvfcu adapter (CONTRACT §8) |
|---|---|
| `features` | All: `reset`, `chaos`, `named_faults`, `fault_log`, `oracle`, `clock` |
| `reset` | `POST /__test__/reset` |
| `set_chaos` | `POST /__test__/chaos` |
| `add_faults`, `clear_faults` | `POST` and `DELETE /__test__/faults` |
| `fault_log` | `GET /__test__/faultlog` |
| `oracle` | `GET /__test__/oracle?notes=…` |
| `set_clock` | `POST /__test__/clock` |

- **Only the certify runner and scorer receive the harness.** Replay, discovery, and reconciliation code never do.
- **A CI test checks the imports.** No module on the replay path can reach the harness port.
- **The browser cannot reach `/__test__/` either.** The kvfcu app policy denies the path (update file, section 4).
- **A harness with fewer features** skips the cases that need them. The report lists each gap.
- **A real bank's test system** may offer reset and nothing else. 9.5 below says what the gate then asks for.
- **Signatures:** section 9 §5.5.

---

## 7. Certify batches and runs

### 7.1 Batch kinds

| Kind | Runs | Approval-grade? | Used for |
|---|---|---|---|
| `full` | Baseline, matrix, extra, drills, stability | Yes | Approve, re-approve, restore |
| `quick` | Baseline for the first class, and the matrix on the commit step only | No | Development |
| `regression` | Baseline, matrix, extra | No | Shared changes: packs, engine, jev (section 15) |

- **A `full` batch is a drill,** not approval-grade, when its instance facts differ from the test data set's `instance`.
- **Example drill:** certify on a bank app started with `KVFCU_STRIP_SEMANTICS=1`, to measure margins.
- **Why drills cannot approve:** the evidence describes a bank app that this tenant does not run.
- **`certify case` and `certify rerun` make one-case `quick` batches.** Never approval-grade (section 9 §9.1).
- **A batch run with `--models off` is a drill too.** It did not test the ladder that live runs use.

### 7.2 What a full batch runs

Example: `open_share_subaccount` on `keystone`. Four task steps send requests.

| Part | Runs | Purpose |
|---|---|---|
| Baseline | Each class × 3 repeats, plus one twin of the first valid run: 10 | Clean behavior, route map, timing, reference outputs |
| Matrix | 5 profiles × 3 open-window steps, plus 6 profiles on the commit step: 21 | Every single known fault, placed exactly |
| Extra | 1 | The supervisor case |
| Drills | 10 | Reconciliation evidence for jev (14.2). Judged on truth only: any truthful result passes |
| Stability | 3 levels × 5 seeds × 2 twins: 30 | Toughness and flakiness |
| **Total** | **72** runs, plus child and setup runs | |

- **At delay scale 1:** about 45 s per run, so under an hour. A `quick` batch takes a few minutes.
- **Why 3 baseline repeats:** each uses a new seed and a new pool value. Timing and data vary.
- **Why no repeats in the matrix:** named faults are exact. A repeat would replay the same thing.

### 7.3 Seeds

- **Every seed derives from the batch ID.** Example: `batch_2026-09-26_3fk8q2m7xa:s0.15:3`.
- **The plan stores each case's seed.** Re-running one case gives the same faults and delays.
- **Why a new seed per repeat:** CONTRACT §6 delays depend on the seed. A fixed seed would test one timing only.

### 7.4 One case, step by step

1. **Reset** the bank app, if the harness can. Data returns to the seed.
2. **Run setup runs,** if the suite lists any.
3. **Set chaos:** entropy and seed. Reset does not change them (CONTRACT §8).
4. **Add named faults,** resolved to route key and `nth` through the route map.
5. **Start the run** from an internal run spec (7.5).
6. **The run ends.** Its result stays in memory for the delivery window.
7. **Read the fault log.** Copy this case's entries into the run's `faults.jsonl`.
8. **Ask the oracle,** for commits capabilities.
9. **Judge:** verdict, scores, and timing samples (sections 8 and 9).

**At batch start:** set the business date from the test data set.
**At batch end:** entropy 0, clear named faults, reset. The bank app is left clean.

### 7.5 The certify run spec

Internal only. Callers can never send these fields (section 3 §4.9).

| Field | Meaning |
|---|---|
| `kind` | `certify` |
| `batch_id`, `case_id` | Which batch, which case |
| `pin` | The exact key under test |
| `inputs` | Pool references. Values resolve in memory only |
| `authorization` | Synthetic: `consent_ref` `certify:<batch_id>`, `granted_by: staff`, the staff ID who started the batch |
| `fault_profile` | Profile ID, plus the resolved named faults and chaos |
| `seed` | The chaos seed |
| `instance` | The instance facts declared for the batch |
| `purpose` | `null`, or `setup` |

- **Pre-run check 7 does not apply.** Certify tests a key before approval, by design.
- **The bank settings must say `environment: test`.** Otherwise the runner refuses before any run starts.
- **Certify runs behave as unattended.** No start confirmation.
- **Synthetic authorization is honest.** The staff member who starts certify consents for test data.

### 7.6 The scripted operator

> **Changed by section 10:** certify case gains --operator mailbox. See `intyy-design-updates-from-section-10.md` §11.

Certify has no human. A scripted operator adapter answers the operator port.

| Kind | Scripted answer |
|---|---|
| `start_confirmation` | Never asked |
| `approval` | `approved`, staff ID `certify`. Only happens under `approvals.force_human` |
| `retry_decision` | `retry` |
| `takeover` | None. The case records the escalation, then the script ends the run |
| `reconciliation_decision` | None. Same |

- **The observed result of an escalated case** is its first takeover or reconciliation decision: kind, reason, and step.
- **Why stop at takeovers:** a script acting as a human would test the script. Section 7 §21 tests the handoff itself.
- **Why answer `retry`:** it proves the hardest promise. One account, even after a failed commit.
- **Every scripted answer is logged** with `staff_id: certify`. No one mistakes it for a person.

### 7.7 One run at a time

- **CONTRACT §2:** faults, counters, and data are global to the bank app.
- **The runner holds an instance lock for the whole batch.** Test origins are exclusive; production origins take no instance lock (section 9 §12.2).
- **Certify and discovery fail fast when the lock is busy.** Replay and reconcile wait up to 30 s.
- **A busy lock stops the command before any run exists.**

### 7.8 Plan and report files

| File | Written | Holds |
|---|---|---|
| `plan.json` (`intyy.batch_plan/1.0`) | Before the first run | Every case: class, pool references, profile, resolved faults, seed, expected result. The route map |
| `report.json` (`intyy.batch_report/1.0`) | After the last run | Verdicts, scores, stability, coverage, timing, jev table, gate result |

- **Both live in the tenant's evidence folder,** under the batch ID: `state/evidence/<tenant>/batches/<batch_id>/` (section 9 §6.3).
- **Each run keeps its own run folder,** with `batch_id` and `case_id`.
- **The `batch` history line holds the report's hash.** Nobody can change a report unseen.
- **Retention:** a batch named by any approval or history line stays as long as that record exists.

---

## 8. Judging certify runs

### 8.1 Result class

- **Result class** = status, plus one detail:

| Status | Detail |
|---|---|
| `success` | none |
| `business_outcome` | Outcome code |
| `failed` | Failure code |
| `escalated` | Kind, reason, and step |

- **The commit state is checked apart,** by the truth checks.
- **A case may also expect a commit state.** The matrix does (6.3).

### 8.2 Truth checks

Plain code runs them after the run ends. Raw values stay in memory. Only `match: true` or `false` is stored.

| Check | For | Truth source | Fails when |
|---|---|---|---|
| **Commit truth** | `commits` capabilities with a correlation reference | The oracle, per attempt | The reported commit state contradicts the oracle, or more than one account exists |
| **Output truth** | `success` with outputs | Oracle for commits; the baseline for `read_only` | An output differs |
| **Outcome truth** | `business_outcome` | The case's class | The class does not allow that outcome |

**Commit truth, per attempt.** The notes text is the notes step's value, filled with that attempt's run ID.

| Reported commit state | Oracle `count` for that attempt | Truthful? |
|---|---|---|
| `confirmed`, `found_by_check` | 1 | Yes |
| `confirmed`, `found_by_check` | 0 | No |
| `not_sent`, `refused`, `absent_by_check` | 0 | Yes |
| `not_sent`, `refused`, `absent_by_check` | 1 or more | No |
| `uncertain` | Any | Yes. It claims nothing. It is never a `pass` |
| Any | 2 or more | No. A double commit |

- **All attempts together must sum to 1 at most.** A retry child uses its own run ID, so the oracle sees each attempt apart.
- **Output truth for `read_only`:** same inputs after a reset give the same data (CONTRACT §5). So the clean baseline is the reference.
- **With `correlation: none`,** commit truth cannot run. The report says "commit truth unavailable" in large type.

### 8.3 Verdicts

| Verdict | Meaning | Counts toward |
|---|---|---|
| `pass` | Truth checks pass. The class matches. No unexpected help | Outcome score |
| `explained` | Truth checks pass. A failure or escalation that the fault log explains. Stability only | Stability curve |
| `assisted` | The class matches, but rung 3 or a takeover helped where the case did not expect it | Blocks the baseline |
| `unexplained` | Truth checks pass, but the class is wrong, and nothing explains it | Blocks the gate outside stability |
| `wrong` | A truth check failed | Blocks approval, always |
| `void` | Could not be judged: a harness error, a runner crash, a missing step | Re-run, up to 2 times |

- **Where help is expected:** the `unknown_popup` profile expects the reviewer. The supervisor case expects a takeover.
- **Why `assisted` blocks the baseline:** a clean run that needs a model is not model-free replay. It points to drift.
- **A case `void` 3 times** fails the gate. Something is broken in the setup, and a human must look.

### 8.4 The fault-aware judge (stability)

- **Stability runs use random faults.** No single result is "right" in advance.
- **So the judge reads the fault log, then decides.**

| Found in the run | Verdict |
|---|---|
| The class's expected result | `pass` |
| A failure or escalation listed as an explained ending for a style that fired | `explained` |
| Anything else, truthful | `unexplained` |
| A failed truth check | `wrong` |

**Explained endings, kvfcu** (in the fault profile set):

| Style that fired | Explained endings |
|---|---|
| `maintenance` | `failed`, `app_error` |
| `error_page`, `blank`, `unavailable` | `failed`, `app_error` (handler limits used up) |
| `logout` | `failed`, `app_error` or `session_lost` |
| `hang` | `failed`, `checkpoint_timeout` or `action_failed` |
| Three or more faults in one run | `escalated` takeover, `stuck` (ladder limits) |
| Any fault during a reconciliation child | `failed`, `outputs_unavailable`, commit `found_by_check` |

- **The judge is lenient on counts.** It does not prove that exactly enough faults hit one step.
- **Why that is safe:** the matrix proves each single fault exactly. Stability measures toughness, not rules.

### 8.5 jev answers and truth

Every jev call in certify is stored in the report with its truth, where truth is known.

| jev job | Truth |
|---|---|
| Step trouble (rung 2) | The fault style that fired then, mapped to right answers by the jev truth table |
| Reconciliation | The oracle |

**jev truth table, kvfcu, examples:**

| Style on screen | Right answers |
|---|---|
| `known_popup` | `handler: kyc_reminder` |
| `maintenance` | `handler: maintenance` |
| `unknown_popup` | `needs_review`, `unsafe` |
| Any | Never `outcome`. No fault is a business outcome |

- **A jev answer can be right, wrong, or below threshold.** Only answers at or above threshold drive the run.
- **A wrong answer above threshold** that led to a wrong result is a `wrong` verdict. It also tightens thresholds (14.1).
- **Trouble with no fault in the log** has no automatic truth. It waits for a human label.

---

## 9. Certify scores, the gate, and timeouts

### 9.1 Outcome score

- **Outcome score** = `pass` verdicts ÷ judged runs in the baseline, matrix, extra, and drills.
- **`void` runs are left out. `wrong` runs count as not passing.**
- **The gate needs 1.0 in the baseline and matrix** (9.5). The score still helps: it tracks draft keys and trends.

### 9.2 Locator margin

**Margin:** the winner's vote score minus the runner-up's (section 7 §6.6).

- **Per target:** the lowest margin and the lowest winner score, across `pass` and `explained` runs. The median is shown too.
- **Batch margin:** the lowest target margin in the batch, with its step named.
- **Fragile step:** lowest margin below 0.30, or lowest winner score below 0.85.
- **Why the lowest, not the median:** fragility is about the worst case. A median hides the one near-tie.
- **Why 0.30 and 0.85:** twice the winning lead (0.15), and halfway from the win score (0.70) to 1.
- **The report also lists differing clues per target,** with their observed values (13.4).

### 9.3 Stability curve and flakiness

| Setting | Value | Why |
|---|---|---|
| Entropy levels | 0.05, 0.15, 0.30 | About one fault per run; two or three; a badly broken app |
| Seeds per level | 5 | Enough to see a pattern in under 30 minutes |
| Twins | Each seed runs twice | Measures flakiness |
| Class | The suite's `stability.class` | The richest path, usually `valid` |

**Per level, the curve reports:**

| Column | Meaning |
|---|---|
| `pass`, `explained`, `assisted`, `unexplained` | Rates |
| `wrong` | Count. Must be 0 |
| `faults` | Mean faults fired per run |
| `rungs` | Recoveries at rungs 1, 2, and 3 |
| `escalations` | Count, by reason |
| `twin_mismatch` | Share of twin pairs whose step traces differ |

- **Flakiness:** twin runs share seed, inputs, and frozen facts. Their step traces must match (section 3 §6.8).
- **A mismatch is real.** Example: a slow request beats the timeout in one twin only. The timeout is too tight.
- **This is the brief's "multi-run stability" signal.** The curve shows toughness. Twins show flakiness.

```json
"stability": [
  { "entropy": 0.05, "runs": 10, "pass": 0.8, "explained": 0.2, "assisted": 0.0, "unexplained": 0.0, "wrong": 0,
    "faults": 0.9, "rungs": { "1": 8, "2": 1, "3": 0 }, "escalations": {}, "twin_mismatch": 0.0 },
  { "entropy": 0.15, "runs": 10, "pass": 0.4, "explained": 0.4, "assisted": 0.1, "unexplained": 0.1, "wrong": 0,
    "faults": 2.6, "rungs": { "1": 21, "2": 3, "3": 1 }, "escalations": { "stuck": 1 }, "twin_mismatch": 0.0 },
  { "entropy": 0.30, "runs": 10, "pass": 0.2, "explained": 0.7, "assisted": 0.0, "unexplained": 0.1, "wrong": 0,
    "faults": 5.1, "rungs": { "1": 34, "2": 6, "3": 2 }, "escalations": { "stuck": 4 }, "twin_mismatch": 0.2 }
]
```

### 9.4 Coverage

- **The report lists each fault style, and whether it fired** with the helper window open and closed.
- **Gaps are shown first.** Example: "`hang` after the commit: never fired in this batch."
- **Why:** a passing batch that never met a fault proves little. The approver must see what was not tested.

### 9.5 The gate

A batch passes the gate when all hold:

1. **It is `full`, complete, and not a drill.**
2. **Zero `wrong` verdicts,** anywhere in the batch.
3. **Baseline: every run `pass`.** The twin pair has identical step traces.
4. **Matrix: every run `pass`.** Help counts as `pass` only where the profile expects it.
5. **Extra cases: every run `pass`.**
6. **No case left `void`.**

- **Stability has no rate floor.** Only rule 2 applies to it. The curve informs the approver.
- **Why no floor:** at entropy 0.30, safe failure is the right answer. A floor would reward guessing.
- **Why 100% in the baseline and matrix:** these runs are exact. A failure repeats on demand, so it is a defect, not noise.
- **A weaker harness:** the gate asks for every case the harness can run. The report lists the rest as coverage gaps.
- **Two checks happen at approval time,** not batch time: freshness and links (10.4).

### 9.6 Tuned timeouts

**Samples.** A step's observed time runs from its action to its checkpoint passing.

- **Only clean samples count:** first attempt, no ladder line, step result `passed`.
- **From every part of the batch:** baseline, matrix (steps other than the faulted one), and stability.
- **Only at delay scale 1.** CONTRACT §4: `KVFCU_DELAY_SCALE` shortens real waits. Fast samples would give short timeouts.
- **Cross-check:** the fault log records nominal delays. A request with a 5 s or longer delay must show a step time of 5 s or more. If not, the batch was scaled. No proposals, and the report says so.

**Proposal per step,** with at least 20 samples:

- **Value** = the largest of: the floor, 1.5 × the 95th percentile, and 1.2 × the longest sample.
- **Rounded up** to 500 ms. **Capped** at 60 s.
- **Floors:** fill steps 5 s, request steps 10 s, the commit step 15 s. Same as section 6 §14.11.
- **Fewer than 20 samples:** no proposal. The step keeps its current value.

**Candidate, then approved:**

| Value | Used by | Becomes the next |
|---|---|---|
| `approved` | Live replay, for approved and degraded keys | — |
| `candidate` | Certify runs of this key | `approved`, at the next approval of a batch that ran with it |
| Artifact default | Draft keys, and steps with no tuned value | — |

- **Approving a batch installs the timeouts that batch ran with.** Those are tested.
- **The batch's own proposals become the new candidates.** The next batch tests them.
- **So a first approval uses defaults.** Tuned values arrive with the next batch: a re-certify or a regression batch.
- **Why this order:** test what you ship. An untested short timeout could fail every slow request in production.
- **Live runs never change timeouts.** They only raise alerts (12.4).
- **Certify logs `timeout_source: candidate`** for candidate values (update file, section 7).

### 9.7 Report summary, example

```json
{
  "schema": "intyy.batch_report/1.0",
  "batch_id": "batch_2026-09-26_3fk8q2m7xa", "kind": "full", "drill": false,
  "key": { "capability": "kvfcu/open_share_subaccount@1.0.0", "tenant": "keystone",
           "app_version": "9.2", "patch_revision": null },
  "under": { "engine": "0.4.0", "handler_set": "sha256:4b0a…", "jev": "jev@1.4.2",
             "policy": "sha256:e71d…", "session": "kvfcu/sign_in@1.0.0",
             "check": "kvfcu/find_account_by_reference@1.0.0" },
  "instance": { "variant": "keystone", "delay_scale": 1, "strip_semantics": false, "drop_labels": 0 },
  "gate": { "passed": true, "rules": { "complete": true, "no_wrong": true, "baseline": true,
            "matrix": true, "extra": true, "no_void": true } },
  "outcome_score": 1.0,
  "verdicts": { "pass": 56, "explained": 13, "assisted": 1, "unexplained": 2, "wrong": 0, "void": 0 },
  "margin": { "lowest": 0.24, "step": "open_member",
              "targets": { "member_row": { "lowest": 0.24, "median": 0.52, "score_low": 0.91 } } },
  "fragile": ["open_member"],
  "coverage_gaps": ["hang with the window closed", "logout with the window closed"],
  "timeouts": { "proposed": { "click_search": 10000, "click_submit": 15000 },
                "not_proposed": { "open_subaccount_form": "14 samples" } },
  "jev": { "step": { "right": 5, "wrong": 0, "below": 2 },
           "reconciliation": { "right": 4, "wrong": 0, "unclear": 3 } }
}
```

---

## 10. Approval

### 10.1 Roles

| Role | May |
|---|---|
| `operator` | Run discovery and replays, handle interventions, start batches. Also demote, retire, and revoke autonomy |
| `reviewer` | Review candidates, seal artifacts, patches, packs, and suites |
| `approver` | Approve, reject, restore, reinstate, exclude, grant autonomy. Also demote, retire, and revoke autonomy |

- **Giving trust needs an approver:** approve, restore, reinstate, exclude, grant autonomy.
- **Taking trust away needs an operator or an approver:** demote, retire, revoke autonomy.
- **Why:** principle 2.2. Stopping a bad recipe should be easy.
- **Staff IDs and roles come from `library/staff.json`** (`intyy.staff/1.0`), per tenant (section 9 §7.7).
- **Known limit:** in the build, identity is self-declared, like the caller block (section 3 §4.2).

### 10.2 Four eyes, in two places

| Where | Rule | Why |
|---|---|---|
| Sealing | A risk flag lowered from `irreversible` needs a second look by another staff ID | A single wrong lowering can let an irreversible click run without a pause |
| Approval | The approver is not the staff ID that sealed the artifact, or the patch in the key | Nobody trusts their own work into production |

**Second look at sealing:**

- **"Lowered" means:** the rules' class was `irreversible`, including unsure. The human decision is lower.
- **A second staff ID confirms each one.** Recorded as a new decision kind, `risk_second_look`.
- **Sealing fails without it.** New sealing rule, for artifacts and packs (update file, sections 2, 5, 6).
- **Why at sealing, not approval:** supervised runs on draft keys already obey the flag. The check must come first.
- **Answers section 4 §7.11:** built, not design only. It costs one decision kind and one sealing check.
- **The same rule extends to suites, test data sets, fault profile sets, threshold records, and major records.** Their approver is never their sealer.
- **These five kinds need an approver on `*`.**

### 10.3 What the approver sees

1. **The key,** and what changed since the context's current approved key: version, patch, or both.
2. **The gate:** each rule, passed or failed.
3. **Freshness:** the batch's engine version and handler set against today's.
4. **Links:** the session and check capabilities, and their state in this context.
5. **Verdicts,** with a link to each run that was not `pass`.
6. **Fragile steps:** margins, winner scores, and differing clues.
7. **Coverage gaps.**
8. **The stability curve and twin mismatches.**
9. **Timeouts:** what this approval installs, and the new candidates.
10. **Lowered risk flags,** with both staff IDs.
11. **jev table,** and whether reconciliation autonomy is ready (14.2).
12. **Supervised live runs on this key,** if any. Burn-in evidence only (12.6).
13. **Sealing warnings** still open, such as a fragile target.

### 10.4 Rules to approve

1. **The batch passed the gate** (9.5).
2. **The batch is fresh:** its engine version and handler set hash equal what a live run would freeze now.
3. **Links are approved in this context:** the session capability, and for `commits` the check capability.
4. **Each fragile step is acknowledged** in writing.
5. **The approver holds the `approver` role** for this tenant, and did not seal the key's artifact or patch.

- **Stale batch:** re-run it. A regression batch does not count here. It covers approved keys only.
- **Different link keys** than the batch used: a warning. The links have their own evidence.
- **Why fragile steps do not block:** some controls are truly alike. Blocking stalls work; hiding risk is worse. A written note is the middle.

### 10.5 What approval does

1. **Writes an `approved` history line.**
2. **Retires the context's previous approved key,** for the same major, with a `retired` line. In-flight runs finish on their frozen facts.
3. **Installs timeouts:** the values the batch ran with become `approved`. Its proposals become `candidate` (9.6).
4. **Offers reconciliation autonomy,** if it is ready (14.2).
5. **Quotes the record hash the approver read.** Every approve, restore, and autonomy grant carries it.

- **A changed record refuses the command,** exit 6.
- **Why:** a demotion or a new batch may land between reading and approving.

### 10.6 Reject and re-approve

- **Reject:** a `rejected` line with a note. The key stays as it was.
- **Re-approve:** a human approves a newer passing batch for an approved key. Timeouts and candidates move on (9.6).

### 10.7 Degraded

- **Degraded blocks unattended runs.** Code `context_not_approved`, reason `degraded`.
- **Supervised runs still work.**
- **Why block:** approval means "a human trusts this with no human at the start." When the evidence breaks, that trust is gone.
- **Why not keep running with warnings:** callers read results, not warnings about recipes. A broken recipe escalates every run. Humans drown.

### 10.8 Restore

A human restores a degraded key in one of two ways:

| Way | Needs |
|---|---|
| New evidence | A new fresh `full` batch that passes the gate |
| Excluded runs | The key was degraded by live rules, and a human excluded the runs that triggered them (12.5) |

- **The second way is for outages and bad test data.** It needs no new batch, but it needs a staff ID and a reason.

### 10.9 Retire and reinstate

- **Automatic retire:** a newer key for the same context and major is approved.
- **Human retire:** anytime, with a reason.
- **Reinstate:** a retired key goes back to `draft`. It then needs a fresh passing batch and an approval.
- **Rollback of a recipe** is exactly that: reinstate the older key, certify, approve. The newer key retires.
- **Why no automatic fallback** to the older key: a newer key usually exists because the screens changed. The older one would meet the same change.

### 10.10 Linked capabilities

**Order at a new bank:** `sign_in`, then the check capability, then the commit capability.

| Checked | Where | Rule |
|---|---|---|
| At approval | 10.4, rule 3 | Links must be approved in this context |
| At run start | Pre-run check 7 | Links must still be approved. Else `session_not_approved` or `reconciliation_not_approved` |

- **Why both:** approval prevents approving something that could never run alone. The run-start check catches later demotions.
- **No regression when a link's approved key changes.** The link has its own per-context evidence.
- **The seam between them is fixed:** the session ends on the start page; the task's first precondition checks it.

---

## 11. Resolver

**Job:** turn `app/capability@major` into one exact key for this context, by fixed rules.

### 11.1 Inputs

- **The caller's `app/capability@major`,** the tenant from the caller block, and the app version from bank settings.
- **The mode,** and an operator pin if the internal run spec has one.
- **The artifact store, the patch store, and score records.**

### 11.2 Candidates

1. **Sealed versions in that major** whose `runs_on.app_versions` matches the bank's app version.
2. **For each version:** "no patch", plus every sealed patch revision for this tenant whose `base` is that major.
3. **Each pair is a key.** Its state comes from its score record. No record means `draft`.

- **No sealed version fits:** rejected, `no_version_for_context` (pre-run check 5).
- **Retired keys are never candidates,** except by pin.

### 11.3 Unattended

- **Pick the one approved key** (principle 2.7).
- **None:** rejected, `context_not_approved`.

| Reason | When |
|---|---|
| `not_approved` | No key was ever approved here, or the last one retired with no successor |
| `degraded` | The latest approved key is degraded |
| `session_not_approved` | The linked session capability has no approved key here |

- **`reconciliation_not_approved`** uses the same reasons, `not_approved` and `degraded`, for the check capability.

### 11.4 Supervised

Take the first rule that finds a key:

1. **The approved key.**
2. **The newest certified key:** its latest full batch passed the gate.
3. **The newest sealed key,** unless its latest batch had a `wrong` verdict.

- **"Newest":** highest version by semver, then highest patch revision. "No patch" sorts lowest.
- **Why approved first:** a supervised caller on an approved context wants the trusted recipe.
- **Why certified before sealed:** a supervised run still acts on the real app. Tested beats new.
- **Why skip keys with a `wrong` verdict:** that recipe has lied about data. A human watching the start cannot see that.
- **A degraded key** can still be picked by rule 3. It is sealed, and its failures were honest.

### 11.5 Operator pin

- **An operator may pin an exact key** in the internal run spec. Supervised only.
- **Callers can never pin.** Their request names a major only (section 3 §4.3).
- **Use:** trying a new patch revision on real work, with a human confirming the start.

### 11.6 Certify

- **Certify pins the key under test.** No other rule applies.
- **Its links resolve by the supervised rules.** The batch records which link keys it used.

### 11.7 Linked capabilities

- **Session and check links resolve with the parent's mode,** by the same rules.
- **Unattended:** each link needs its approved key. Otherwise pre-run check 7 rejects.
- **The same `app_version` and tenant** apply to the links. Links never cross banks.

### 11.8 What gets frozen

New in `run_start.frozen` (update file, section 3):

```json
"approval": { "state": "approved", "batch": "batch_2026-09-26_3fk8q2m7xa", "record": "sha256:7d20…" },
"timeouts_from": "batch_2026-09-26_3fk8q2m7xa"
```

- **`approval.state`** is the key's state at run start: `approved`, `draft`, `degraded`, or `retired` (pinned).
- **`record`** is the hash of `record.json` at run start. An auditor can prove what the resolver saw.
- **Every unattended run can prove it ran under approval.**

### 11.9 Deprecating and retiring a major

- **A major record** (`intyy.major/1.0`) holds: `deprecated_on`, `successor`, `retires_on`, `by`, and `reason`.
- **An approver sets it,** once per capability major. It applies to every bank.

| Situation, per context | Callers see |
|---|---|
| Deprecated, successor not approved here | Nothing. No warning |
| Deprecated, successor approved here | Warning `major_version_deprecated`, with the date below |
| Past the retire date for this context | Rejected: `capability_not_found`, reason `major_retired`. The message names the successor |

- **Retire date per context** = the later of `retires_on`, and 90 days after the successor's first approval here.
- **Why per context:** never tell a caller to move to `@2` when `@2` does not yet run at its bank.
- **Why 90 days:** the caller's tool definition comes from the old contract. Agents and their owners need time to change.
- **Retiring a major** retires its keys in that context too.

---

## 12. Live scores and demotion

### 12.1 Which runs count

Replay runs from callers count, supervised and unattended. Certify runs never count.

| Class | Rule | In the score? |
|---|---|---|
| `clean` | `success` or `business_outcome`, decided by code. No rung 3 action. No takeover except from a `needs_human` handler | Yes, as good |
| `assisted` | `success` or `business_outcome`, but a rung 3 action, an outcome decided by jev or a human, or a takeover for `stuck` or `unsafe_state` | Yes, as not clean |
| `recipe_failure` | `failed` with a recipe code (12.2), or any run that ends with commit `uncertain` | Yes, as not clean |
| `app_failure` | `failed` with an app code (12.2) | No. Tracked as app health |
| `not_counted` | Rejected; intyy's own failures; `ended_by_operator`; `escalation_timeout`; excluded runs | No |

- **Approvals and start confirmations are not help.** They are the design working.
- **Rung 2 is not help either.** jev only names a handler, whose actions are gated. A `detector_missed` warning still feeds an alert (12.4).
- **Why `uncertain` counts as a recipe failure:** when unsure, assume the worst. It also always raises an alert.

### 12.2 Failure codes by class

| Class | Codes |
|---|---|
| Recipe | `precondition_failed`, `target_not_found`, `target_ambiguous`, `action_blocked`, `action_failed`, `checkpoint_timeout`, `output_parse_failed`, `run_timeout`, `undeclared_outcome`, `outputs_unavailable` |
| App | `app_unreachable`, `session_lost`, `app_error`, `permission_denied` |
| intyy | `internal_error`, `evidence_write_failed`, `secret_unavailable`, `handler_set_invalid` |
| Human | `ended_by_operator`, `escalation_timeout` |

- **`checkpoint_timeout` is a recipe code.** A slow bank past the tuned timeout means the timeout is wrong for this context.
- **`action_blocked` is a recipe code.** The live re-check blocked a control whose words changed. That is drift.
- **intyy failures raise an engine alert.** They say nothing about the recipe.

### 12.3 The score and the two rules

- **Live score** = clean ÷ (clean + assisted + recipe failures), over the last 50 counted runs.

| Rule | Trigger | Why |
|---|---|---|
| **Window rule** | At least 20 counted runs, and a live score below 0.90 | Slow drift: more help, more failures |
| **Streak rule** | 3 recipe failures in a row, same step and same code | A screen change breaks every run at one step. Waiting for 20 runs floods humans |

- **Either rule degrades an approved key at once,** with a `degraded` line, `by: live_score`.
- **Why a count window, not a time window:** a quiet context would go blind in a time window.
- **Why 50 and 0.90:** 5 unclean runs in 50 is past normal noise for a recipe that passed 100% in certify.
- **Why 3 for the streak:** two could be one odd member record. Three at one step is a pattern.
- **Prelude and check lines** feed the session and check keys by the same rules.

### 12.4 Early warnings

Alerts, not demotions:

| Alert | Trigger |
|---|---|
| `margin_drop` | A target's lowest live margin falls below 0.30, or below half its certify margin |
| `clue_drift` | The patch-drafting rule fires (13.4) |
| `detector_drift` | 3 or more `detector_missed` warnings for one handler in the window |
| `app_health` | App failures reach 30% of runs in the window |
| `timeout_pressure` | A step's clean time passes 80% of its timeout in 5 runs |
| `commit_uncertain` | Any live run ends with commit `uncertain` |
| `contradiction` | Any `reconciliation_contradiction` warning |

### 12.5 Excluding runs

- **An approver may exclude live runs** from the window, with a reason. Example: a known outage at the bank.
- **The record is rebuilt.** If no rule still fires, the approver may restore without a batch (10.8).
- **Excluded runs stay in `live.jsonl`,** marked by the `excluded` history line. Nothing is deleted.

### 12.6 Supervised runs on draft keys

- **They write live lines too.** A draft key builds a live score.
- **It is shown at approval as burn-in evidence.** It never replaces certify.
- **Why not:** live runs have no truth. A wrong "not found" looks like a clean run.

---

## 13. Drift patterns and patch drafts

### 13.1 The drift reader

- **Plain code.** It runs after every score write, and on demand as `drift report` (section 9 §9.7).
- **It reads live lines, history, and batch reports.** It writes `degraded` lines and alerts.
- **Alert format** (`intyy.alert/1.0`): ID, tenant, keys, pattern, evidence run IDs, suggested fix, state (`open`, `acted`, `dismissed`).

### 13.2 Patterns

The reader groups recent trouble by capability major, app version, step, and failure code.

| Pattern | Rule | Suggested fix |
|---|---|---|
| **One tenant** | The trouble appears at one tenant. Other tenants on the same version and app version are fine | Tenant patch for target or condition drift. Tenant handler for a new interruption |
| **One app version** | Two or more tenants on the same app version share the same step and code | New artifact version for that app version range: discovery with `derived_from` |
| **One step** | One target's margin falls. No failures yet | Review before it breaks. Often a patch draft |
| **One bank, many capabilities** | 3 or more keys at one tenant degrade within an hour, mostly app failures | Likely an outage. Check the bank, then exclude runs |

- **Why group by step and code:** a vendor change hits the same screen everywhere. A tenant change hits one bank.
- **The build has two tenants.** The one-app-version pattern is designed, and tested on fixtures only.

### 13.3 Tying a drop to a change

Every live line records the engine version, handler set hash, and jev version.

1. **Find the change point:** the first run of each key under the new value.
2. **Compare** the live score before and after, for keys that changed and keys that did not.
3. **Keys that changed dropped, and the others did not:** the alert names the change.

- **Example:** pack `app:kvfcu` revision 5 went live. Six keys switched hash. Five dropped. Keys still on the old hash are fine. The alert names revision 5.
- **The same test runs for engine and jev versions,** and for a new session key in a context.

### 13.4 Patch drafting

> **Changed by section 10:** Not built. See `intyy-design-updates-from-section-10.md` §11.

**Job:** turn repeated clue disagreements into a candidate tenant patch. A human reviews it. Replay never edits itself.

**First, a log change.** `target_vote` must say what it saw, not only which clues differed (update file, sections 3 and 7).

| Differing clue | Logged observed value |
|---|---|
| `name`, `label`, `text` | The masked text. Button-like controls only, by the text rules (section 4 §9.10) |
| `region` | The numbers |
| `path` | The masked path |
| `image` | The likeness only. No new crop |

**Sources and thresholds:**

| Source | Drafts when |
|---|---|
| A differing clue on a clear winner | Same target, same clue, same observed value, in 5 runs at one tenant, and in 80% of that target's votes in the window |
| A reviewer `patch_needed` fix | 2 fixes on the same step that agree on the new control's name, label, or text |
| A human takeover on target trouble | 2 takeovers where the human clicked matching controls, and the step's checkpoint then passed |
| A certify batch | A differing clue with the same value in every baseline run |

- **Other tenants on the same version must not show it.** Otherwise the one-app-version pattern applies instead.
- **Why 5 and 80% for live winners:** the target still works. There is time to be sure.
- **Why 2 for failures:** the target already fails. Each run costs a human.

**What a draft holds:**

- **A candidate `intyy.patch/1.0`** for the tenant and the major, at the next revision.
- **Changed clues only,** set to the observed values. Everything else inherits.
- **`provenance.runs`** lists the source runs, with kind `replay` or `certify`.
- **The alert links to it.** A reviewer edits, seals, and then certifies the new key.

**What drafting cannot do:**

- **New crops.** Replay takes no crops. An `image` change needs a discovery or a manual crop.
- **Structural change.** A new screen or step is a new artifact version (section 2 §18.3).
- **Condition text, in the build.** Drafting outcome or checkpoint text from takeover screens is designed only. It would reuse section 5 §12.3's detector drafting.

### 13.5 The lakeshore drill

> **Changed by section 10:** Replaced in the build by an optional probe. See `intyy-design-updates-from-section-10.md` §11.

CONTRACT §4: `lakeshore` runs the same vendor app, with small screen differences. This is the brief's cross-tenant stretch goal.

1. **Keystone approves** `open_share_subaccount@1.0.0`.
2. **Lakeshore has no record.** Unattended requests are rejected, `not_approved`.
3. **An operator certifies the same version** on a bank app started with `KVFCU_VARIANT=lakeshore`.
4. **Baseline votes show differing clues** at one or two steps. Some may fail and need the reviewer.
5. **The drafter writes lakeshore patch revision 1.**
6. **A reviewer seals it.** Certify runs again, on the new key. The gate passes.
7. **An approver approves** `(1.0.0, lakeshore, 9.2, patch 1)`.

- **One recording, two banks.** Lakeshore needed a small file, not a new discovery.
- **The same drill with `KVFCU_DROP_LABELS`:** labels lose their markup tie. The `name` clue goes missing; the visible `label` still agrees. Margins should hold. The drill proves it.

---

## 14. Model trust

### 14.1 jev thresholds

**A push-back first.** The handoff asked to tune thresholds per context from certify data.

- **A batch holds about 10 jev calls.** Tuning a threshold on 10 samples fits noise, not behavior.
- **jev's behavior depends on jev's version and the app's screens,** far more than on one bank's data.

**Decision:**

| Level | Holds | Set by |
|---|---|---|
| App and jev version (`intyy.thresholds/1.0`) | `handler_min`, `outcome_min`, `reconciliation_min` | Pooled, labelled calls from every batch on that app |
| Context (score record) | Tightenings only | Automatic, after a wrong answer in this context |

- **Effective threshold per run** = the higher of the two. Frozen per run, as today.
- **Starting values:** 0.80, 0.95, 0.90 (section 5 §10.4).

**Calibration rules:**

| Threshold | Target | Why |
|---|---|---|
| `outcome_min` | Zero wrong answers at or above it, in the pool | A wrong outcome reaches the caller as fact |
| `reconciliation_min` | Zero wrong answers at or above it | A wrong "not found" invites a retry |
| `handler_min` | Wrong answers at or above it: 5% or fewer | A wrong handler only costs an attempt. Its actions stay gated |

- **Raising is automatic.** A wrong answer at confidence c raises the context's threshold to c + 0.01, capped at 1.0. The app-level value rises the same way at its next calibration.
- **Lowering needs 100 or more labelled calls for that answer type,** a proposal, and a human approval.
- **At 1.0,** jev can never reach that answer. The rung simply climbs.
- **Labels come from 8.5.** Trouble with no fault in the log needs a human label first.
- **The build keeps the starting values.** It produces the jev table in every report. Calibration is designed only.

### 14.2 Reconciliation autonomy

**Scope:** the parent key, plus the check key, plus the jev version. A new check key or jev version starts over.

**Evidence** (earned in certify only, against the oracle):

- **A jev reconciliation answer counts** when it says `found` or `not_found` at or above `reconciliation_min`.
- **It is correct** when the oracle agrees.
- **`unclear` never counts,** either way. It goes to a human, which is safe.

**Ready when:** 20 correct, with at least 5 `found` and 5 `not_found`, and zero wrong. Across batches for the same scope.

- **Why both kinds:** a jev that always says `found` would earn 20 on found cases alone.

**Drills make evidence.** Each drill pairs a commit fault with a fault on the check's last request step.

| Commit fault | Truth | Check fault |
|---|---|---|
| `drop_after_confirm` | Found | `maintenance` or `unknown_popup` |
| `server_error` | Not found | Same |

- **The check then fails,** so plain code cannot decide. jev reads the check's final screen.
- **Some drills give jev nothing to read,** like a maintenance page. `unclear` is then right, and adds nothing.
- **Some drills get fixed by the check's own ladder.** Plain code then decides. They still prove the check.
- **The report counts drills that produced evidence.**

**Record, in the score record:**

```json
"autonomy": {
  "state": "ready",
  "check": "kvfcu/find_account_by_reference@1.0.0", "check_patch": null, "jev": "jev@1.4.2",
  "evidence": { "correct": 21, "found": 12, "not_found": 9, "wrong": 0, "unclear": 7,
                "batches": ["batch_2026-09-26_3fk8q2m7xa", "batch_2026-09-28_8m2c4v6q1z"] },
  "granted": null,
  "revoked": null
}
```

| State | Means |
|---|---|
| `earning` | Collecting evidence |
| `ready` | Evidence complete. A human may grant |
| `granted` | Frozen per run as `reconciliation_autonomy: true` |
| `revoked` | Back to earning, with the evidence reset to zero |

- **A human grants it,** usually on the approval screen. Principle 2.2.

**Revoked automatically, with an alert, when:**

1. **A live spot check disagrees** with jev (1 in 20, section 5 §10.6).
2. **A human decides a reconciliation differently** from jev's answer.
3. **A certify batch finds a wrong jev reconciliation answer.**

- **Evidence resets to zero.** The revoking event shows the old evidence no longer describes today.

### 14.3 LLM tag agreement

- **Data:** `provenance.actions`, each with an LLM tag and a human tag (section 2 §17.3).
- **Grouped by:** app, discovery model, prompt version, and tag type. A new prompt starts over.

| Rule | Value |
|---|---|
| Ready | 50 or more reviewed actions of that tag type, agreement 0.98 or more, and no human changes in the last 20 |
| Granted | By a human, per tag type |
| Effect | The CLI pre-fills the human tag. The undecided-tag review issue stops blocking for that type |
| Never pre-filled | The commit point action; actions with a gate block or approval; human actions |
| Revoked | A human changes a pre-filled tag |

- **The build produces the agreement table.** Granting autonomy is designed only.
- **Why:** three or four discovery runs give about 40 actions. That is below the evidence rule.

### 14.4 Clue weights

- **Designed only.** Weights stay engine constants (section 7 §6.3).
- **Method:** collect per-clue agreement for winners and runners-up from certify votes. Fit weights that widen the lowest margins, and change no winner.
- **A new weight set is a new engine version.** It needs a regression batch on every approved context (15.5).
- **Why not now:** one app and two variants would overfit. Weights serve every app.

---

## 15. Pack, engine, and jev trust

### 15.1 Regression batch before a pack revision goes live

1. **A reviewer seals a candidate pack revision.**
2. **intyy finds the approved keys it would touch:** those whose frozen handler set hash would change.
3. **A regression batch runs for each:** baseline, matrix, and extra cases, with the candidate revision.
4. **The approver sees every result.** Approval of the pack needs all of them to pass the gate's rules 2 to 6.
5. **Approved means active** (section 5 §5.4). Live runs now freeze the new hash.

- **A failed regression blocks the pack.** It does not demote any key. The pack never went live.
- **Each key's record gains a `regression` entry** under the new hash. The existing approval stands on it.

### 15.2 Which contexts

| Pack scope | Contexts |
|---|---|
| Tenant | That tenant's approved keys whose hash changes |
| App version | Every tenant on that version range |
| App or global | Every tenant on that app, or every app |

- **The build runs all of them.** There are only a few.
- **At scale, designed only: sample.** One tenant per group of keys sharing version, app version, and new handler set hash. Plus every tenant with its own pack or patch that touches the changed handlers.
- **Why sampling is sound:** keys in one group run the same recipe with the same handlers. Only test data differs.

### 15.3 Live scores by handler set

- **Live lines carry the handler set hash** (5.5).
- **The record shows the live score** for the current hash and the one before it.
- **The drift reader ties drops to pack revisions** (13.3).

### 15.4 Rollback

- **Human only.** A reviewer seals a new revision with the old content (section 5 §5.4). It runs a regression batch like any other.
- **Why not automatic:** a rollback is itself a pack change. No human reviewed it. No regression tested it against today's contexts.
- **Meanwhile, live rules contain the damage.** Keys that broke degrade on their own. Unattended runs stop there.
- **The alert names the revision,** so the human rollback is quick.

### 15.5 Engine and jev versions

- **Same rule as packs.** A new engine or jev version runs a regression batch on approved contexts before it goes live.
- **In the build,** the CI fault table on the local bank app (section 5 §16) is the engine's regression.
- **jev autonomy and thresholds reset** per jev version (14.1, 14.2).

### 15.6 Policy revisions

- **No regression.** Policy layers only tighten (section 4 §4.2).
- **A tightening fails safely:** pre-run check 9 rejects, or the gate blocks a step. Nothing acts wrongly.
- **A policy change that drops handlers** changes the handler set hash. The live tie-in (13.3) still applies.

---

## 16. Worked examples

### 16.1 First approval at keystone

| # | Who | What | Result |
|---|---|---|---|
| 1 | Reviewer `op_017` | Seals `kvfcu/sign_in@1.0.0` | Key is `draft` |
| 2 | Operator | Full batch on `sign_in` | Gate passed |
| 3 | Approver `op_022` | Approves `sign_in` | `approved`. Not the sealer |
| 4 | Both | Same for `find_account_by_reference@1.0.0`, with a setup run | `approved` |
| 5 | `op_017` | Lowers "Remind Later" from unsure; `op_022` gives the second look | Pack seals |
| 6 | Operator | Full batch on `open_share_subaccount@1.0.0`: 72 runs | Gate passed. One fragile step: `open_member` |
| 7 | `op_022` | Reads the report. Acknowledges `open_member`. Approves | `approved`. Timeouts: defaults. Candidates set |
| 8 | Caller | Unattended request, `@1` | Resolver picks the one approved key. Runs |
| 9 | Operator, a week later | Re-certify | Candidates tested. `op_022` re-approves. Tuned timeouts go live |

**What the reply-lost case proved, in step 6:**

1. **`drop_after_confirm` on `click_submit`:** the bank opened the account, then lost the reply.
2. **The run reconciled** in a child run. The check found the account.
3. **Result:** `success`, commit `found_by_check`, and the account number from the check.
4. **The oracle said `count: 1`** for the run's notes text. The account number matched.
5. **Verdict `pass`.** The hardest promise holds: the caller knows the account exists.

### 16.2 A pack revision breaks one step

1. **Pack `app:kvfcu` revision 5 adds a handler** for a new notice. Its detector text is too broad.
2. **It also matches a banner** that shows only for members with a joint owner (invented).
3. **No test member has a joint owner.** Fixtures and the regression batch pass.
4. **Revision 5 goes live.** For joint-owner members, the pre-commit sweep matches the banner. The handler navigates away from the form.
5. **Those runs fail** `precondition_failed` at `click_submit`, commit `not_sent`. Honest and safe.
6. **After 30 runs, 6 have failed.** Live score 0.80. The window rule degrades `open_share_subaccount`. Unattended requests are rejected, `degraded`.
7. **The drift reader ties the drop to revision 5.** Keys still on the old hash are fine.
8. **A reviewer seals revision 6:** a narrower detector, and the banner page as a `no_fire` fixture. Regression passes. An approver approves it.
9. **The approver excludes the six runs,** reason "pack revision 5 fault." No rule still fires. The approver restores the key.

- **Nothing acted wrongly at any point.** The failures were honest, and demotion stopped the flood.
- **The gap was the test data.** Add a joint-owner member to the pool, if the app has one.

### 16.3 Lakeshore

See 13.5. One recording, one small patch, two approved banks.

---

## 17. Built, thin, or designed

> **Changed by section 10:** Patch drafting and the drill statuses changed. See `intyy-design-updates-from-section-10.md` §11.

| Item | Status | Why |
|---|---|---|
| Score store: three files per key, rebuild, lock | Built | Everything else reads it |
| Harness port, kvfcu adapter, fake twin | Built | Certify needs it |
| Certify runner: plan, route map, cases, seeds, setup runs, scripted operator | Built | The heart of "confidence and approval" |
| Scorer: truth checks, verdicts, fault-aware judge | Built | Judges against truth |
| Stability curve and twin runs | Built | The "multi-run stability" goal |
| Gate, approval, reject, restore, retire, reinstate, exclude | Built | Draft to approved, as the brief asks |
| Four eyes at approval; second look at sealing | Built | Small, and banks expect it |
| Resolver: unattended, supervised, pin | Built | Pre-run check 7 needs it |
| Tuned timeouts: candidate, then approved | Built | Cheap once samples exist |
| Live lines, live score, window and streak rules | Built | Demotion must be real |
| Reconciliation autonomy: evidence and drills | Built thin | Evidence counts and freezing. Earning needs several batches |
| Major records and deprecation warning | Built thin | One record and one warning |
| Regression batch for a pack revision | Built thin | Same runner, different key list |
| Drift reader: streak, window, handler set tie-in | Built thin | The patterns needing many tenants stay designed |
| Patch drafting from differing clues | Stretch | Needs the lakeshore drill. Build if time allows |
| jev threshold calibration | Designed. Report built | Too few labelled calls |
| Tag autonomy | Designed. Report built | Too few reviewed actions |
| Clue weight calibration | Designed | Engine-wide; would overfit |
| Sampled regression at scale | Designed | The build has few contexts |
| Certify on a bank's own test system, and reference evidence | Designed | Needs a real bank |

**Certify on a real bank's test system (designed only):**

- **Bank settings gain a certify target** for production banks: the origin of the bank's test system, its app version, and its secrets.
- **Why it helps:** a bank's test system upgrades first. Certify there, and approval is ready when production upgrades.
- **A test system with no fault controls** runs baseline and extra cases only. The report shows the gaps.
- **Reference evidence:** a vendor sandbox on the same app version may show the matrix. The approver weighs it. It never replaces the bank's own batch.

---

## 18. Tests that prove it

| Test | Proves | In CI? |
|---|---|---|
| Record rebuild golden test | Same history and live lines give the same record bytes | Yes |
| State machine | Every transition in 4.2; nothing moves up without a staff ID | Yes |
| Lock and atomic write | A crash mid-write leaves the old record whole | Yes |
| Route map | Fault log plus run log give the right step-to-route map | Yes, fake harness |
| Anchor expansion | `@each_request_step` makes one case per request step, none for fills | Yes |
| Truth checks | Each row of the commit truth table; double commit is `wrong` | Yes, fake oracle |
| Verdicts | Each verdict, on saved runs and fault logs | Yes |
| Fault-aware judge | Explained endings; lenient counts; unexplained cases | Yes |
| Gate | Each rule fails the gate on its own | Yes |
| Timeouts | 20-sample rule, formula, scaled-batch cross-check, candidate then approved | Yes |
| Approval rules | Fresh, links, four eyes, acknowledged fragile steps | Yes |
| Second look | Sealing fails without it; passes with another staff ID | Yes |
| Resolver | Unattended, supervised order, `wrong` skip, pin, links, retired keys | Yes |
| Live classes | Each failure code lands in its class | Yes |
| Window and streak rules | Degrade at the edges; exclusion and restore | Yes |
| Handler set tie-in | A drop after a hash change names the revision | Yes, fixtures |
| Autonomy | Balance rule; each revocation path resets evidence | Yes |
| Harness boundary | No replay-path module imports the harness port | Yes |
| Certify on the local bank app | A `quick` batch passes, with jev and the reviewer faked | Yes |
| Full batch | A real `full` batch on keystone, with real models | No. On demand, and once for `/evidence/` |
| Lakeshore drill | Draft patch, certify, approve | No. On demand, if built |

---

## 19. How this meets the brief

| Brief asks | Where |
|---|---|
| §8 Confidence and approval: score by replay reliability; gate unattended runs on draft to approved | 9, 10, 11.3 |
| §8 Multi-run stability: replay N times; report a stability or flakiness signal | 9.3 |
| §8 Canonicalization and cross-tenant reuse: a base artifact on a second variant, with overrides | 13.4, 13.5 |
| 3.3 Deterministic replay that verifies success | 8.2: every certify run checked against truth |
| 3.3 Business outcome apart from failure | 8.1, 8.3, 12.1 |
| 3.4 Risky actions handled conservatively | 10.2, 11.4 |
| 3.7 Reuse across tenants; detect and manage per-tenant and version drift | 5.1, 12, 13 |
| 7 Human-in-the-loop, earned model autonomy | 14.2 |
| 7 No scaling infrastructure | 5.2: plain files; 15.2: sampling designed, not built |

---

## 20. Rejected options

| Option | Why rejected |
|---|---|
| Engine version or handler set hash in the key | Every shared change would demote every key. Regression covers them |
| One record edited in place | No reason trail. History plus a rebuilt record keeps both |
| A database for scores | Plain files are enough and reviewable. The brief warns against infrastructure |
| Certify on production | It commits real changes and injects faults. Test environments only |
| The run calls the oracle | CONTRACT §8 forbids it. A run cannot grade itself |
| Route keys in profiles, by hand | CONTRACT keeps routes to be discovered. Anchors plus the route map instead |
| Mining seeds to hit random styles | The hash is not published. Stability covers those styles |
| A scripted human for takeovers | It would test the script. Handoff has its own tests |
| A pass rate below 100% for exact cases | Exact cases repeat on demand. A failure is a defect |
| A stability rate floor | At high chaos, safe failure is right. A floor rewards guessing |
| Median margin as the score | It hides the worst case |
| Timeouts from scaled-delay runs | Too short for real delays |
| Installing untested timeouts at approval | Test what you ship. Candidates first |
| Live runs adjusting timeouts | Behavior would change with no batch and no human |
| Degraded still runs unattended | Every run escalates. Humans drown; callers are surprised |
| Demote on any live failure | Outages would demote everything. App failures do not count |
| A time window for the live score | Quiet contexts go blind |
| Several approved keys per context | The resolver would have to choose. Audits get murky |
| Automatic fallback to an older key | The older key meets the same screen change |
| Trust carried across app versions | Trust is never inherited. Certify on the bank's test system first |
| Per-context jev thresholds from certify | About 10 calls per batch. It fits noise |
| Autonomy granted automatically | Only humans give trust |
| Automatic pack rollback | A rollback is an untested, unreviewed change |
| Regression on policy revisions | Policy only tightens. Tightening fails safely |
| Blocking approval on fragile steps | Some controls are truly alike. A written note instead |

---

## 21. Items parked for other sections

> **Changed by section 10:** Items for section 10 are resolved. See `intyy-design-updates-from-section-10.md` §11.

| Item | Section |
|---|---|
| CLI: certify (full, quick, regression, rerun a case), approve, reject, restore, retire, reinstate, exclude, grant autonomy, second look, major records, alerts, drift report, patch draft review, score rebuild | 9. Resolved: section 9 §9 |
| Port definitions: harness, score store, suite, test data, fault profile, alert, and major stores | 9. Resolved: section 9 §5.5, §5.8 |
| The scripted operator adapter, as a twin of the operator port | 9. Resolved: section 9 §5.4 |
| Instance lock: wait or fail fast, and for which origins | 9. Resolved: section 9 §12.2 |
| Staff roles in the CLI config | 9. Resolved: section 9 §7.7, in `library/staff.json` |
| File locations: score store, batch folders, suites, test data, fault profiles, thresholds, majors, alerts | 9. Resolved: section 9 §6 |
| Declaring instance facts when starting a batch | 9. Resolved: section 9 §9.2 |
| Bank settings certify target (a bank's test system) | Designed here. Format change, if built, after the take-home |
| Restricted-user case: a second credential set for test environments | 10: build or leave designed |
| Which batches and drills go in `/evidence/` | 10 |
| Milestone for certify and trust (M6) and its test gate | 10 |
| Whether to build patch drafting and the lakeshore drill | 10 |

---

## 22. Terms used in this section

| Term | Meaning |
|---|---|
| Key | Capability version, tenant, app version, patch revision |
| Score record | The current trust state of one key, rebuilt from logs |
| History line | One trust event, like an approval or a demotion |
| Live line | One real run's summary, for the live score |
| Certify suite | The reviewed test cases for one capability major |
| Class | A named group of inputs with one expected result |
| Test data set | Fake values per bank test environment, in pools |
| Pool | A named list of fake values, like missing members |
| Fault profile | Faults placed at steps, with the ending each must reach |
| Anchor | Where a fault goes: a step, or the commit point |
| Route map | Which requests each step sends, learned per batch |
| Harness | An app's test-only controls |
| Batch | All certify runs from one command, for one key |
| Plan | The batch's cases, written before it runs |
| Report | The batch's verdicts, scores, and gate result |
| Result class | Status plus its detail: code, or kind and reason |
| Truth check | A plain-code comparison with the oracle or baseline |
| Verdict | `pass`, `explained`, `assisted`, `unexplained`, `wrong`, or `void` |
| Fault-aware judge | Reads the fault log to decide which endings are honest |
| Outcome score | Passing runs over judged runs |
| Margin | Winner's score minus runner-up's |
| Fragile step | Lowest margin below 0.30, or winner score below 0.85 |
| Stability curve | Verdict rates at several entropy levels |
| Twin runs | Two runs with the same seed and inputs |
| Flakiness | Twin runs with different step traces |
| Coverage gap | A fault style that never fired in the batch |
| Gate | The rules a batch must pass before approval |
| Candidate timeout | A proposed value, tested by the next batch |
| Scripted operator | The operator stand-in during certify |
| Drill | A batch or case built to probe one thing: drift or reconciliation |
| Fresh | A batch that matches today's engine and handler set |
| Second look | Another staff ID confirming a flag lowered from irreversible |
| Live score | Clean runs over counted runs, last 50 |
| Window rule | Live score below 0.90 over 20 or more runs: degrade |
| Streak rule | 3 recipe failures in a row at one step: degrade |
| Alert | A drift finding for an operator |
| Change point | The first run under a new pack, engine, or jev version |
| Regression batch | A short certify on approved keys before a shared change |
| Autonomy | jev deciding reconciliations with only spot checks |
| Major record | Deprecation and retirement of a major version |
