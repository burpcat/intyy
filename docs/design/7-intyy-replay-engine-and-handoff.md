# intyy — Section 7: replay engine and handoff

> **Status:** complete, 24 Sep 2026.
> **Formats defined:** `intyy.intervention/1.0`, the lease record, engine limits for engine version `0.x`.
> **Amended by sections 8 and 9,** 25 Sep 2026: the resolver pointer and frozen approval, timeout sources, masked clue values, certify reconciliation and crash handling, the scripted operator twin, the mailbox layout and locks, implicit claims, and resolved parked items. Formats are not yet released, so they are amended in place.
> **Depends on:** sections 1 to 6, `CONTRACT.md` 1.1.0.
> **Used by:** sections 8 to 10.
> **Changes to sections 1 to 6:** `intyy-design-updates-from-section-7.md`.
> **Numbers here are engine constants.** They change only with the engine version, which every run logs.

---

## Contents

1. [Purpose](#1-purpose)
2. [Design principles](#2-design-principles)
3. [New words](#3-new-words)
4. [A replay run, start to end](#4-a-replay-run-start-to-end)
5. [Settling and waiting](#5-settling-and-waiting)
6. [Clue voting](#6-clue-voting)
7. [Acting](#7-acting)
8. [Limits](#8-limits)
9. [Native dialogs and pop-up windows](#9-native-dialogs-and-pop-up-windows)
10. [The prelude in replay](#10-the-prelude-in-replay)
11. [Reconciliation runs](#11-reconciliation-runs)
12. [Control lease](#12-control-lease)
13. [Intervention request](#13-intervention-request)
14. [Human action capture](#14-human-action-capture)
15. [Watchers during a takeover](#15-watchers-during-a-takeover)
16. [Handback and reverify](#16-handback-and-reverify)
17. [Crash and restart](#17-crash-and-restart)
18. [Determinism](#18-determinism)
19. [Remote console (design only)](#19-remote-console-design-only)
20. [Worked example: supervisor approval](#20-worked-example-supervisor-approval)
21. [Tests that prove it](#21-tests-that-prove-it)
22. [How this meets the brief](#22-how-this-meets-the-brief)
23. [Rejected options](#23-rejected-options)
24. [Items parked for other sections](#24-items-parked-for-other-sections)
25. [Terms used in this section](#25-terms-used-in-this-section)

---

## 1. Purpose

- **Replay is the production path.** An AI agent calls a capability; replay runs it with no model deciding.
- **This section decides how replay waits, finds controls, acts, and hands control to a human and back.**
- **Sections 2 to 6 set the formats and the ladder.** This section is the engine that runs them.

---

## 2. Design principles

### 2.1 Wait for state, never for time

- **No fixed sleeps.** Every wait ends when a condition turns true, or at a timeout.
- **Why:** the bank app takes 200 ms to 8 s per request (CONTRACT §6). A fixed sleep is either slow or wrong.

### 2.2 Unknown never passes

- **Every check answers true, false, or unknown.** Unknown comes from an ambiguous control.
- **Only true passes.** `not unknown` is still unknown.
- **Why:** a doubtful "the pop-up is gone" must not let replay click on.

### 2.3 Missing is not the same as different

- **A control with no name today** is weaker evidence than one with a different name.
- **Missing clues leave the vote. Different clues vote against.**
- **Why:** old apps render buttons as bare images (`KVFCU_STRIP_SEMANTICS`). The picture still identifies them.

### 2.4 One driver at a time

- **The lease says who drives:** the bot, a human, or nobody.
- **The bot acts only while it holds the lease.** The gate checks it first (section 4 §3.3).

### 2.5 A human's work is checked like the bot's

- **After a handback, the bot proves where the screen is** before it acts again.
- **What the human finished counts only if its checkpoints pass.**

### 2.6 Never end on "uncertain" while a check can still run

- **A sent commit with an unknown result always gets a reconciliation check,** even after a human timeout.

---

## 3. New words

| Word | Meaning | Example |
|---|---|---|
| **Settle** | Wait until the page stops loading after an action | No request in flight for 500 ms |
| **Candidate** | An on-screen element that might be the target | Three buttons pass the role filter |
| **Score** | How well a candidate's clues match the target, 0 to 1 | 0.94 |
| **Margin** | The winner's score minus the runner-up's | 0.61 |
| **Evidence** | The total weight of clues that agree | 0.25 |
| **Dispatched** | Whether the browser really sent an input event | `false` if the button was covered |
| **Transport failure** | The connection failed, not the app | The server hung, then closed the connection |
| **Lease token** | A random value given with each lease grant. Actions must carry it | Stops a stale bot action after a takeover |
| **Watcher** | A read-only check that runs while a human drives | "Has the confirmation appeared?" |
| **Reverify** | The checks the bot runs after a handback | Find the resume step |
| **Mailbox** | Files the engine and the operator CLI use to talk | `request.json`, `decision.json` |

---

## 4. A replay run, start to end

1. **Pre-run checks** (section 3 §4.8). Resolver picks versions (section 8 §11). The resolver also freezes `approval` (section 3 §6.5).
2. **Freeze facts.** Handler set (section 5 §7.4), session, timeouts, policy, settings. Log `run_start`.
3. **Secret check.** No browser before this passes.
4. **Open the browser.** Fresh session, fixed viewport, network guard, dialog listener. Lease: `bot`.
5. **Prelude** (section 10), if the artifact links a session capability.
6. **Supervised mode:** start confirmation. The bot waits with the lease.
7. **Each step:**
   1. Log `step_start`.
   2. Wait for the precondition (5.2).
   3. Commit step only: authorization check, then the pre-commit sweep (section 5 §8.3).
   4. Vote for the target (section 6).
   5. Gate.
   6. Commit step only: write `commit_intent` and force it to disk.
   7. Act (section 7). Settle.
   8. Race the checkpoint against the declared outcomes (5.3).
   9. Log `step_end`. Trouble goes to the ladder (section 5 §8).
8. **End.** Build the result. Write `run.json`, the index line, and `run_end`. Close the browser.

---

## 5. Settling and waiting

### 5.1 Settle after an action

1. **Did a navigation start** within 500 ms of the action? Then wait for its page to load, up to the step timeout.
2. **Then wait for quiet:** no page or data request in flight for 500 ms. At most 3 s.
3. **Then start checking conditions.**

- **Why quiet has a cap:** some old apps poll forever. Quiet would never come.
- **Static files do not count.** Images and styles do not change what the checks see.

### 5.2 Condition waits

- **Check at once, then on every page change, and at least every 200 ms.**
- **Page change:** a navigation or a change to the page's structure.
- **Stop when the condition is true, or the timeout passes.**

| Wait | Timeout |
|---|---|
| Precondition | 5 s. The previous step already waited for its screen |
| Checkpoint | The step timeout: tuned value, else the artifact default |
| Handler `done_when` | The handler's `wait_ms`, else 10 s |
| Reviewer landing (section 5 §11.3) | The step timeout |

### 5.3 The outcome race

- **During the checkpoint wait, the step's declared outcomes are checked too.**
- **The first true condition wins.** "Not found" does not wait out the timeout.
- **Both true at once:** the outcome wins, with warning `checkpoint_outcome_overlap`.
- **Why the outcome wins:** a weak checkpoint may also pass on a "not found" screen. Returning success would be the worse mistake.

### 5.4 Where timeouts come from

| Source | When used | Logged as |
|---|---|---|
| Tuned | The key's `approved` value. Live replay (section 8 §9.6) | `timeout_source: tuned` |
| Candidate | The key's `candidate` value. Certify runs of that key | `timeout_source: candidate` |
| Default | Else, the artifact's `timeout_ms` | `timeout_source: default` |

- **`run_start.frozen.timeouts_from`** names the batch behind the values.

---

## 6. Clue voting

**Job:** find the one element a target means, or say clearly that there is none, or more than one.

### 6.1 Candidates

- **Every element in the active page and its frames** is a candidate at first.
- **The role filter comes first.** A candidate must be in the target's role group.

| Role group | Roles |
|---|---|
| Button-like | button, menu item, image button, script link, clickable element with no clear role |
| Text entry | textbox, search box, password box |
| Choice | combobox, list box |
| Check | checkbox, radio, switch |
| Navigation | link to a plain path, tab, tree item |
| Container | row, cell, table, list, list item, form, dialog, alert dialog |

- **Groups, not exact roles.** A stripped button may lose its `button` role but stays button-like.
- **Section 4 §7.4 uses the same button-like group** for risk. One list, two uses.

### 6.2 `within`

- **Vote for the parent target first.** It must have a clear winner.
- **Then only its descendants are candidates.**
- **Parent not found or ambiguous:** the child is too.

### 6.3 Clue weights

| Clue | Weight | Match degree |
|---|---|---|
| `name` | 0.30 | 1 if equal after normalizing, else 0 |
| `label` | 0.25 | 1 if equal after normalizing, else 0 |
| `text` | 0.20 | 1 if the candidate's text contains the clue, else 0 |
| `region` | 0.10 | 1 if the centers are within 3% of the viewport; falls to 0 at 20% |
| `image` | 0.10 | 1 at picture likeness 0.90 or more; falls to 0 at 0.60 |
| `path` | 0.05 | 1 if equal; 0.5 if the last three parts match; else 0 |

- **References in clues** use the raw value, in memory only. It is never logged.
- **Picture likeness:** a plain-code comparison of the crop with the candidate's pixels at the same scale. No model.

### 6.4 Agree, differ, or missing

| The candidate… | Effect |
|---|---|
| Has the clue, and it matches | Adds weight × degree to the score |
| Has the clue, and it differs | Adds weight to the total, nothing to the score |
| Lacks the clue entirely | Leaves the vote. Neither side counts it |

- **Score = agreeing weight ÷ total weight of clues both sides have.**
- **Only clues the target recorded take part.** A target with only `role` and `text` votes on `text` alone.

### 6.5 Minimum evidence

Missing clues shrink the total. So a nearly blank candidate could score high on little. Two rules stop that.

1. **Agreeing weight must be at least 0.20.**
2. **At least one of `name`, `label`, `text`, or `image` must agree.**

### 6.6 The winner rule

| Result | Rule | Failure code |
|---|---|---|
| Winner | Best score ≥ 0.70, and margin ≥ 0.15 | — |
| Winner, alone | Only one candidate reaches 0.70 | — |
| No winner | Best score < 0.70, or evidence rules fail | `target_not_found` |
| Tie | Best score ≥ 0.70, margin < 0.15 | `target_ambiguous` |

### 6.7 Checks that use targets

| Check | Target has a winner | No winner | Tie |
|---|---|---|---|
| `element_visible` | True if visible | False | Unknown |
| `element_state` | True or false by state | False | Unknown |
| `field_value` | True or false by value | False | Unknown |

**Combining unknowns:**

| Combiner | Result |
|---|---|
| `all_of` | False if any false; else unknown if any unknown; else true |
| `any_of` | True if any true; else unknown if any unknown; else false |
| `not` | Swaps true and false. Unknown stays unknown |

- **The trace shows unknown leaves** with the reason: "target ambiguous".

### 6.8 What is logged

- **`target_vote`:** candidate count, winner, score, margin, agreeing clues, differing clues, missing clues.
- **Differing clues are logged even with a clear winner.** Section 8 drafts tenant patches from them.
- **Each differing clue also carries its observed value, masked** (section 3 §6.4). A patch draft needs the new value, not only the fact of a change.
- **Names only for button-like candidates,** through the text rules (section 4 §9.10).

### 6.9 Worked examples

**A stripped Search button.** Recorded: name "Search", text "Search", region, image, path. Today the button is a bare image.

| Clue | Recorded | Today | Effect |
|---|---|---|---|
| `name` | Search | none | Missing. Leaves the vote |
| `text` | Search | none | Missing. Leaves the vote |
| `region` | x 0.72, y 0.31 | same | Agrees: 0.10 |
| `image` | crop | likeness 0.95 | Agrees: 0.10 |
| `path` | `…td[3] > input` | same | Agrees: 0.05 |

- **Score:** 0.25 ÷ 0.25 = 1.00. Evidence 0.25. The image agrees. Winner.
- **Other bare images** have a different picture. Their `image` clue differs, so they score low.

**A renamed button.** Bank B shows "Find". Name and text differ. The picture differs too.

- **Score:** region 0.10 + path 0.05, over a total of 0.90. About 0.17. No winner: `target_not_found`.
- **Correct:** a different label is drift. The ladder climbs; a patch fixes it for good.

---

## 7. Acting

### 7.1 Per action type

| Action | How |
|---|---|
| `click` | Scroll into view. Click the winner. The browser first checks it is visible, still, enabled, and not covered |
| `type` | Clear the field. Type key by key, in the step's `format` |
| `select` | Pick the option whose visible text matches |
| `set_checked` | Set checked or unchecked. No change if already right |
| `press` | Press the key on the focused element |
| `navigate` | Bank origin from settings, plus the path. Wait for the page |
| `read` | Read text or value. Never from a secret-filled field |

- **Why key by key:** old apps react to key events. A pasted value may not register.
- **The browser's readiness wait** is capped at 5 s, or 2 s on the commit step. The precondition already waited.

### 7.2 Did the commit really go out?

- **The surface reports `dispatched`:** `true`, `false`, or `unknown`.
- **`false` only when readiness checks failed before any input event.** Example: a pop-up covered Confirm.

| `dispatched` | Commit state | Next |
|---|---|---|
| `false` | Stays `not_sent`. The `action` line says `dispatched: false` | Trouble at phase `action`. The window is open |
| `true` | In flight | Checkpoint race |
| `unknown` | In flight | Checkpoint race. Closed window if it fails |

- **Why this matters:** a blocked click is not a sent commit. Calling it `uncertain` would force a needless check.
- **The `commit_intent` line stays.** It proves intyy tried. The `action` line proves nothing went out.

### 7.3 Transport failures

| Surface event | Meaning |
|---|---|
| `connection_closed` | The server closed the connection. Example: the bank app's `hang` |
| `browser_error_page` | The browser shows its own error page |
| `navigation_timeout` | A page load outlived the step timeout |

- **Window open:** rung 1 retries with `retry.transport`. Go to `{system.last_good_path}`, then the resume rule.
- **Window closed:** the closed-window rules (section 5 §8.2). Usually reconcile.
- **`retry.transport` shares the retry budget** with `retry.idempotent`.
- **Why the engine, not a handler:** a browser error page has no app text to detect. The surface knows it failed.

---

## 8. Limits

| Limit | Value | Reached means |
|---|---|---|
| Retries per step | 2 (3 attempts) | Known screen: hard failure. Else climb |
| Handler attempts, engine cap | 3 per step, 6 per run | `on_exhausted` |
| Ladder entries per run | 8 | Takeover, `stuck` |
| Rewinds per run | 4 | Not recovered. Climb |
| `sign_in` runs per run | 2 | Handler `on_exhausted` |
| jev time limit | 2 s | `needs_review`, confidence 0 |
| Reviewer calls | 1 per step, 2 per run | Takeover, `stuck` |
| Reviewer time limit | 60 s | Takeover, `stuck` |
| Run time, human time excluded | 10 min | Failed, `run_timeout` |
| jev and reviewer element list | 150 elements, 80 characters per name | Rows past the tenth fold into a count |

- **The lower of a handler's own limit and the engine cap wins.**
- **Escalation deadlines** are in 13.3.

---

## 9. Native dialogs and pop-up windows

### 9.1 Native dialogs

- **The browser's `alert` and `confirm` boxes** block the page. Nothing else can be clicked.
- **intyy never answers them automatically** (section 4 §6.10).
- **Perception shows an open box as elements:**

| Element | Role | Name | `path` clue |
|---|---|---|---|
| The box | `alertdialog` | The message, masked | `native:dialog` |
| Accept | `button` | "OK" | `native:dialog > accept` |
| Dismiss | `button` | "Cancel" | `native:dialog > dismiss` |

- **Clicking Accept or Dismiss answers the box.** The risk rules read the message words (section 4 §7.5, C3).
- **While a box is open, only its elements are candidates.** Other checks see nothing else.
- **Handlers may target these elements,** like any pack target.
- **`prompt` boxes** always go to a human (section 4 §6.10).

### 9.2 Pop-up windows

- **The app may open a new window,** like an old lookup pop-up.
- **The active page:** the newest open window. When it closes, the opener becomes active again.
- **Only the active page's elements are candidates.**
- **The `path` clue starts with `window[popup]`** for controls in a pop-up. Main-window paths have no prefix.
- **The network guard covers every window** (section 4 §6.8).

---

## 10. The prelude in replay

1. **Navigate to the session artifact's `entry`.**
2. **Run its steps** with the same engine, gate, and ladder. Log them as `session:<step_id>`.
3. **Handlers with `sign_in` are skipped** during the prelude. They would loop.
4. **Prelude done:** does the task's first precondition pass? Start there.
5. **Else navigate to the task's `entry`** and check again. Still no: trouble at step 1.

**`sign_in` during the task:**

- **The engine repeats steps 1 to 4 in the same browser.** Each prelude step passes the gate as actor `engine`.
- **A failure inside it fails that handler attempt.** The handler's limits and `on_exhausted` apply.
- **Then the resume rule** runs over the task steps (section 5 §8.6).

---

## 11. Reconciliation runs

### 11.1 A fresh session

- **The check runs as a child run,** kind `reconciliation`, with `parent_run_id`.
- **In a new browser session,** with its own prelude.
- **Why not the parent's session:** after a failed commit, that session may hang or show an error page.
- **The parent first saves evidence:** screenshot, DOM, and accessibility snapshot, reason `commit_after`.
- **Then the parent's browser closes.** The child's result decides the rest.

| Child result | Decided by | Parent result |
|---|---|---|
| `success` | Code | `success`, commit `found_by_check`, outputs from `{result.*}` |
| A listed "not found" outcome | Code | `absent_by_check`. Retry decision (11.3) |
| Anything else | jev (section 5 §10.5), then a human | By their verdict |

- **Found, but outputs missing:** `failed`, code `outputs_unavailable`, commit `found_by_check`.
- **The child inherits the parent's mode and operator.**
- **The child's inputs** come from `recovery.reconciliation.check.inputs`, filled from the parent's memory.

### 11.2 Outputs after a confirmed commit

- **The commit's checkpoint passed,** so the commit is `confirmed`. Then a later `read` step failed for good.
- **The engine runs the reconciliation check to fetch the outputs,** as a child with `purpose: outputs`.
- **Found:** `success`. The commit stays `confirmed`. `recoveries` lists `via: reconciliation`.
- **Not found or unclear:** `failed`, code `outputs_unavailable`, commit `confirmed`.
- **"Not found" after a confirmed commit** contradicts the checkpoint. Warning `reconciliation_contradiction`.

### 11.3 Retrying a commit that did not happen

1. **The check says `absent_by_check`.**
2. **The parent escalates:** kind `retry_decision`, reason `retry_needs_approval`.
3. **`no_retry`:** the parent ends `failed`, commit `absent_by_check`, `safe_to_retry: true`.
4. **`retry`:** a new child run, kind `replay`, `reason: commit_retry`, with a new run ID.
5. **The parent's final result copies the child's** status, outputs, and effect.
6. **`effect.attempts` lists the earlier attempt:** its run ID and `absent_by_check`.

- **Why a new run, not a second commit in the same run:** "one commit per run" stays true. The gate's `risk.second_commit` stays simple.
- **Why a new run ID:** the retry writes its own correlation reference. A late first commit and the retry never share an ID.
- **At most one commit retry per request.** A second `absent_by_check` ends the request.
- **The authorization is checked again.** Expired: approval at the commit point.

### 11.4 Certify and live

- **Certify:** the scorer checks commit truth per attempt against the oracle (section 8 §8.2).
- **Certify:** each jev reconciliation answer is labelled by the oracle. Correct answers build autonomy evidence (section 8 §14.2).
- **Certify:** on `absent_by_check`, the scripted operator answers `retry` (13.4).
- **Live:** each reconciliation child writes a live line for the check key (section 8 §5.5).

---

## 12. Control lease

### 12.1 The lease record

| Field | Meaning |
|---|---|
| `holder` | `bot`, `human`, or `nobody` |
| `staff_id` | When `human` |
| `waiting` | `true` while the bot holds the lease but waits for an approval |
| `since` | When this grant began |
| `reason` | Why it changed |
| `token` | Random per grant. Kept in memory only |

- **Approvals keep the lease with the bot,** marked `waiting`. Nobody touches the screen during an approval.
- **Takeovers move the lease** to `nobody`, then to a human, then back through reverify.

### 12.2 Transitions

| From | To | When | `reason` |
|---|---|---|---|
| — | `bot` | Run starts | `run_start` |
| `bot` | `bot`, waiting | Approval or start confirmation opens | `awaiting_decision` |
| `bot`, waiting | `bot` | Decision arrives | `decided` |
| `bot` | `nobody` | Takeover opens | `takeover_requested` |
| `nobody` | `human` | An operator claims | `claimed` |
| `human` | `nobody` | The operator hands back | `handed_back` |
| `nobody` | `bot` | Reverify passes | `reverified` |
| `nobody` | `nobody` | Reverify fails. The takeover opens again | `reverify_failed` |
| any | `nobody` | Run ends | `run_end` |

- **There is no `human` to `bot` shortcut.** Every handback goes through reverify.
- **Every change is a `lease` log line** with `from`, `to`, `reason`, and `staff_id`.

### 12.3 The token

- **Every bot action carries the current token.** The gate's first check compares it (section 4 §3.3).
- **A stale action from before a takeover** carries an old token. Blocked: `lease.not_holder`.
- **Human actions carry no token.** The gate observes them after the fact.

### 12.4 Human input while the bot drives

- **The build uses a visible browser.** Nothing stops a hand on the mouse.
- **Human input while the bot holds the lease:** the engine stops before its next action.
- **It opens a takeover,** reason `unexpected_human_input`. Warning `human_input_while_bot`.
- **Why:** the bot can no longer trust the screen it expects.
- **Human input while the lease is `nobody`:** an implicit claim, using the replay process's staff ID. Logged with `implicit: true`.
- **With no staff ID, there is no implicit claim.** The takeover waits for `operator claim`.
- **Human input during an approval wait:** the approval closes unanswered. It becomes a takeover.

---

## 13. Intervention request

**Job:** give the human everything needed to act, in one record.

### 13.1 Fields

| Field | Content |
|---|---|
| `schema` | `"intyy.intervention/1.0"` |
| `run_id`, `tenant`, `capability` | Which run, which bank, which capability and version |
| `kind`, `reason` | From section 3 §5.7 |
| `step` | Step ID and intent |
| `trouble` | Phase, the expected condition's description, and the masked check trace |
| `ladder` | Each rung so far: verdict, handler or bucket |
| `commit` | Commit state. Plus the fixed notice when it is in flight |
| `operator_note` | From a `needs_human` handler, if any |
| `approval` | Approvals only: the control's words, risk class, authorization state |
| `screenshot` | Path to the masked screenshot, reason `escalation` |
| `decisions` | What this kind allows (13.2) |
| `outcomes` | `set_outcome` only: the codes the contract declares at this step |
| `deadline` | When it becomes `escalation_timeout` |
| `lease` | Current holder |
| `on_handback` | Plain text: "The bot will check where the screen is, then continue." |

- **Everything is masked.** The live screen shows the operator the real values.

### 13.2 Decisions per kind

| Kind | Decisions | Notes |
|---|---|---|
| `start_confirmation` | `approved`, `declined` | |
| `approval` | `approved`, `declined` | Discovery adds a risk hint (section 4 §7.7) |
| `takeover` | `handed_back`, `ended_run`, `set_outcome` | Claim first, then act |
| `reconciliation_decision` | `found`, `not_found` | No browser needed. The human checks the app directly |
| `retry_decision` | `retry`, `no_retry` | |

- **`set_outcome` on a commit step in flight** gives `refused`, `decided_by: human`. A human may say "nothing changed." A model may not.

### 13.3 Deadlines

| Kind | Deadline | Policy range |
|---|---|---|
| `start_confirmation` | 15 min | 5 to 60 min |
| `approval` | 30 min | 5 to 120 min. Never past the authorization's expiry |
| `takeover`, to claim | 30 min | 5 to 120 min |
| `takeover`, once claimed | 60 min from the claim | 15 to 240 min |
| `reconciliation_decision` | 4 h | 1 to 24 h |
| `retry_decision` | 30 min | 5 to 120 min |

- **Values live in tenant policy,** block `escalation` (update file, section 4).
- **A claim moves the deadline.** A new `escalation` line records it.

**At the deadline:**

| Situation | Result |
|---|---|
| Commit `not_sent` | `failed`, `escalation_timeout` |
| Commit in flight or `uncertain` | Reconciliation check first. Then the result follows it |
| Reconciliation decision unanswered | `failed`, `escalation_timeout`, commit `uncertain`. The worst case in section 3 §5.12 |

### 13.4 The operator port in the build

- **Mailbox location:** `runs/<run_id>/mailbox/<nn>_<kind>/`, one subfolder per intervention (section 9 §10.5).

| File | Written by | Holds |
|---|---|---|
| `request.json` | Engine | The intervention request |
| `claim.json` | Operator CLI, or the engine for an implicit claim | Staff ID and time |
| `release.json` | Operator CLI | Handback, with an optional note |
| `decision.json` | Operator CLI | The decision and its fields |
| `dialogs.jsonl` | Operator CLI | One line per native dialog answer |
| `closed.json` | Engine | How the request closed: `resolved`, `timed_out`, or `run_ended` |

- **Claims use exclusive create.** A second claimer fails; there is no race.
- **Every other write is atomic:** write a temporary file, then rename it.
- **Notes pass the text rules** before they are written.
- **The engine checks the mailbox every 500 ms.**
- **Supervised runs** also prompt in the same terminal. Both paths write the same files.
- **Why files:** zero infrastructure, easy to test, and every message is reviewable. The brief warns against queues.
- **The operator CLI never drives the browser.** Only the human's hands do, in the visible window.

**A scripted twin, certify only:**

| Kind | Scripted answer |
|---|---|
| `start_confirmation` | Never asked. Certify runs behave as unattended |
| `approval` | `approved`, staff ID `certify`. Only under `approvals.force_human` |
| `retry_decision` | `retry` |
| `takeover`, `reconciliation_decision` | None. The case records the escalation, then the run ends |

- **Every scripted answer is logged** with `staff_id: certify`.
- **Why stop at takeovers:** a script acting as a human would test the script. The tests in §21 exercise the handoff itself.
- **Port definition:** section 9 §5.4.

---

## 14. Human action capture

### 14.1 What is captured

- **A small script runs in every page and frame.** It reports input events to the engine.

| Event | Becomes |
|---|---|
| Click | `click` |
| A text field loses focus with a changed value | `type`, one per field (section 4 §8.10) |
| Dropdown change | `select` |
| Checkbox or radio change | `set_checked` |
| Enter, Escape, Tab, function keys | `press` |
| Address bar navigation | `navigate`. The network guard still applies |
| Native dialog answered | `click` on Accept or Dismiss |

- **Each action gets a light fingerprint:** role, name, visible label, text, box, and path. Taken as the event happens.
- **No crops.** The screen has already changed by then.
- **Each action is a `gate` line with `observed`** and an `action` line with `by: human`.

### 14.2 Values

| Field | Logged as |
|---|---|
| Password field | `[secret]`. The script never reads its value |
| Value equals a known input | Its reference |
| Anything else | `[human_text]` |

- **Raw values cross to the engine in memory only.** The log writer masks them. Nothing raw is written.

### 14.3 Bot or human?

- **The engine marks its own action windows:** from just before it acts until 300 ms after.
- **An input event on the bot's target inside that window** is the bot's.
- **Every other input event is human.**
- **The remote console design removes the guesswork** (section 19). There, human input arrives through intyy.

### 14.4 Did the human perform the commit?

- **A human click, Enter, or dialog Accept is scored against the commit step's target clues.**
- **Score 0.70 or more, while the commit is `not_sent`:** the human sent the commit.
- **Commit state becomes in flight,** `performed_by: human`, `sent_at` from the event.
- **Watchers then settle it** (section 15).
- **Other irreversible human actions:** warning `human_irreversible_action` only (section 4 §7.10).

**Known limit:** a human may click Confirm again while the bot's commit is in flight. The build cannot stop it.

- **The takeover notice warns against it.**
- **The reconciliation check may then find two accounts.** The oracle's `count` can show this in tests (CONTRACT §8).
- **The remote console design can block it** before the click lands.

### 14.5 Native dialogs during a takeover

- **The engine holds native dialogs open.** The human may not be able to click them in the window.
- **So the operator answers them through the CLI:** accept or dismiss. Logged as a human action.

---

## 15. Watchers during a takeover

- **While a human drives, the engine keeps reading the screen.** It never acts.
- **Every second it checks:**
  1. **The commit step's checkpoint and declared outcomes,** if the commit is in flight.
  2. **Nothing else.** Watching more would only add noise.
- **Checkpoint passes:** commit `confirmed`, at that moment.
- **Declared outcome shows:** commit `refused`, `decided_by: code`.
- **Logged as `check` lines with role `watch`.**
- **Why watch:** the human may pass the confirmation screen and move on. The proof would then be gone at handback.

---

## 16. Handback and reverify

### 16.1 Order

1. **Capture** a screenshot, reason `handback`.
2. **Settle the commit.** In flight and not settled by watchers? Check its checkpoint and outcomes now.
   - Still unknown: commit `uncertain`. Go to the reconciliation check (section 11). Stop here.
3. **Search forward** for a resume step (16.2).
4. **Else apply the resume rule** from the stuck step (section 5 §8.6).
5. **Else reverify failed** (16.4).
6. **Found a step:** lease to `bot`, reason `reverified`. Record `resumed_at_step`.

### 16.2 Forward search

**Job:** credit the human for steps they finished, and only those.

- **Search from the last step down to the step after the stuck one.** Stop early at the first `read` step.
- **A step K qualifies when:**
  1. K's precondition passes now, **and**
  2. the step before K has its checkpoint passing now.
- **Take the latest K that qualifies.** Steps from the stuck step to K−1 end with result `done_by_human`.
- **Crossing the commit point needs commit `confirmed`.**

**Why rule 2:** fill steps on one form all pass their screen condition.

- **Without rule 2,** replay would skip to the last field and leave the deposit empty.
- **With rule 2,** a step counts as done only when its own checkpoint proves it.

**Why stop at the first `read` step:** the bot must read outputs itself. The human never types outputs (section 3 §5.12).

### 16.3 The human moved past the outputs

- **The read step's precondition no longer passes.** Example: the human left the confirmation page.
- **Then the outputs come from the reconciliation check** (section 11.2).

### 16.4 Reverify failed

- **The takeover opens again,** reason `stuck`, with the note "handback check failed."
- **The lease stays `nobody`.** Warning `handback_check_failed`.
- **The human can act again, set an outcome, or end the run.**

### 16.5 Drafts from takeovers

- **A takeover caused by an unknown state** writes a draft handler (section 5 §12).
- **A takeover caused by a `needs_human` handler** writes none. The state is already known.

---

## 17. Crash and restart

- **In the build, each CLI command is one process.** A crash leaves a run folder with no `run_end`.
- **Each running run holds a lock file** at `state/var/locks/runs/<run_id>.lock` (`intyy.lock/1.0`), with its process ID.
- **Every intyy command starts with a sweep** for runs with no `run_end` and no live lock.
- **`intyy run sweep` prints the report** of what it closed (section 9 §10.7).

**The sweep writes:**

| Found in the log | Result |
|---|---|
| No `commit_intent` | `failed`, `internal_error`, commit `not_sent` |
| `commit_intent`, then a passed commit checkpoint | `failed`, `internal_error`, commit `confirmed` |
| `commit_intent`, nothing after | `failed`, `internal_error`, commit `uncertain` |

- **`run_end` data adds `recovered_after_crash: true`.**
- **Uncertain runs are flagged** for `intyy reconcile` (section 9 §10.6).
- **A crash inside a certify batch is swept the same way.** The scorer marks the case `void`, and re-runs it up to 2 times (section 8 §8.3).
- **Known limit:** raw inputs died with the process. The operator re-enters them for the check. intyy never stored them, by design.
- **Ctrl-C once ends the run as `ended_by_operator`,** at the next safe point, never mid-commit. A second Ctrl-C kills the process (section 9 §10.3).

---

## 18. Determinism

**Same frozen facts, same inputs, same app state, same fault seed: same step trace** (section 3 §6.8).

| Source of drift | Control |
|---|---|
| Window size and pixel density | From `runs_on.viewport`, fixed |
| Fonts | Pinned in the runtime image |
| Motion | Reduced motion on. Animations off |
| Locale and time zone | Fixed per bank in settings |
| Business date | Fixed by the bank app (CONTRACT §7) |
| Faults | Seeded, per route and counter (CONTRACT §6) |
| Waits | End on state, never time |
| Voting | Fixed weights per engine version |
| Models | jev and reviewer marked in the trace; faked in CI |

- **The determinism test** runs the same replay twice with fakes and compares traces.

---

## 19. Remote console (design only)

- **A web console per bank,** listing open interventions in a queue.
- **It streams the same browser session** to the operator. The live stream is never recorded.
- **Human input flows through intyy.** So the gate sees it before it lands.
- **Then the gate can warn on an irreversible human click,** and block a second commit.
- **The lease is real by construction.** No one can touch the browser except through the console.
- **Claims, handbacks, and decisions** use the same mailbox records, sent over the network instead of files.
- **The browser runs on intyy's servers,** not the operator's machine.

---

## 20. Worked example: supervisor approval

The bank app's `supervisor_required` fault is on. Its screen text is invented here.

1. **`click_submit` runs.** `commit_intent` is on disk. The click is `dispatched: true`.
2. **The checkpoint fails.** The screen says "Supervisor approval required."
3. **Closed window.** No declared outcome. The `supervisor_approval` handler matches: `needs_human`.
4. **Takeover opens.** Commit `uncertain` for now. Lease `bot` to `nobody`. The notice warns: do not submit again.
5. **A supervisor claims it.** Lease to `human`.
6. **The supervisor types a code and clicks Approve.**
   - The code logs as `[human_text]`.
   - "Approve" is an irreversible word. Warning `human_irreversible_action`.
   - It does not match the commit target. No commit match.
7. **The watcher sees the confirmation.** Commit `confirmed`, `performed_by: bot`.
8. **The supervisor hands back.** Forward search: `read_account_number` qualifies. Its precondition passes, and `click_submit`'s checkpoint passes.
9. **The bot reads the account number.** `success`, one intervention, three human actions.
10. **No draft handler.** A known handler caused this takeover.

```json
"interventions": [
  { "kind": "takeover", "reason": "needs_human_handler", "step": "click_submit",
    "staff_id": "op_044", "decision": "handed_back",
    "requested_at": "2026-09-24T11:02:10.004Z", "resolved_at": "2026-09-24T11:04:51.300Z",
    "human_actions": 3, "resumed_at_step": "read_account_number" }
]
```

---

## 21. Tests that prove it

| Test | Proves | In CI? |
|---|---|---|
| Settle and wait | Waits end on state; quiet cap holds; no fixed sleeps | Yes |
| Outcome race | "Not found" wins early; overlap warning | Yes |
| Clue voting | Stripped button wins; renamed button fails; ties are ambiguous; evidence rules hold | Yes |
| Unknown logic | `not` of unknown never passes | Yes |
| Dispatch | A covered Confirm stays `not_sent` | Yes |
| Transport | `hang` recovers on an `idempotent` step; reconciles after Confirm | Yes |
| Native dialog | A confirm box appears as elements; Accept is classed by its words | Yes |
| Prelude | Sign in, start task; `sign_in` recovers a lost session; no loop in the prelude | Yes |
| Reconciliation | `drop_after_confirm` ends `success`, `found_by_check`, via a child run | Yes |
| Commit retry | `absent_by_check`, then `retry`: a new child run with a new run ID | Yes |
| Lease | Stale token blocked; no human-to-bot shortcut; human input pauses the bot | Yes |
| Mailbox | Claim, release, and decisions through files | Yes |
| Handoff | A scripted "human" takes over, acts, and hands back | Yes |
| Forward search | Credits finished fills only; stops at `read` steps; needs `confirmed` to cross the commit | Yes |
| Crash sweep | Each row of section 17 | Yes |
| Determinism | Two runs, same trace | Yes |

---

## 22. How this meets the brief

| Brief asks | Where |
|---|---|
| 3.3 Replay without the LLM; stable targeting | 4, 6 |
| 3.3 Verify the checkpoint; return outputs | 5.3, 11.2, 16.3 |
| 3.3 Slow or failed loads, unexpected dialogs, session timeout | 5, 7.3, 9, 10 |
| 3.3 Failure detail: step, expected, observed | 6.8, section 3 §5.5 |
| 3.6 Detect and route with context | 13 |
| 3.6 Operate the same live session | 12, visible browser, 14 |
| 3.6 Hand control back; record what the human did | 14, 16 |
| 3.6 Know who is in control | 12 |
| 3.6 Full console out of scope; mechanism real | 13.4 built; 19 designed |
| 3.7 Seam between perceiving and the recorded flow | 6, 9: clues and roles work on web and desktop alike |

---

## 23. Rejected options

| Option | Why rejected |
|---|---|
| Fixed sleeps | Slow or wrong on a 200 ms to 8 s app |
| First matching selector | One change breaks it. Clues vote instead |
| Exact role match | A stripped button loses its role. Groups keep it |
| Missing clues count as differences | Every stripped button would fail |
| No evidence floor | A near-blank element could win on little |
| Ambiguous checks count as false | `not` would then pass. Unknown instead |
| Reconciling in the parent's session | That session may hang or be broken |
| A second commit in the same run | Breaks "one commit per run" and the gate's check |
| Human to bot without reverify | The bot would act on a screen it has not checked |
| A local web server for the operator | Infrastructure for a CLI build. Files do the job |
| Storing raw inputs for crash recovery | Breaks "never persist sensitive data" |
| Forward search on preconditions alone | Skips fills the human never did |
| Watching every condition during a takeover | Noise. Only the commit matters |

---

## 24. Items parked for other sections

| Item | Section |
|---|---|
| Tuned timeouts: how certify measures them | 8. Resolved: section 8 §9.6 |
| Calibrating clue weights from certify margins | 8. Resolved: section 8 §14.4. Designed only |
| Approval of session and reconciliation capabilities per context | 8. Resolved: section 8 §10.10 |
| Resolver: supervised runs on an unapproved context | 8. Resolved: section 8 §11.4 |
| CLI commands: operator mailbox, manual reconcile, crash sweep report | 9. Resolved: section 9 §10.4, §10.6, §10.7 |
| Mailbox, lock file, and interventions locations | 9. Resolved: section 9 §6.3, §10.5 |
| Port definitions for surface, operator, and classifier | 9. Resolved: section 9 §5 |
| The stripped-button demo: record with the flag on, or with the same picture | 10 |
| Which replay and handoff runs go in `/evidence/` | 10 |

---

## 25. Terms used in this section

| Term | Meaning |
|---|---|
| Settle | Wait until the page stops loading |
| Quiet | No page or data request in flight for 500 ms |
| Outcome race | Checkpoint and declared outcomes checked together |
| Candidate | An element that might be the target |
| Role group | Roles that count as the same kind of control |
| Score | Agreeing clue weight over shared clue weight |
| Margin | Winner's score minus runner-up's |
| Evidence | Total weight of agreeing clues |
| Picture likeness | Plain-code pixel comparison of a crop |
| Unknown | A check result that is neither true nor false |
| Dispatched | Whether the browser really sent the input |
| Transport failure | The connection failed, not the app |
| Active page | The window whose elements are candidates |
| Lease | Who drives: bot, human, or nobody |
| Lease token | A random value that proves the current grant |
| Mailbox | Files for engine and operator messages |
| Watcher | A read-only check during a takeover |
| Reverify | The bot's checks after a handback |
| Forward search | Crediting steps the human finished |
| Crash sweep | Closing runs a crashed process left open |
