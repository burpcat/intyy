# intyy — Section 5: handler packs and error ladder

> **Status:** complete, 24 Sep 2026.
> **Formats defined:** `intyy.pack/1.0`, `intyy.handler_draft/1.0`, `intyy.fixture/1.0`, `intyy.jev.step/1.0`, `intyy.jev.reconcile/1.0`, `intyy.reviewer.step/1.0`.
> **Amended by sections 6 and 7,** 25 Sep 2026: the `sign_in` action and re-login pattern, the frozen-set session filter, retry kinds, the resume rule after a takeover, jev and reviewer limits, the learned-handler exception, and resolved parked items. Formats are not yet released, so they are amended in place.
> **Amended by sections 8 and 9,** 25 Sep 2026: pack approval needs a regression batch, thresholds moved to `intyy.thresholds/1.0`, reconciliation autonomy records, candidate and draft file locations, and resolved parked items. Formats are not yet released, so they are amended in place.
> **Depends on:** sections 1 to 4, and `CONTRACT.md` 1.1.0 (the bank app).
> **Used by:** sections 6 to 10.
> **Changes to sections 1 to 4:** `intyy-design-updates-from-section-5.md`.
> **Names in examples:** app `kvfcu`, tenants `keystone` and `lakeshore`. These come from `CONTRACT.md` §4. Earlier sections used `sparrow-core` and `bank_a` as placeholders.
> **Illustrative detectors:** only screen text that `CONTRACT.md` states is real. Other screen text in examples is invented. Real text comes from discovery.

---

## Contents

1. [Purpose](#1-purpose)
2. [Design principles](#2-design-principles)
3. [New words](#3-new-words)
4. [The ladder in one view](#4-the-ladder-in-one-view)
5. [Handler pack file](#5-handler-pack-file)
6. [One handler](#6-one-handler)
7. [Scope, merge, and the frozen set](#7-scope-merge-and-the-frozen-set)
8. [The error ladder](#8-the-error-ladder)
9. [Business outcomes and packs](#9-business-outcomes-and-packs)
10. [jev](#10-jev)
11. [The reviewer LLM](#11-the-reviewer-llm)
12. [Learned handlers](#12-learned-handlers)
13. [Fixtures](#13-fixtures)
14. [The bank app's faults, rung by rung](#14-the-bank-apps-faults-rung-by-rung)
15. [Example pack files](#15-example-pack-files)
16. [Tests that prove it](#16-tests-that-prove-it)
17. [How this meets the brief](#17-how-this-meets-the-brief)
18. [Rejected options](#18-rejected-options)
19. [Items parked for other sections](#19-items-parked-for-other-sections)
20. [Terms used in this section](#20-terms-used-in-this-section)

---

## 1. Purpose

- **Replay hits trouble at runtime.** Pop-ups, expired sessions, error pages, slow loads.
- **This section decides who looks at the trouble, in what order, and what each may do.**
- **Handler packs hold the known cases,** as data. The ladder decides when to use them.
- **The goal:** fix what is safe to fix, report what is real, and ask a human for the rest.

---

## 2. Design principles

### 2.1 Plain code first, models last

- **Rung 1 is plain code.** Most trouble ends here.
- **Models join only when plain code cannot name the state.**
- **Why:** plain code gives the same answer every time. Models do not.

### 2.2 Helpers never act while a risky action is in flight

- **In flight:** an action was performed, and its checkpoint has not passed yet.
- **If that action was not `idempotent`,** no handler, retry, or reviewer may touch the screen.
- **Why:** in the bank app, every pop-up button re-sends the original request (CONTRACT §6.1).
- **Example:** a pop-up appears after Confirm. Clicking "Remind Later" would send Confirm again.

### 2.3 Only plain code may say "nothing changed"

- **After the commit action is sent,** only a declared outcome, matched by plain code, may mean `refused`.
- **jev and the reviewer never claim a refusal.** Everything else goes to the reconciliation check.
- **Why:** a wrong "nothing changed" invites a retry. A retry can open a second account.

### 2.4 Declared means declared

- **A capability returns only the business outcomes its contract declares,** at the steps that list them.
- **Packs never add outcomes to a capability at runtime.** Section 9 explains why.

### 2.5 A known screen with no progress is a failure. An unknown screen is a question

- **Still on the expected screen after retries:** the app is slow or broken. Fail, marked transient.
- **On a screen nobody recognizes:** climb the ladder. Someone may know it.

### 2.6 Every model touch is visible

- **jev verdicts log `by: jev`.** Reviewer actions log `by: reviewer`.
- **The result shows them too:** `recoveries` with rung 2 or 3, and `outcome.decided_by`.
- **A run with no rung 2 or 3 was fully model-free.** Auditors can check that in one field.

---

## 3. New words

| Word | Meaning | Example |
|---|---|---|
| **Trouble** | A step could not prove it worked | The checkpoint "form is showing" fails |
| **Helper** | Anything that acts to fix trouble: a handler, a retry, or the reviewer | A handler clicks "Remind Later" |
| **In flight** | An action was performed; its checkpoint has not passed yet | Confirm was clicked; no confirmation yet |
| **Helper window** | Whether helpers may act now. Open unless a non-`idempotent` action is in flight | Closed right after Confirm |
| **Pre-commit sweep** | One check of every handler detector, just before the irreversible click | A leftover pop-up is found and cleared first |
| **Resume rule** | Where replay continues after a fix | Back to the task's first step after `sign_in` |
| **Rewind floor** | The earliest step replay may go back to | The step after the commit point, once the commit is confirmed |
| **Frozen set** | The final handlers for one run, fixed at run start | Seven handlers from three packs |
| **Fixture** | A saved, masked screen used to test a detector | The KYC pop-up, captured from a test run |
| **Negative library** | Saved normal screens that no detector may match | Every screen seen in discovery |
| **Draft handler** | A proposed handler. Never loaded by replay | Drafted from a supervisor's takeover |

---

## 4. The ladder in one view

| Rung | Who | May act? | Ends in |
|---|---|---|---|
| 1 | Plain code: declared outcomes, handlers, retry | Handlers and retry, window open only | Outcome, recovered, hard failure, needs human, or climb |
| 2 | jev: sorts the screen | Never. It only names a handler or an outcome | Outcome, recovered (through a handler), needs human, or climb |
| 3 | Reviewer LLM | One action, `idempotent` by the rules, window open only | Recovered, or needs human |
| 4 | Human | Takes over the live session | Handed back, outcome set, or run ended |

- **Climb:** "this rung cannot answer; ask the next one." Not a result.
- **Rungs 2 and 3 are skipped when the window is closed.** See 8.2.
- **A bank may switch off rungs 2 and 3.** Then replay stays model-free always. See the update file (section 4).

---

## 5. Handler pack file

**Job:** hold a bundle of known interruptions for one scope, as reviewable data.

### 5.1 One file per scope

| Scope | Covers | File (location final in section 9) |
|---|---|---|
| Global | Every app | `packs/global.json` |
| App | One vendor app, all versions | `packs/apps/kvfcu.json` |
| App version | One vendor app, a version range | `packs/apps/kvfcu/versions/9x.json` |
| Tenant | One bank, one app | `packs/tenants/lakeshore/kvfcu.json` |

- **One file per scope keeps reviews small.** A bank's change touches only its own file.
- **The version file name is a free label.** The scope block inside holds the real version patterns.

### 5.2 Fields

| Field | Meaning | Example |
|---|---|---|
| `schema` | Format version | `"intyy.pack/1.0"` |
| `scope` | Which layer | `{ "level": "app", "app": "kvfcu" }` |
| `revision` | Counts up from 1 | `4` |
| `reason` | Why this revision exists | `"Adds the maintenance handler."` |
| `targets` | Named controls, artifact target format | See 5.3 |
| `conditions` | Named screen checks, artifact condition format | See 5.3 |
| `handlers` | The handlers | See section 6 |
| `disable` | Inherited handler IDs to switch off. Version and tenant scopes only | `["kyc_reminder"]` |
| `provenance` | Runs, decisions, sealed | Same shape as the artifact's |
| `approved` | Staff ID and time | `{ "by": "op_017", "at": "…" }` |

- **`scope.level` values:** `global`, `app`, `app_version`, `tenant`.
- **`app_version` scope adds `app_versions`:** wildcard patterns, like `["9.*"]`.
- **`tenant` scope adds `tenant` and `app`.**

### 5.3 A pack has its own targets and conditions

- **Handlers cannot use artifact targets.** A pack serves every capability of the app. It cannot know their IDs.
- **So a pack holds its own targets and conditions,** in the exact artifact formats (section 2 §13, §14).
- **Separate name spaces.** A pack's `ok_button` and an artifact's `ok_button` never meet.
- **Why the same formats:** one clue voter, one condition checker, one set of reviewer skills.

### 5.4 Revision, sealing, and approval

- **Revision is a plain counting number.** A pack has no callers, so semver adds nothing. Same as policy and patches.
- **Candidate, then sealed,** through the CLI. A candidate revision is `<rev>.candidate.json`. Sealing renames it to `<rev>.json`. A sealed revision never changes.
- **Approval sits in the file,** in `approved`, like policy (section 4 §4.5). The pack's approver is never its sealer.
- **The active revision per scope:** the highest sealed and approved one.
- **Rollback stays human only:** seal a new revision with the old content. Revisions only count up. It runs regression like any other.
- **Approval needs two things.** Every fixture passes in CI (section 13). A regression batch passes on each approved key whose handler set hash would change. `pack impact` lists those keys; `pack approve` checks their reports (section 9 §8.5).
- **A failed regression blocks the pack.** It demotes no key.
- **Sealing a pack also needs a second look for lowered flags** (section 4 §7.11).
- **Why:** a pack is shared. Its evidence must come from the keys it touches.

### 5.5 Why approval is not per context

- **Artifacts are approved per context,** because each capability is a separate promise to callers.
- **A pack is shared app knowledge,** like policy. It serves 300 banks and 20 capabilities at once.
- **Per-context approval would multiply review work** by every tenant, version, and capability.
- **Putting the handler set in the artifact approval key** would demote every artifact on each pack change.
- **Instead, trust comes from three checks:** fixtures in CI, a regression batch on the keys it touches (5.4), and live scores keyed by handler set hash. Live lines carry the handler set hash; the drift reader ties drops to pack revisions (section 8 §5.5, §13.3, §15.3).

### 5.6 Loader checks

The loader runs these on every pack file. Any failure stops the load.

**Format**

- `schema` is known and not newer than the loader. No unknown fields.
- IDs are lower snake case and unique within their kind, within the file.
- `disable` appears only at `app_version` and `tenant` scope.
- A handler's `app_versions` field appears only at `tenant` scope.

**References**

- Every target and condition reference resolves in this file or in a parent scope's active revision.
- `ref` chains do not loop.
- No `{input.*}` anywhere. Packs cannot know a capability's inputs.
- `{system.*}` only as `{system.last_good_path}`, only as a `navigate` location.
- `{secret.*}` only as the whole value of a `type` action.

**Detectors**

- No `field_value` checks. Fixtures hold no field values, so such a detector cannot be tested (13.2).
- No mask text inside detector text. Example: `[name#1]` is rejected.

**Actions**

- No `read` actions.
- Every action has `risk`, either `idempotent` or `reversible`. Never `irreversible` (section 4 §7.9).
- Every action's risk has a `risk` decision in `provenance`.
- `navigate` locations start with `/`, or are `{system.last_good_path}`.

**Classes**

- Each class has exactly its own fields. See 6.2.
- `hard_failure` names an allowed failure code.

**Overrides**

- A target, condition, or handler that reuses an inherited ID sets `"overrides": true`.
- A new ID must not set it. Checked at sealing, against the parents' active revisions.

**Checks that need the policy** (at sealing, and again at freeze)

- Every `{secret.*}` name is declared in the app policy layer.
- Every fixed `navigate` path sits inside the app's allowed paths.

---

## 6. One handler

### 6.1 Fields

| Field | Meaning | Required |
|---|---|---|
| `id` | Stable name, lower snake case | Yes |
| `description` | One plain sentence about the state | Yes |
| `class` | `business_outcome`, `recoverable`, `hard_failure`, or `needs_human` | Yes |
| `detector` | Condition ID that proves the state | Yes |
| `priority` | Integer. Higher wins a tie. Default `0` | No |
| `response` | Fixed list of actions. `recoverable` only | `recoverable` only |
| `delay_ms` | Pause before the response. For "try again later" screens | No |
| `done_when` | Condition ID that proves the response worked. Default: detector no longer matches | No |
| `wait_ms` | How long to wait for `done_when`. Default: engine value | No |
| `limits` | `per_step` and `per_run` attempt counts | `recoverable` only |
| `on_exhausted` | What happens when limits run out | `recoverable` only |
| `outcome` | `code` and `description` | `business_outcome` only |
| `failure` | Failure code | `hard_failure` only |
| `operator_note` | Plain instruction for the human | `needs_human` only |
| `app_versions` | Wildcard patterns this handler is limited to | No. Tenant scope only |
| `overrides` | `true` when it replaces an inherited handler | When replacing |
| `fixtures` | `fire` and `no_fire` fixture IDs | Yes |

### 6.2 Classes

| Class | Acts? | Result |
|---|---|---|
| `business_outcome` | No | The outcome, if the current step declares its code. Otherwise hard failure `undeclared_outcome` (section 9) |
| `recoverable` | Yes: `response` | Recovered, then the resume rule. Or `on_exhausted` |
| `hard_failure` | No | Failed, with `failure`. Allowed codes: `app_error`, `permission_denied` |
| `needs_human` | No | Takeover, reason `needs_human_handler`, with `operator_note` |

- **Only `recoverable` handlers act.** The other three classes only name the state.
- **So the helper window limits only `recoverable` handlers.** A naming handler may run any time.

### 6.3 Detector

- **A detector is one condition ID. Nothing else.**
- **Location limits go inside the condition,** with a `location` check. Say each thing once.
- **Handlers never name artifact steps.** Packs cannot know step IDs. Step IDs differ per capability.
- **Example:** "Branch closed" fits only the new-account page. Its detector holds `location: /accounts/new`.

### 6.4 Response

- **Action types:** the artifact's, except `read`: `navigate`, `click`, `type`, `select`, `set_checked`, `press`. Plus one handler-only action, `sign_in`.
- **Each action carries `risk`,** confirmed by a human at review. Section 4 §7.9 asked for this field.
- **`reversible` is allowed.** Example: `press Escape` closes a box; its base class is `reversible`.
- **At most five actions.** A longer fix is not an interruption. It is a capability.
- **An empty response is allowed.** It means "wait until `done_when`." Example: a "Please wait" page.

#### `type` values

| Value | Allowed | Why |
|---|---|---|
| Plain text | Yes | Fixed UI answers, like a search mode |
| `{secret.*}` | Yes, whole value only | A re-auth dialog over the current page, the one remaining case (6.4). Injection rules apply (section 4 §8.5) |
| `{input.*}` | No | A pack cannot know a capability's inputs |
| `{system.*}` | No | No use case |

#### `navigate` locations

- **A fixed path,** like `/home`.
- **Or `{system.last_good_path}`:** the page path and query where the last passed checkpoint held.
- **Both must sit inside the artifact's `runs_on.paths`** at act time. Else the gate blocks: `helper.path`.
- **Why the system value:** error and blank pages need "go back to where things worked." A pack cannot know that page.

#### `sign_in`: re-running the prelude

| Action | Fields | Rule |
|---|---|---|
| `sign_in` | none | Runs the prelude again, in the same browser. Last action in the response only. `risk` is `idempotent` |

- **The prelude's own steps pass the gate as actor `engine`,** as sealed artifact steps (section 6 §5, section 7 §10).
- **After `sign_in`, the resume rule runs over the task steps** (8.6). The rewind floor rules still hold.
- **Skipped during the prelude itself.** A `sign_in` handler firing while the prelude runs would loop, so the engine does not offer it there (section 7 §10).

#### Re-login: the recommended pattern

- **Was:** navigate to `/login`. Then the resume rule rewinds into the artifact's own login steps.
- **Now:** end the response with `sign_in`. The engine runs the session capability, then applies the resume rule.
- **Why:** login is now a session capability, run by the engine itself. One recipe, one place to patch (section 6 §5).
- **Keep `{secret.*}` typing for one case:** a re-auth dialog over the current page. There, rewinding cannot help.

### 6.5 `done_when` and waits

- **After the response, the engine waits for `done_when`,** up to `wait_ms`.
- **Default `done_when`:** the detector no longer matches. The pop-up is gone.
- **Set it explicitly when "gone" is wrong.** Example: after navigating to `{system.last_good_path}`, `done_when` is that page's own landmark.
- **`done_when` fails: the attempt failed.** It counts against the limits.

### 6.6 Limits and exhaustion

- **`per_step`:** attempts while working one step. **`per_run`:** attempts in the whole run.
- **The engine also has caps** (section 7). The lower number wins.
- **`on_exhausted` is required.** The author must decide. No silent default.

| `on_exhausted` | Example |
|---|---|
| `{ "class": "hard_failure", "failure": "app_error" }` | The error page keeps coming back |
| `{ "class": "needs_human", "operator_note": "…" }` | The KYC reminder keeps coming back |

### 6.7 Risk flags on actions

- **The rules class "Remind Later" as unsure.** No list word, and it is a button.
- **A human confirms it as `idempotent`** at review. That decision goes into pack `provenance`.
- **The live re-check still applies** (section 4 §7.8). Riskier words today: blocked.
- **Same rule as artifact steps:** machines raise risk; only humans lower it.

### 6.8 Handler ID and overrides

- **Format:** lower snake case, like every intyy ID. Example: `session_expired`.
- **Same ID in a more specific scope replaces the inherited handler,** whole.
- **`overrides: true` marks the replacement.** An accidental clash then fails at sealing.
- **The run log shows ID plus source scope and revision once,** in `run_start`. Elsewhere, the ID alone.

### 6.9 Example: the KYC reminder

`CONTRACT.md` §6.1 states this pop-up's text and buttons. So this handler can be written by hand.

```json
{
  "id": "kyc_reminder",
  "description": "The app interrupts with a request to update member KYC details.",
  "class": "recoverable",
  "detector": "kyc_popup_shown",
  "priority": 0,
  "response": [
    { "type": "click", "target": "kyc_remind_later", "risk": "idempotent" }
  ],
  "limits": { "per_step": 2, "per_run": 3 },
  "on_exhausted": { "class": "needs_human",
                    "operator_note": "The KYC reminder keeps returning. Clear it, then hand back." },
  "fixtures": { "fire": ["kyc_popup_on_form_01"], "no_fire": ["member_page_normal_01"] }
}
```

Its target and condition, in the same pack:

```json
"targets": [
  { "id": "kyc_remind_later", "description": "Remind Later button on the KYC reminder",
    "clues": { "role": "button", "name": "Remind Later", "text": "Remind Later" } }
],
"conditions": [
  { "id": "kyc_popup_shown", "check": "all_of", "description": "The KYC reminder is showing",
    "checks": [
      { "check": "text_visible", "text": "Please update member KYC details", "match": "contains" },
      { "check": "element_visible", "target": "kyc_remind_later" }
    ] }
]
```

- **Why "Remind Later," not "OK":** both re-send the request. "Remind Later" makes no claim about member records.
- **After the click,** the original request goes again. The step's checkpoint usually passes at once (8.6).

---

## 7. Scope, merge, and the frozen set

### 7.1 Four scopes, most specific wins

| Order | Scope | Chosen by |
|---|---|---|
| 1 | Tenant | The run's tenant and app |
| 2 | App version | The bank's app version, from bank settings |
| 3 | App | The run's app |
| 4 | Global | Always |

- **At most one app-version pack may match a version.** Sealing checks that patterns do not overlap.
- **Handler packs keep the app-version layer.** Policy dropped it (section 4 §4.1). Vendor releases change screens, not safety rules.

### 7.2 Merge by ID

- **Targets, conditions, and handlers each merge by ID.** The most specific scope wins the whole object.
- **No field-level merge.** A reviewer sees one complete object, not a sum of four files.
- **A tenant can replace just one condition.** Every handler that uses it then sees the tenant's text.
- **Example:** Lakeshore words its maintenance page differently. Its pack replaces `maintenance_shown`. The handler stays inherited.
- **The CLI lists every handler that uses a replaced condition.** No surprise reach.

### 7.3 Switching off

- **`disable` lists inherited handler IDs.** Version and tenant packs only.
- **A disabled ID that does not exist:** warning `handler_disable_unknown` at freeze. Not fatal.
- **Why not fatal:** the parent may have removed it. Removing a handler is the safe direction.

### 7.4 Building the frozen set

At run start, after pre-run checks, before the browser opens:

1. **Load** the active revision of each matching scope.
2. **Merge** targets, conditions, and handlers by ID (7.2).
3. **Apply `disable`** lists.
4. **Drop handlers whose `app_versions` do not match** the bank's version.
5. **Policy filter.** Drop handlers that break the effective policy: action types, keys, secrets, paths. Warning `handler_excluded_by_policy`.
6. **Artifact filter.** Drop handlers whose fixed `navigate` paths fall outside `runs_on.paths`. Warning `handler_excluded_by_paths`.
7. **Session filter.** Drop handlers that use `sign_in` when the artifact has no `session` link. Warning `handler_excluded_no_session` (section 6 §5).
8. **Validate.** Every reference resolves. Any break: the run fails, code `handler_set_invalid`, phase `start`. No browser opens.
9. **Hash** the final set, with the targets and conditions it uses, as canonical JSON.
10. **Log** it in `run_start`.

- **Dropping is always safe.** A missing handler only means more climbing.
- **Why step 6 exists:** a handler must not lead a capability onto pages the capability never declared.

### 7.5 What `run_start` records

```json
"handlers": {
  "ids": ["app_error_page", "blank_page", "kyc_reminder", "maintenance", "session_expired"],
  "packs": { "global": 2, "app:kvfcu": 4, "tenant:lakeshore/kvfcu": 1 },
  "from": { "blank_page": "global", "maintenance": "app:kvfcu", "session_expired": "app:kvfcu",
            "app_error_page": "app:kvfcu", "kyc_reminder": "app:kvfcu" },
  "hash": "sha256:4b0a…"
}
```

- **`packs`:** each scope's revision. **`from`:** where each handler came from.
- **The hash covers overrides too.** Lakeshore's replaced condition changes the hash.
- **Other lines name the handler ID only.** `run_start` explains the rest.

### 7.6 When two handlers match

1. **Most specific scope wins.** A tenant handler knows more than a global one.
2. **Then the higher `priority` wins.**
3. **Still tied: climb to rung 2,** with the tied IDs as candidates. jev picks one or says "needs review."

- **CI catches most ties early.** Two detectors that fire on the same fixture must have a priority order (13.4).

---

## 8. The error ladder

### 8.1 What starts it

| Trouble | Phase | Starts the ladder? |
|---|---|---|
| Precondition fails after its wait | `precondition` | Yes |
| No clear target winner | `target` | Yes |
| The surface could not act. Example: a pop-up blocks the click | `action` | Yes |
| Checkpoint fails after its wait | `checkpoint` | Yes |
| A handler detector matches in the pre-commit sweep | `precondition` | Yes (8.3) |
| The gate blocks an engine step | `gate` | No. Hard failure `action_blocked`. A rule is not a passing fault |
| The network guard blocks a page | `gate` | No. Same |
| Read text does not convert to its type | `extract` | No. Hard failure `output_parse_failed`. The screen was right |

- **Declared outcomes race the checkpoint during the wait.** "Not found" does not wait out the whole timeout.
- **An outcome that wins the race is logged as rung 1.** Same result as finding it later.
- **Discovery does not use the ladder.** The discovery LLM handles its own trouble.
- **Replay, certify, and reconciliation runs use it.**

### 8.2 The helper window

- **Open:** no action is in flight, or the one in flight is `idempotent`.
- **Closed:** a `reversible` or `irreversible` action is in flight.

| | Window open | Window closed |
|---|---|---|
| Declared outcomes | Yes | Yes |
| Naming handlers (outcome, hard failure, needs human) | Yes | Yes |
| `recoverable` handlers | Yes | No. Logged as matched, not run: warning `handler_matched_not_run` |
| Retry | Yes | No |
| Rung 2 jev | Yes | Skipped |
| Rung 3 reviewer | Yes | Skipped |

**Closed window, commit in flight:**

1. **A declared outcome on the commit step:** `business_outcome`, commit `refused`.
2. **A `needs_human` handler matches:** takeover. Commit state `uncertain` meanwhile.
3. **Anything else:** commit `uncertain`. Go to the reconciliation check.

**Closed window, a `reversible` step in flight:**

- **Naming handlers still apply.** Otherwise: takeover, reason `stuck`.
- **Why not retry:** a second "Add row" adds a second row.

**The gate enforces it too.** A helper action while the window is closed: blocked, rule `risk.in_flight`. Two locks, as in section 4 §2.8.

**Every takeover opened while the commit is in flight** carries a fixed notice: "The commit action was already sent. Do not submit again."

### 8.3 Pre-commit sweep

- **Just before the commit action,** after its precondition passes, the engine checks every frozen detector once. No wait.
- **A match counts as trouble at `precondition`.** Nothing is in flight yet, so the window is open.
- **The ladder clears it.** Then the sweep runs again before the click.
- **Logged as `check` lines with role `sweep`.**
- **Why only the commit step:** it is the one click that cannot be undone. Elsewhere, failed checks catch interruptions.
- **Why not every step:** it adds delay and false matches on normal screens, for little gain.
- **Limit:** the sweep sees only what is on screen. A session that expired silently still shows the form. Reconciliation covers that case.

### 8.4 Rung 1, in order

1. **Window.** Work out whether it is open (8.2).
2. **Declared outcomes.** Check the step's `outcomes` conditions. Match: `business_outcome`.
3. **Handlers.** Check every frozen detector once, no wait. Pick by 7.6. Apply the winner's class (6.2).
4. **Retry.** No match, window open, trouble not `target_ambiguous`: apply the resume rule with no actions (8.5).
5. **Known screen, no progress.** Retries used up, and the step's precondition still passes: hard failure with the underlying code. `failure.ladder.ref` is `retry_limit`.
6. **Otherwise climb.** Rung 2, or rung 4 if the window is closed.

- **Target trouble always climbs at step 5.** A reviewer may find the control. Example: Search now reads Find.
- **Why handlers before retry:** a handler explains the trouble. A blind retry may just meet the same pop-up.

### 8.5 Retry

- **Retry is the resume rule with no response actions.**

| Kind | `ref` | Does |
|---|---|---|
| Plain retry | `retry.idempotent` | The resume rule, no actions |
| Transport retry | `retry.transport` | Go to `{system.last_good_path}`, then the resume rule. Only after a transport failure (section 7 §7.3) |

- **It covers slow pages and dropped clicks.** The checkpoint may have arrived late, or the step runs again.
- **It cannot fix a blank page.** No precondition passes there. The global `blank_page` handler does that.
- **Both kinds share the retry budget: 2 per step** (section 7 §8). This section sets only where retries sit.

### 8.6 The resume rule

**Job:** find where replay continues after any fix, by the same plain-code rule every time.

1. **Did the failed step act, and does its checkpoint pass now?** Mark it passed. Continue with the next step.
2. **Else, search back** from the failed step for the latest step whose precondition passes now.
3. **Extend back** while the step before also passes its precondition now. Resume at the earliest one.
4. **Else, not recovered.**

**Limits on the search:**

- **Never below the rewind floor.** The floor is step 1, or the step after the commit point once the commit is confirmed.
- **The steps to re-run must be safe to repeat.** Every step from the resume point to the failed step is `idempotent`. The failed step may be any class if it has not acted yet.
- **Preconditions are checked once, with no wait.** The fix already waited for `done_when`.

**Why step 1:** a pop-up button re-sends the original request. The step's result often appears at once. Acting again would double the request.

**Why step 3:** steps on one screen often share a precondition.

- **Example:** `type_username` and `type_password` both need "login page shows."
- **Taking the latest passing step picks `type_password`.** The user ID would stay empty.
- **Extending back picks `type_username`.** The whole screen is filled again.

**Not recovered:** the rung's "recovered" becomes "not recovered." The attempt counts. The ladder climbs.

**After a takeover:** forward search runs first (section 7 §16.2). This resume rule is the fallback, from the stuck step, when forward search finds nothing.

**Section 1 said "resume at the last good checkpoint."** This rule replaces that phrase. After a re-login, the last good checkpoint is on a page the session lost.

### 8.7 Rung 2: jev

- **jev gets the masked screen and the choices.** It names one. Section 10 has the formats.

| jev bucket | Condition | Verdict |
|---|---|---|
| `outcome` | Confidence ≥ `outcome_min`, code declared at this step | `business_outcome`, `decided_by: jev` |
| `handler` | Confidence ≥ `handler_min`, handler in the frozen set | Apply that handler's class |
| `needs_review` | Or any bucket below its threshold | Climb to rung 3 |
| `unsafe` | Any confidence | Takeover, reason `unsafe_state` |

- **Why `unsafe` at any confidence:** when unsure, assume the worst (section 4 §2.3).
- **jev may pick a handler whose detector did not match.** Then warning `detector_missed`. The detector may need a tenant override.
- **The picked handler keeps all its limits.** Window, risk flags, live re-check, and attempt counts still apply.
- **jev never picks an outcome on a commit step in flight.** Rung 2 is skipped there (8.2).

### 8.8 Rung 3: the reviewer LLM

- **One action for this stuck step.** Section 11 has the formats.
- **The action passes the gate** as actor `reviewer`: `idempotent` by the rules only.
- **Then:** the failed step's checkpoint passes, continue. Or its precondition passes, run the step again.
- **Anything else: takeover, reason `stuck`.**
- **The reviewer may give up.** Then takeover, reason `stuck`.

### 8.9 Rung 4: the human

- **Takeover reasons:** `stuck`, `unsafe_state`, `needs_human_handler` (section 3 §5.7).
- **The request carries:** the step, the trouble, the ladder lines so far, a masked screenshot, and any `operator_note`.
- **The lease, the capture, and where the bot resumes after handback:** section 7 §12, §14, and §16.
- **Every takeover can teach a handler** (section 12).

### 8.10 Verdicts and next moves

| Verdict | Next move | Run result, if it ends here |
|---|---|---|
| `business_outcome` | `end` | `business_outcome`. On the commit step: commit `refused` |
| `recovered` | `continue` or `resume_at` | Run goes on |
| `hard_failure` | `end`, or `reconcile` if the commit is in flight | `failed` with the code |
| `needs_human` | `takeover` | `escalated` until the human acts |
| `climb` | `rung_2`, `rung_3`, or `takeover` | Run goes on |

- **`next` values:** `continue`, `resume_at`, `rung_2`, `rung_3`, `takeover`, `reconcile`, `end`.
- **`resume_at` names the step** in `resume_at`. It replaces section 3's `resume_at_last_checkpoint`.

### 8.11 After the commit point

| Commit state | Helpers on later steps? | Rewind floor |
|---|---|---|
| In flight (sent, not verified) | No. Window closed | — |
| `confirmed` | Yes. Later steps are `read` steps, so `idempotent` | Step after the commit point |
| `refused` | Run already ended | — |
| `uncertain` | No. Reconciliation decides | — |

- **Session lost after `confirmed`:** no resume point exists past the floor. The run fails with commit `confirmed` and `safe_to_retry: false`.
- **Section 7 decides** whether the reconciliation check can then supply the missing outputs.

### 8.12 Ladder log lines

Every rung writes one `ladder` line.

| `data` field | Meaning | Example |
|---|---|---|
| `rung` | 1 to 4 | `1` |
| `verdict` | From 8.10 | `"recovered"` |
| `window` | `open` or `closed` | `"open"` |
| `matched` | Handler IDs whose detectors matched | `["session_expired"]` |
| `handler` | The handler applied, or `null` | `"session_expired"` |
| `attempt` | This handler's attempt count on this step | `1` |
| `bucket`, `confidence`, `threshold` | jev lines only | `"handler"`, `0.91`, `0.80` |
| `next` | From 8.10 | `"resume_at"` |
| `resume_at` | Step ID, or `null` | `"type_username"` |
| `input` | jev or reviewer input file, relative path | `"llm/jev_00031.json"` |

- **`why` per rung:** `handler` (ref: handler ID), `classifier` (ref: bucket), `llm_reason` (reviewer), `engine_rule` (ref: `outcome.declared`, `retry.idempotent`, `retry_limit`, `window.closed`).
- **Handler actions are `action` lines with `by: handler`.** The gate sees actor `handler`.
- **Matched detectors log a `check` line with role `handler`.** Non-matches log nothing, except at evidence level `full`.
- **The step trace includes verdicts, handler IDs, and `resume_at`.** It excludes confidences, like scores.

### 8.13 Walkthrough: the session expires

The run is on `open_account_form`. The session ends just before the request (CONTRACT §6.2, `session_expire`).

1. **Click.** The app shows its session-expired page. The checkpoint "form is showing" fails.
2. **Rung 1.** The step is `idempotent`, so the window is open. No declared outcomes here.
3. **Handlers.** `session_expired` matches.
4. **Response.** `sign_in`. The engine runs `kvfcu/sign_in@1` in the same browser.
5. **Resume rule.** The task's step 1 precondition passes on the home page. Extend back: nothing before it.
6. **Chain check.** Every task step up to `open_account_form` is `idempotent`. Allowed.
7. **Replay goes on** from the member search.

```jsonl
{"seq":41,"event":"check","step":"open_account_form","by":"engine","data":{"condition":"account_form_shown","role":"checkpoint","passed":false,"waited_ms":8000}}
{"seq":42,"event":"check","step":"open_account_form","by":"engine","data":{"condition":"session_expired_shown","role":"handler","passed":true}}
{"seq":43,"event":"gate","step":"open_account_form","by":"gate","why":{"kind":"policy","ref":"risk.allowed"},"data":{"actor":"handler","action":"sign_in","risk":"idempotent","decision":"allowed"}}
{"seq":44,"event":"action","step":"open_account_form","by":"handler","why":{"kind":"handler","ref":"session_expired"},"data":{"type":"sign_in","ok":true}}
{"seq":45,"event":"ladder","step":"open_account_form","by":"engine","why":{"kind":"handler","ref":"session_expired"},"data":{"rung":1,"verdict":"recovered","window":"open","matched":["session_expired"],"handler":"session_expired","attempt":1,"next":"resume_at","resume_at":"type_member_number"}}
```

The result then lists:

```json
"recoveries": [
  { "step": "open_account_form", "rung": 1, "via": "handler", "ref": "session_expired",
    "resumed_at": "type_member_number", "at": "2026-09-24T10:15:19.530Z" }
]
```

- **`recoveries[].resumed_at`** becomes the task's first step, `type_member_number` here.

---

## 9. Business outcomes and packs

### 9.1 The question

- **Some business states appear across many capabilities.** Example: "Account frozen."
- **Option A:** every capability declares every outcome it can return. Strict. Repetitive.
- **Option B:** packs hold app-wide outcomes. Any capability may return them. Flexible. Less explicit.

### 9.2 Decision: Option A, with an adoption shortcut

- **A capability returns only outcomes its contract declares,** at steps that list them.
- **Packs may hold `business_outcome` handlers** as an app-wide catalog.
- **At candidate review, the CLI offers to adopt them.** Adopting copies the code, description, and condition into the artifact.
- **Provenance records it:** an `outcome_name` decision with value `pack:<handler_id>`.

### 9.3 Why not Option B

- **The commit step.** An outcome there means "the app refused; nothing changed." A human confirms that per capability (section 2 §19.4). A pack outcome would skip that check.
- **Meaning depends on the task.** "Account frozen" ends an account opening. It may not matter to a balance lookup.
- **The caller's contract.** The agent's tool schema lists the outcomes it must handle. Option B would return codes that no schema promised.
- **The brief's warning.** Outcome versus failure is the most common mistake. A human decides it per capability, on the record.

### 9.4 At runtime

| Situation | Result |
|---|---|
| The artifact's own outcome condition matches | `business_outcome`, `decided_by: code` |
| A pack `business_outcome` handler matches, and the step lists its code | `business_outcome`, `decided_by: code`. A backup for tenant text drift |
| A pack `business_outcome` handler matches, code not declared here | `failed`, code `undeclared_outcome`, `transient: false`. Warning `outcome_not_declared` |
| Commit in flight, undeclared outcome | Commit `uncertain`. Reconciliation first |

- **`undeclared_outcome` message:** "The app showed a known state this capability does not declare:" plus the handler's description.
- **The operator's fix:** adopt the outcome. A new outcome is a minor version (section 2 §5.2).

---

## 10. jev

### 10.1 Two jobs

| Job | When | Answers |
|---|---|---|
| **Step trouble** | Rung 2 | Which handler or declared outcome fits this screen? Or "needs review," or "unsafe" |
| **Reconciliation** | Plain code cannot read the check's result | Did the commit happen? `found`, `not_found`, or `unclear` |

- **jev sorts. It never invents an action.** Every answer names something that already exists.

### 10.2 Step-trouble input

| Field | Content |
|---|---|
| `step` | ID, intent, action type, risk, phase |
| `expected` | The failed condition, its description, and its check trace. Masked |
| `last_good` | The last passed step and its location |
| `screen` | Location and the masked element list: role and name per element. Capped |
| `outcomes` | This step's declared outcomes: code and description |
| `handlers` | Every frozen handler: ID, class, description |
| `tied` | Handler IDs tied at rung 1, or empty |

- **No screenshot in the build.** Text is faster, cheaper, and the element list carries structure.
- **The format keeps an optional `screenshot` field.** Surfaces with no accessibility text will need it.
- **No element IDs.** jev never acts, so it never needs to point.
- **The stored file equals the sent input.** Written to `llm/jev_<seq>.json`.

```json
{
  "schema": "intyy.jev.step/1.0",
  "step": { "id": "open_account_form", "intent": "Open the new account form",
            "action": "click", "risk": "idempotent", "phase": "checkpoint" },
  "expected": { "condition": "account_form_shown", "description": "The new account form is showing",
                "trace": [ { "path": "account_form_shown", "check": "element_visible", "passed": false } ] },
  "last_good": { "step": "open_member", "location": "/members/{input.member_id}" },
  "screen": { "location": "/accounts/new", "truncated": false,
              "elements": [ { "role": "heading", "name": "Notice" },
                            { "role": "text", "name": "Branch profile review is pending." },
                            { "role": "button", "name": "Close" } ] },
  "outcomes": [],
  "handlers": [ { "id": "kyc_reminder", "class": "recoverable",
                  "description": "The app interrupts with a request to update member KYC details." },
                { "id": "session_expired", "class": "recoverable",
                  "description": "The app says the session has expired." } ],
  "tied": []
}
```

### 10.3 Step-trouble output

| Field | Content |
|---|---|
| `bucket` | `outcome`, `handler`, `needs_review`, or `unsafe` |
| `handler` | Handler ID, `handler` bucket only |
| `outcome` | Outcome code, `outcome` bucket only |
| `confidence` | 0 to 1 |

```json
{ "bucket": "needs_review", "handler": null, "outcome": null, "confidence": 0.71 }
```

- **Section 1 named the buckets** business outcome, recoverable, needs review, unsafe.
- **Renamed `outcome` and `handler`,** because a matched handler may be of any class. A known error page is a handler, not a recovery.

### 10.4 Thresholds

| Threshold | Gates | Build value |
|---|---|---|
| `handler_min` | `handler` bucket | 0.80 |
| `outcome_min` | `outcome` bucket | 0.95 |
| `reconciliation_min` | `found` and `not_found` | 0.90 (section 1 §19) |

- **An outcome needs more confidence than a handler.** An outcome ends the run and reaches the caller. A handler's actions are human-confirmed and gated.
- **Thresholds live per app and jev version,** in `intyy.thresholds/1.0`, from pooled labelled calls (section 8 §14.1).
- **A context holds tightenings only.** A wrong answer at confidence c raises that threshold to c + 0.01.
- **Lowering needs 100 or more labelled calls for that answer type, and a human.**
- **Effective threshold = the higher of the two.** Frozen per run, and logged.
- **The build keeps 0.80, 0.95, 0.90.** Every batch report shows the jev table.
- **Why the build does not tune per context:** a batch holds about 10 jev calls. Tuning on 10 samples fits noise.

### 10.5 Reconciliation input and output

- **Plain code decides first** (section 2 §16.2). `success` means found. A listed outcome means not found.
- **jev runs only for "anything else."** Example: the check run failed while reading, but its last screen shows a row.

| Input field | Content |
|---|---|
| `parent` | Capability, commit step ID and intent, correlation used (`notes` or `none`), last screen, masked |
| `check` | The check's capability, status, outcome code, failure (code, step, phase, trace), final screen, masked |
| `not_found_outcomes` | From the artifact's `recovery` block |

```json
{
  "schema": "intyy.jev.reconcile/1.0",
  "parent": { "capability": "kvfcu/open_share_subaccount@1",
              "commit_step": { "id": "click_confirm", "intent": "Confirm and open the sub-account" },
              "correlation": "notes",
              "last_screen": { "location": "/accounts/new", "elements": [ { "role": "heading", "name": "500 Internal Server Error" } ] } },
  "check": { "capability": "kvfcu/find_account_by_reference@1", "status": "failed", "outcome": null,
             "failure": { "code": "checkpoint_timeout", "step": "read_account_number", "phase": "checkpoint",
                          "trace": [ { "path": "account_detail_shown", "check": "element_visible", "passed": false } ] },
             "final_screen": { "location": "/members/{input.member_id}/accounts",
                               "elements": [ { "role": "row", "name": "[account#1] Share Savings OPEN {input.reference}" } ] } },
  "not_found_outcomes": ["not_found"]
}
```

| Output field | Content |
|---|---|
| `verdict` | `found`, `not_found`, or `unclear` |
| `confidence` | 0 to 1. Below `reconciliation_min` counts as `unclear` |

```json
{ "verdict": "found", "confidence": 0.93 }
```

- **The run ID shows as a reference** (`{input.reference}`) in the masked view. That makes matching plain to read.
- **jev decides the answer, never the action.** A retry after `not_found` always needs a human yes.

### 10.6 Second opinion and autonomy

- **Before autonomy,** the reviewer LLM gets the same input and gives the same output shape. No action.
- **Agree: accept.** Disagree: human, kind `reconciliation_decision`.
- **After autonomy,** the second opinion runs on about 1 in 20. The pick uses a hash of the run ID, so it is repeatable.
- **Disagreement revokes autonomy** and notifies an operator (section 1 §19).
- **Logged as `reconciliation` lines,** `by: jev` and `by: reviewer`.
- **Autonomy is frozen per run** as `reconciliation_autonomy`.
- **Records live in the parent key's score record** (section 8 §14.2).
- **Scope, evidence, grant, and revocation:** the parent key, the check key, and the jev version; 20 correct with 5 or more of each kind, zero wrong, then a human grants it (section 1 §19).

### 10.7 When jev fails

| Problem | Treated as |
|---|---|
| No answer in time | `needs_review`, confidence 0. Warning `classifier_unavailable` |
| Answer breaks the output schema | `needs_review`, confidence 0. Warning `classifier_invalid_output` |
| Names an unknown handler or undeclared outcome | Same |
| Reconciliation: any of the above | `unclear` |

- **jev never blocks the ladder.** A broken jev only means more climbing.
- **jev's time limit is 2 s** (section 7 §8). Past it, treated as "no answer in time."

### 10.8 Frozen facts

```json
"models": { "jev": "jev@1.4.2", "reviewer": "claude-sonnet-5" },
"ladder": { "jev": true, "reviewer": true,
            "handler_min": 0.80, "outcome_min": 0.95, "reconciliation_min": 0.90,
            "reconciliation_autonomy": false }
```

- **A new jev version can change verdicts.** So its version is frozen like the engine version.
- **`jev` and `reviewer` flags** come from the bank's policy switches (update file, section 4).

### 10.9 The CI fake

- **CI never calls jev.** The fake classifier reads a script per test.
- **A script is an ordered list:** expected task and step, then the canned output.
- **An unscripted call fails the test.** A test cannot quietly depend on a model.
- **The fake also plays timeouts and bad output,** to test 10.7.
- **The reviewer fake works the same way.**

---

## 11. The reviewer LLM

### 11.1 Input

| Field | Content |
|---|---|
| `step`, `expected`, `last_good` | Same as jev's |
| `screen` | Location, masked element list with element IDs, masked screenshot |
| `jev` | jev's bucket and confidence, as a hint |
| `inputs` | Input names only. It may type `{input.*}` |
| `allowed` | Action types, keys (Tab, Escape), and `runs_on.paths` |
| `commit` | Commit state. Always `not_sent` or `confirmed` here |

- **Screen text is marked untrusted** in the prompt, like discovery (section 4 §10.7).
- **The masked screenshot is needed.** The reviewer must judge layout, like a pop-up covering a form.
- **Stored in `llm/reviewer_<seq>.json`.** The stored copy is the sent copy.

### 11.2 Output

One tool call. Either an action:

```json
{ "action": { "type": "click", "element": "e4" },
  "reason": "A notice covers the page. Close should dismiss it.",
  "expected": "The new account form shows." }
```

Or a refusal:

```json
{ "give_up": true, "reason": "The screen asks for an approval I cannot give." }
```

- **One action. Never a list.** Section 1 set this.
- **`expected` goes in the log.** A reviewer can compare it with what happened.

### 11.3 After its action

1. **The gate checks it** as actor `reviewer` (section 4 §7.9). Blocked: takeover, `unsafe_state`.
2. **The engine waits** for the failed step's checkpoint or precondition, up to the step's timeout.
3. **Checkpoint passes:** recovered, continue.
4. **Precondition passes:** recovered, run the failed step again. Only if the step is `idempotent` or has not acted.
5. **Neither:** takeover, `stuck`.

- **No wider rewind for the reviewer.** It is the least trusted helper, so its fix must land exactly.
- **Example:** "Close" is a safe word. Allowed. "Acknowledge" is on no list. Unsure, so blocked. A human takes over.

### 11.4 Warnings and drafts

| Warning (log) | When |
|---|---|
| `patch_needed` | The reviewer did the step's own action on another control, and the checkpoint passed. Likely target drift |
| `handler_needed` | Any other successful reviewer fix. Likely a new interruption |

- **Each reviewer fix writes a draft handler** (section 12). `patch_needed` also feeds patch drafting (section 8).
- **`recoveries` shows `via: reviewer`,** ref `seq:<n>`: the action line.

### 11.5 Limits

- **One reviewer call per stuck step, and 2 per run** (section 7 §8).
- **Its time limit is 60 s** (section 7 §8).
- **Never while the window is closed.**
- **Never on a run whose bank switched rung 3 off.**

---

## 12. Learned handlers

### 12.1 Three sources

| Source | What it gives |
|---|---|
| **Recorder** | Discovery actions tagged `incidental`: "if you see this pop-up, click this." Section 6 writes the rules |
| **Takeover** | The screen when the human took over, and the human's actions |
| **Reviewer fix** | The screen before the reviewer acted, and its one action |

- **All three write the same draft file.** Replay never loads drafts.
- **A takeover that ended in `set_outcome` makes no pack draft.** It suggests an artifact outcome instead. Outcomes belong to capabilities (section 9).
- **A takeover caused by a `needs_human` handler writes no draft either.** The state is already known (section 7 §16.5).

### 12.2 Draft file

| Field | Meaning |
|---|---|
| `schema` | `"intyy.handler_draft/1.0"` |
| `id` | Proposed handler ID. The reviewer may rename it |
| `app` | Vendor app |
| `source` | `kind` (`recorder`, `takeover`, `reviewer`), run ID, log `seq` values, tenant, app version |
| `suggested_scope` | Always `tenant` at first. See 12.6 |
| `targets`, `conditions` | Drafted from fingerprints and screen text |
| `handler` | The proposed handler, in pack format |
| `risk_hints` | Per action: the rules' class, and the gate's `observed` class for human actions |
| `fixtures` | The captured trouble screen, as a `fire` fixture |

- **Location:** `library/drafts/handlers/<app>/<draft_id>/`, with its fixture folder inside (section 9 §6.2).
- **Provenance link:** the artifact's `became: handler_draft:<id>`, for recorder drafts (section 2 §17.3).

### 12.3 Drafting the detector

- **Source screen:** the masked accessibility snapshot when trouble began. Taken at escalation, or at rung 2 (update file, section 3).
- **Candidate text:** headings, dialog titles, alert text, and button names.
- **Keep only plain UI text.** Drop anything with a reference, token, or mask.
- **Keep only text the normal screen lacks.** Compare with normal-screen fixtures for the same location.
- **Draft:** `all_of` the best text as `text_visible contains`, plus the acted button as `element_visible`.
- **A human edits it.** The draft is a start, not a decision.

**Is UI text enough?** Mostly, yes.

- **Pop-ups and error pages are made of UI text.** Member data does not identify them anyway.
- **Image-only buttons** (CONTRACT `KVFCU_STRIP_SEMANTICS`): the target uses role, region, and an image crop instead.
- **A screen made only of member data** cannot get a detector. It stays with rungs 2 to 4. A known limit.

### 12.4 Drafting the response and class

| What happened | Draft class | Why |
|---|---|---|
| Only clicks, selects, checks, Tab, Escape; none irreversible by the rules | `recoverable` | Replayable as recorded |
| The human typed anything logged as `[human_text]` or `[secret]` | `needs_human` | Section 4 §8.10: that text must never be automated |
| The human typed a known input, like `{input.member_id}` | `needs_human` | Packs cannot use inputs |
| Any action the gate classed `irreversible` | `needs_human` | Handlers never act irreversibly |
| The human ended the run | `hard_failure`, code chosen at review, or discarded | The human judged it hopeless |
| Reviewer fix | `recoverable` | It was one gated, `idempotent` action |

- **Response targets come from the fingerprints** of the acted controls. Section 7 captures human fingerprints.
- **Risk flags start as the rules' class.** Unsure starts as `irreversible`, so the draft cannot load until a human confirms a lower flag.
- **`operator_note` drafts** use the takeover reason and the detector text. A human rewrites it.

### 12.5 Review

The CLI (section 9) shows the reviewer:

- **The trouble screenshot,** masked.
- **What the human or reviewer did,** action by action, masked.
- **The drafted detector,** and a dry run: every fixture and normal screen it would match.
- **Each action's drafted risk,** beside the rules' class and reason.
- **The class rule that applied** (12.4).

The reviewer then:

1. **Edits** the detector, response, and notes.
2. **Confirms each action's risk.** Recorded as a `risk` decision.
3. **Adds at least one `no_fire` fixture:** the nearest normal screen.
4. **Picks the scope** (12.6) and the ID.
5. **Adds it to a candidate revision** of that scope's pack. Sealing and approval follow as usual.

### 12.6 Widening scope needs evidence

| Scope | Needs `fire` fixtures from |
|---|---|
| Tenant | That tenant |
| App version | Two tenants on that version range |
| App | Two tenants, or two variants of the app |
| Global | Two apps |

- **The CLI suggests tenant scope first.** It is the smallest blast radius.
- **Why:** a wrong vendor-wide handler misfires at every bank on that app.
- **The bank app can supply the second sample.** `KVFCU_VARIANT=lakeshore` is a second credit union on the same software (CONTRACT §4).
- **Named faults create fixtures on demand.** Example: add a `known_popup` fault, run once, capture the screen (CONTRACT §6.2).

---

## 13. Fixtures

### 13.1 Format

One folder per fixture, at `library/fixtures/<app>/<fixture_id>/` (section 9 §6.2). Fixture IDs stay shared across packs.

| File | Content | Required |
|---|---|---|
| `meta.json` | `schema` `"intyy.fixture/1.0"`, ID, app, tenant, app version, variant, location, viewport, element boxes, source run and `seq`, `kind` | Yes |
| `a11y.yaml` | Masked accessibility snapshot | Yes |
| `dom.html` | Masked DOM snapshot | No. Needed for `path` clues |
| `screen.png` | Masked screenshot | Only when a used target has an `image` clue |

- **`kind`:** `trouble` (an interruption) or `normal` (an expected screen).
- **Fixture IDs are shared.** One fixture can be `fire` for one handler and `no_fire` for others.
- **Element boxes** let offline checks use `region` clues. The accessibility snapshot alone has no positions.

### 13.2 Offline checking

- **A snapshot surface answers checks from the saved files.** It is the surface port's fake twin (section 1 §4).
- **Same condition checker and clue voter as live replay.** A fixture tests the real code path.

| Check | Offline? |
|---|---|
| `element_visible`, `text_visible`, `count`, `location` | Yes |
| `element_state` | Yes, from accessibility states |
| `field_value` | No. Snapshots drop all field values (section 3 §7.6). So detectors may not use it |

### 13.3 Minimum sets per handler

- **At least one `fire` fixture** from real evidence. Test runs count.
- **At least one `no_fire` fixture:** a near miss. Example: the page under the pop-up.
- **Plus the negative library,** automatically (13.4).
- **Why so few by hand:** the library supplies the bulk of must-not-fire cases. Hand work goes into the near misses.

### 13.4 The negative library

- **Every discovery observation becomes a `normal` fixture** for its app. Section 6 writes this rule.
- **Every handler's `fire` fixtures join the library** for every other handler.

**CI rules:**

1. **No detector matches a `normal` fixture.**
2. **No detector matches another handler's `fire` fixture,** unless 7.6 picks a clear winner: scope or priority.
3. **On each of its `fire` fixtures,** a handler's detector matches and every response target has a clear winner.

- **Rule 2 finds ties before production.** A tie in production costs a jev call.

### 13.5 CI

- **Every fixture runs against every pack,** sealed and candidate.
- **Every merged set runs too,** for each known context: each tenant and app version in the repo's settings files.
- **Why merged sets:** a tenant override can break a detector that passed alone.
- **Confirmed:** CI runs every fixture against every pack.

### 13.6 Safety

- **Fixtures are copies of redacted evidence.** Only masked text and masked images.
- **They live as long as the pack revisions that use them.** Not in the 30-day debug tier.
- **The canary scan reads the pack store** (update file, section 4).

---

## 14. The bank app's faults, rung by rung

`CONTRACT.md` §6 lists what the bank app can inject. This table says how each ends.

| Fault | On an `idempotent` step (window open) | Right after Confirm (window closed) |
|---|---|---|
| `error_page` | `app_error_page`: back to the last good page, resume. Used up: failed `app_error` | Reconcile |
| `blank` | `blank_page` (global): same | Reconcile |
| `hang` | Checkpoint times out. Retry. Section 7 treats the dropped connection | Reconcile |
| `unavailable` | `service_unavailable`: pause, back to the last good page | Reconcile |
| `logout` | `back_at_login`: `sign_in`, then resume | Reconcile |
| `maintenance` | `maintenance`: failed `app_error`, `transient: true` | Reconcile |
| `known_popup` | `kyc_reminder`: Remind Later. The request re-sends. The checkpoint passes. Continue | Reconcile. Clicking would re-send Confirm |
| `unknown_popup` | jev, then the reviewer. A safe word like Close: recovered. Else a human | Reconcile |
| `session_expire` | `session_expired`: `sign_in`, then resume | Reconcile |
| `supervisor_required` | — | `supervisor_approval`: takeover. Handback, then the checkpoint passes: `confirmed` |
| `drop_after_confirm` | — | Reconcile. The check finds the account: `success`, `found_by_check` |

**Business outcomes, not faults:**

| Case | Ends as |
|---|---|
| A member number that does not exist | Artifact outcome, like `member_not_found` |
| A member at the sub-account limit | Artifact outcome on the step that shows it. On Confirm: `refused` |
| The restricted user tries to open an account | `permission_denied` handler: failed `permission_denied`, `transient: false` |

- **Block points (`before`, `after`) matter only in the closed window.** On `idempotent` steps, doing it again is safe either way.
- **Right after Confirm, intyy never guesses the block point.** It asks the reconciliation check.
- **Certify can run this table** as its fault profile (section 8). The fault log is the truth to score against.

---

## 15. Example pack files

> **Illustrative.** Text marked "CONTRACT" comes from `CONTRACT.md` §6.1. Other text is invented. Real text comes from discovery. Fixtures and provenance are shortened.

### 15.1 Global

```json
{
  "schema": "intyy.pack/1.0",
  "scope": { "level": "global" },
  "revision": 2,
  "reason": "Blank page handler for every app.",
  "targets": [],
  "conditions": [
    { "id": "page_blank", "check": "not", "description": "The page shows no text at all",
      "of": { "check": "text_visible", "text": "*", "match": "wildcard" } }
  ],
  "handlers": [
    { "id": "blank_page", "description": "The app returned an empty page.",
      "class": "recoverable", "detector": "page_blank",
      "response": [ { "type": "navigate", "location": "{system.last_good_path}", "risk": "idempotent" } ],
      "limits": { "per_step": 2, "per_run": 3 },
      "on_exhausted": { "class": "hard_failure", "failure": "app_error" },
      "fixtures": { "fire": ["blank_page_01"], "no_fire": ["login_page_normal_01"] } }
  ],
  "provenance": { "runs": [], "decisions": [
    { "what": "risk", "subject": "blank_page.response[0]", "value": "idempotent", "by": "op_017", "at": "2026-09-24T15:00:00Z" } ],
    "sealed": { "by": "op_017", "at": "2026-09-24T15:05:00Z" } },
  "approved": { "by": "op_017", "at": "2026-09-24T15:06:00Z" }
}
```

### 15.2 App (handlers only)

```json
"conditions": [
  { "id": "on_login_page", "check": "location", "description": "The login page is showing", "pattern": "/login" },
  { "id": "error_500_shown", "check": "text_visible", "description": "The app's error page (CONTRACT)",
    "text": "500 Internal Server Error", "match": "contains" },
  { "id": "unavailable_shown", "check": "text_visible", "description": "Service unavailable page (CONTRACT)",
    "text": "Service temporarily unavailable", "match": "contains" },
  { "id": "maintenance_shown", "check": "text_visible", "description": "Maintenance page (CONTRACT)",
    "text": "System under scheduled maintenance", "match": "contains" },
  { "id": "session_expired_shown", "check": "text_visible", "description": "Session expired page (invented)",
    "text": "Your session has expired", "match": "contains" },
  { "id": "supervisor_needed_shown", "check": "text_visible", "description": "Supervisor approval page (invented)",
    "text": "Supervisor approval required", "match": "contains" },
  { "id": "not_authorized_shown", "check": "text_visible", "description": "Permission denied page (invented)",
    "text": "You are not authorized", "match": "contains" }
],
"handlers": [
  { "id": "session_expired", "description": "The app says the session has expired.",
    "class": "recoverable", "detector": "session_expired_shown", "priority": 1,
    "response": [ { "type": "sign_in", "risk": "idempotent" } ],
    "limits": { "per_step": 1, "per_run": 2 },
    "on_exhausted": { "class": "hard_failure", "failure": "app_error" },
    "fixtures": { "fire": ["session_expired_01"], "no_fire": ["login_page_normal_01"] } },

  { "id": "back_at_login", "description": "The app sent the operator back to the login page.",
    "class": "recoverable", "detector": "on_login_page",
    "response": [ { "type": "sign_in", "risk": "idempotent" } ],
    "limits": { "per_step": 1, "per_run": 2 },
    "on_exhausted": { "class": "hard_failure", "failure": "app_error" },
    "fixtures": { "fire": ["logout_redirect_01"], "no_fire": ["home_page_normal_01"] } },

  { "id": "app_error_page", "description": "The app shows its generic server error page.",
    "class": "recoverable", "detector": "error_500_shown",
    "response": [ { "type": "navigate", "location": "{system.last_good_path}", "risk": "idempotent" } ],
    "limits": { "per_step": 2, "per_run": 3 },
    "on_exhausted": { "class": "hard_failure", "failure": "app_error" },
    "fixtures": { "fire": ["error_page_01"], "no_fire": ["member_page_normal_01"] } },

  { "id": "service_unavailable", "description": "The app says the service is temporarily unavailable.",
    "class": "recoverable", "detector": "unavailable_shown", "delay_ms": 3000,
    "response": [ { "type": "navigate", "location": "{system.last_good_path}", "risk": "idempotent" } ],
    "limits": { "per_step": 2, "per_run": 3 },
    "on_exhausted": { "class": "hard_failure", "failure": "app_error" },
    "fixtures": { "fire": ["unavailable_01"], "no_fire": ["member_page_normal_01"] } },

  { "id": "maintenance", "description": "The app is under scheduled maintenance.",
    "class": "hard_failure", "detector": "maintenance_shown", "failure": "app_error",
    "fixtures": { "fire": ["maintenance_01"], "no_fire": ["home_page_normal_01"] } },

  { "id": "supervisor_approval", "description": "The app needs a supervisor to approve this application.",
    "class": "needs_human", "detector": "supervisor_needed_shown",
    "operator_note": "A supervisor must approve in this window. Then hand back.",
    "fixtures": { "fire": ["supervisor_needed_01"], "no_fire": ["account_form_normal_01"] } },

  { "id": "permission_denied", "description": "The app says the operator lacks the right for this action.",
    "class": "hard_failure", "detector": "not_authorized_shown", "failure": "permission_denied",
    "fixtures": { "fire": ["restricted_user_denied_01"], "no_fire": ["member_page_normal_01"] } }
]
```

- **Why `maintenance` fails at once:** real maintenance lasts minutes to hours. The caller should retry later. `transient: true` says so.
- **Why `session_expired` has priority 1:** its page may sit at `/login`. Then both it and `back_at_login` match.
- **`done_when` is not needed on either handler.** The prelude's last checkpoint proves the sign-in worked.

### 15.3 Tenant

```json
{
  "schema": "intyy.pack/1.0",
  "scope": { "level": "tenant", "tenant": "lakeshore", "app": "kvfcu" },
  "revision": 1,
  "reason": "Lakeshore brands its maintenance page differently. Invented example.",
  "targets": [],
  "conditions": [
    { "id": "maintenance_shown", "overrides": true, "check": "text_visible",
      "description": "Lakeshore's maintenance page",
      "text": "Lakeshore Online is under maintenance", "match": "contains" }
  ],
  "handlers": [],
  "disable": [],
  "provenance": { "runs": [ { "run_id": "run_2026-10-02_c9d1wq5e2k", "kind": "replay" } ],
    "decisions": [ { "what": "scope", "subject": "maintenance_shown", "value": "tenant", "by": "op_022", "at": "2026-10-02T09:15:00Z" } ],
    "sealed": { "by": "op_022", "at": "2026-10-02T09:20:00Z" } },
  "approved": { "by": "op_022", "at": "2026-10-02T09:21:00Z" }
}
```

- **One replaced condition.** The inherited `maintenance` handler now matches Lakeshore's page.

---

## 16. Tests that prove it

| Test | Proves | In CI? |
|---|---|---|
| Pack loader | Every check in 5.6 accepts and rejects the right files | Yes |
| Merge and override | Most specific wins; `overrides` required; `disable` works | Yes |
| Frozen set | Filters in 7.4; same packs give the same hash | Yes |
| Fixture suite | 13.4 rules on every pack and every merged set | Yes |
| Tie rule | Scope, then priority, then rung 2 | Yes |
| Helper window matrix | Each helper × window state × step class gives the right decision | Yes |
| Resume rule | Late checkpoint, shared preconditions, rewind floor, non-`idempotent` chain | Yes |
| Pre-commit sweep | A leftover pop-up is cleared before Confirm | Yes |
| Rung order | Outcomes, then handlers, then retry, then climb | Yes |
| Known screen, no progress | Fails with the underlying code, not a climb | Yes |
| jev paths | Each bucket, each threshold edge, timeout, bad output. Fake scripts | Yes |
| Reviewer paths | Allowed action, blocked action, give up, no landing. Fake scripts | Yes |
| Undeclared outcome | Pack outcome not declared: `undeclared_outcome` | Yes |
| Fault table | Every row of section 14 on the local bank app, with named faults and a fixed seed | Yes |
| Draft golden test | A saved takeover log always gives the same draft handler | Yes |
| Canary scan | No canary value in the pack store, drafts, or fixtures | Yes |
| jev accuracy | Real jev against labelled screens and the fault log | No, on demand |

- **In the build, the CI fault table doubles as the engine's regression batch** (section 8 §15.5).

---

## 17. How this meets the brief

| Brief asks | Where |
|---|---|
| 3.3 Detect runtime errors and respond deliberately | 8.1 to 8.4, section 14 |
| 3.3 Business outcomes apart from recoverable conditions and hard failures | 6.2, 8.10, section 9 |
| 3.3 Dismiss a known interstitial; wait and retry a transient load | 6.9, 8.5, 8.6 |
| 3.3 Hard failures with what step, expected, observed | 8.4 step 5, section 3 §5.5 |
| 3.4 Risky actions handled conservatively | 2.2, 8.2, 8.3 |
| 3.6 Detect stuck and route to a human with context | 8.9, 11.3 |
| 3.6 Record what the human did | 12.1 to 12.4 |
| 3.7 Reuse across tenants on the same vendor app | 7.1, 7.2, 12.6, 15.3 |
| 8 Assisted fallback: bounded, policy-checked, one step, recorded | Section 11 |
| 8 Canonicalization and cross-tenant overrides | 7.2, 15.3 |

---

## 18. Rejected options

| Option | Why rejected |
|---|---|
| Option B: packs add outcomes to any capability | Skips the per-capability refusal check. Returns codes no schema promised (section 9) |
| Handlers act while Confirm is in flight | Pop-up buttons re-send the request. A dismissal could commit |
| jev or the reviewer may claim `refused` | A wrong "nothing changed" invites a double commit |
| Handlers list artifact step IDs | Packs cannot know them. Location checks do the job |
| Handlers use artifact targets | Same reason. Packs hold their own |
| Sweep before every step | Delay and false matches, for little gain. Only the commit step gets it |
| Retry before handlers | A blind retry may meet the same pop-up |
| Resume at "the last good checkpoint" | Fails after a re-login. The resume rule replaces it |
| Latest passing precondition, no extension | Skips the user ID box on a shared login screen |
| Re-login handler with its own login copy | Two recipes to patch. Secrets in two places |
| Per-context approval for packs | Multiplies review by tenants, versions, and capabilities |
| Handler set in the artifact approval key | Every pack change would demote every artifact |
| Field-level merge of handlers | A reviewer would read four files to see one handler |
| `field_value` in detectors | Fixtures hold no values. The detector could not be tested |
| Screenshots for jev in the build | Slower and costlier. The element list carries the structure |
| jev chooses free actions | Turns a sorter into a planner. jev names; handlers act |
| Reviewer takes several actions | Unbounded. One action, then prove it landed |
| Learned handlers go live without review | A misread screen would misfire at every bank in scope |
| Vendor scope by default for new handlers | Largest blast radius first. Tenant first, widen with evidence |
| `unsafe` needs high confidence | When unsure, assume the worst |

---

## 19. Items parked for other sections

> **Changed by section 10:** Items for section 10 are resolved. See `intyy-design-updates-from-section-10.md` §8.

| Item | Section |
|---|---|
| Recorder rules for drafting handlers from `incidental` actions | 6. Resolved: section 6 §14.12 |
| Discovery observations saved as `normal` fixtures | 6. Resolved: section 6 §14.12 |
| Offering pack outcomes for adoption at candidate review | 6 (data). Resolved: section 9 §8.2 (CLI) |
| Whether handlers run during discovery | 6. Resolved: section 6 §2.5 (no) |
| Retry limits, engine caps on handler attempts, reviewer per-run cap | 7. Resolved: section 7 §8 |
| jev and reviewer time limits; element list caps | 7. Resolved: section 7 §8 |
| Hangs and dropped connections as surface events | 7. Resolved: section 7 §7.3 |
| A click blocked before dispatch on the commit step: `not_sent` or `uncertain` | 7. Resolved: section 7 §7.2 |
| Where the bot resumes after a takeover: search forward too | 7. Resolved: section 7 §16 |
| Capturing human action fingerprints for learned handlers | 7. Resolved: section 7 §14 |
| Native `alert` and `confirm` boxes as pack targets | 7. Resolved: section 7 §9.1 |
| Which session runs the reconciliation check | 7. Resolved: section 7 §11.1 |
| Outputs after `confirmed` when the read step fails | 7. Resolved: section 7 §11.2 |
| Threshold numbers; jev calibration against the fault log | Resolved: section 8 §8.5, §14.1 |
| Reconciliation autonomy records | Resolved: section 8 §14.2 |
| Regression certify before a pack revision activates | Resolved: section 8 §15.1 |
| Live scores keyed by handler set hash | Resolved: section 8 §5.5, §15.3 |
| Pack edit, seal, approve, and draft review commands; detector dry run | Resolved: section 9 §8.5 |
| Pack, draft, and fixture file locations | Resolved: section 9 §6.2 |
| Renaming placeholders: `sparrow-core` to `kvfcu`, `bank_a` to `keystone` | 10 |

---

## 20. Terms used in this section

| Term | Meaning |
|---|---|
| Handler pack | A file of known interruptions for one scope |
| Scope | Global, app, app version, or tenant |
| Handler | "If you see X, do Y," picked by plain code |
| Detector | The condition that proves a handler's state |
| Class | What a handler means: outcome, recoverable, hard failure, needs human |
| Response | A handler's fixed actions |
| `done_when` | The condition that proves the response worked |
| Frozen set | The handlers fixed for one run |
| Override | A more specific scope's object with the same ID |
| Trouble | A step could not prove it worked |
| Helper | A handler, a retry, or the reviewer |
| In flight | Performed, but its checkpoint has not passed yet |
| Helper window | Whether helpers may act now |
| Pre-commit sweep | One detector check just before the irreversible click |
| Resume rule | The plain-code rule for where replay continues after a fix |
| Rewind floor | The earliest step replay may go back to |
| Climb | Pass the trouble to the next rung |
| Bucket | jev's answer type: outcome, handler, needs review, unsafe |
| Threshold | The confidence jev needs for a bucket to count |
| Second opinion | The reviewer LLM checking a jev reconciliation verdict |
| Adoption | Copying a pack outcome into an artifact at review |
| Draft handler | A proposed handler, never loaded by replay |
| Fixture | A saved, masked screen for testing detectors |
| Near miss | A normal screen that looks like the trouble screen |
| Negative library | All normal screens and other handlers' trouble screens |
| Snapshot surface | The surface port's fake twin, reading saved fixtures |
