# intyy — Section 2: artifact schema

> **Status:** complete, 24 Sep 2026.
> **Formats defined:** `intyy.artifact/1.0` and `intyy.patch/1.0`.
> **Depends on:** `1-intyy-component-level-design.md` (section 1) and the section 1 amendment note.
> **Used by:** sections 3 to 10.
> **Amended by section 3,** 24 Sep 2026: caller version form, commit states, refusal outcomes, run ID format, more frozen facts. `intyy.artifact/1.0` was not yet released, so 1.0 is amended in place.
> **Amended by section 4,** 24 Sep 2026: `runs_on.paths`, path wildcard rule, mask formats, secret-field condition rule, crop rules, policy-aware checks. Also amended in place.
> **Amended by sections 5 to 7,** 25 Sep 2026: new `runs_on.session` field, `format` fields on `type`/`read`/`field_value`, exact clue-vote thresholds, three-valued condition checks, new clue notes for `region` and `path`, loader checks for session links, formats, and candidate placeholders. Also amended in place.
> **Amended by sections 8 and 9,** 25 Sep 2026: major record and per-context deprecation dates, the approval key and its states, tuned timeout kinds, `risk_second_look` decisions, patch draft thresholds and lifecycle, a loader check for unconfirmed lowered risk, and the content hash moving to each store's `index.jsonl`. Also amended in place.
> **File format:** JSON. Zod defines the schema and exports JSON Schema.

---

## Contents

1. [Purpose](#1-purpose)
2. [Readers and their needs](#2-readers-and-their-needs)
3. [Design principles](#3-design-principles)
4. [The ten blocks](#4-the-ten-blocks)
5. [Identity and versions](#5-identity-and-versions)
6. [Lifecycle: who writes it, and when it freezes](#6-lifecycle-who-writes-it-and-when-it-freezes)
7. [Shared syntax](#7-shared-syntax)
8. [`schema`](#8-schema)
9. [`identity`](#9-identity)
10. [`runs_on`](#10-runs_on)
11. [`about`](#11-about)
12. [`contract`](#12-contract)
13. [`targets`](#13-targets)
14. [`conditions`](#14-conditions)
15. [`steps`](#15-steps)
16. [`recovery`](#16-recovery)
17. [`provenance`](#17-provenance)
18. [Tenant patch format](#18-tenant-patch-format)
19. [Loader checks](#19-loader-checks)
20. [What stays out of the artifact](#20-what-stays-out-of-the-artifact)
21. [Full example](#21-full-example)
22. [Items parked for other sections](#22-items-parked-for-other-sections)
23. [Terms used in this section](#23-terms-used-in-this-section)

---

## 1. Purpose

- **An artifact is a promise plus a recipe.**
- **The promise** tells a caller what it sends, what it gets, and whether data changes.
- **The recipe** tells replay how to deliver the promise, with no LLM.
- **The design starts from the readers,** not from the steps.

---

## 2. Readers and their needs

| Reader | Needs |
|---|---|
| Calling AI agent | What it does, what to send, what returns, whether it changes data |
| Replay engine | Exact steps, how to find each control, how to prove each step worked |
| Human reviewer | A plain summary, and where each part came from |
| Resolver | Which app, app versions, and surface it supports |
| Recovery logic | Which step is irreversible, and how to check the result after a failure |

### Brief requirements (3.2) and where they live

| Brief asks for | Lives in |
|---|---|
| Ordered steps | `steps` |
| How each control is found, with robustness reasoning | `targets` |
| Typed inputs | `contract.inputs` |
| Typed outputs and their shape | `contract.outputs` |
| Checkpoint or success condition | `conditions`, referenced by `steps` |
| Versioned | `identity.version` |
| Reviewable by humans and agents | `about`, `provenance`, readable JSON |
| Decoupled from the model transcript | `provenance` links runs; it never copies them |

---

## 3. Design principles

### 3.1 Separate the promise from the recipe

- **The caller reads `contract`. Replay reads `steps`.**
- **The recipe can change while the promise stays the same.** That is a patch version.

### 3.2 Facts in the file, changing state outside

- **The file holds what is always true** about one version.
- **Approval, scores, tuned timeouts, and tenant patches change.** They live elsewhere.
- **A sealed file never changes.** Evidence can point to it with certainty.

### 3.3 Say each thing once

- **Controls live once, in `targets`.** Steps and conditions refer by ID.
- **Screen checks live once, in `conditions`.** Steps, outcomes, and handlers refer by ID.
- **Derived facts are not stored.** Example: the required secrets come from the steps.

### 3.4 Show risk at the top

- **`contract.effect` says whether the capability commits a change.**
- **A caller learns this without reading the steps.**

---

## 4. The ten blocks

| # | Block | Job | Main reader |
|---|---|---|---|
| 1 | `schema` | Version of the file format | Loader |
| 2 | `identity` | App, capability, version: the unique key | All |
| 3 | `runs_on` | Surface, app versions, viewport, entry path | Resolver, replay |
| 4 | `about` | Plain summary | Humans, calling agent |
| 5 | `contract` | Inputs, outputs, outcomes, effect | Calling agent |
| 6 | `targets` | Named controls with fingerprints | Replay |
| 7 | `conditions` | Named screen checks | Replay |
| 8 | `steps` | The ordered recipe | Replay |
| 9 | `recovery` | Commit point, reconciliation, undo link | Recovery logic |
| 10 | `provenance` | Source runs, tags, human decisions | Reviewers, section 8 |

- **`recovery` is present only when `effect` is `commits`.** All other blocks are always present.

---

## 5. Identity and versions

### 5.1 Identity

- **Identity = app + capability + version.** Written as `kvfcu/open_share_subaccount@1.2.0`.
- **App version range is not identity.** It is a claim, stored in `runs_on`.
- **Tenant is not identity.** Tenant changes live in patch files.
- **Why:** two versions can be live at once. Example: v1 for app v8, v2 for app v9.
- **Callers name a major version:** `app/capability@major`. Example: `kvfcu/open_share_subaccount@1`.
- **The resolver picks the rest:** minor version, patch version, and tenant patch (section 8).
- **Why the major:** a major version breaks callers by definition. Without it, a v2 rollout silently breaks v1 callers. Same form as `recovery` links.

### 5.2 Version rules (semver)

The version tracks what the caller sees.

| Change | Bump | Examples |
|---|---|---|
| Breaks a caller | Major | Input removed or renamed. Output type changed. New required input. Outcome removed. `read_only` becomes `commits` |
| Grows safely | Minor | New optional input. New output. New outcome |
| Caller sees nothing | Patch | New clue. Default timeout changed. App version range widened. `runs_on.paths` widened |

### 5.3 Supporting rules

- **Sealed artifacts are immutable.** Any change makes a new version.
- **Every new version starts as draft.** Even a patch version. Trust is never inherited.
- **The content hash lives in each store's `index.jsonl`** (`intyy.index/1.0`), not in the file. Inside the file it would be circular.
- **New outcomes are minor.** So callers must be lenient readers. Section 3 §5.14 holds the full rule set:
  1. Unknown outcome code: generic business outcome. Show its `description`.
  2. Unknown failure code: generic failure. Trust `transient` and `safe_to_retry`.
  3. Unknown warning code: ignore.
  4. Unknown result field: ignore.
- **Fixed for result format 1:** statuses and commit states. New ones need format 2.
- **A major record** (`intyy.major/1.0`) holds the deprecation and retire dates (section 8 §11.9).
- **The `major_version_deprecated` warning** shows only where the successor is approved in that context.
- **Retire date per context** = the later of `retires_on`, and 90 days after the successor's first approval there. Never tell a caller to move to a successor that does not run at its bank.

---

## 6. Lifecycle: who writes it, and when it freezes

### 6.1 The recorder writes the artifact

- **The recorder is plain code.** The same run always gives the same file.
- **Only observed facts go in.** An LLM could invent a selector. The recorder cannot.
- **Every field traces to a logged event** or a recorded human decision.
- **The recorder reads the redacted discovery log alone.** The log writer already turned exact input values into `{input.name}` and secrets into `{secret.name}` (section 3 §6.7).
- **So raw member data never needs to be on disk.** The exact-match rule still holds; the match happens in the log writer.

### 6.2 Who contributes what

| Contributor | Supplies |
|---|---|
| Operator at the CLI | Goal, example inputs, input names |
| Discovery LLM | Actions, a reason per action, tags, extraction requests |
| Recorder | The file itself |
| Policy rules | Sensitivity labels, draft risk flags |
| Human reviewer | Tag decisions, outcome names, risk confirmations, `about` edits |

### 6.3 Negative discovery runs

- **A happy-path run never sees "member not found."**
- **So the operator runs discovery with a known-bad input** and states the expected outcome.
- **The recorder captures that screen as the outcome's condition.**
- **A human names the outcome code.** The machine never guesses meaning.

### 6.4 Candidate, then sealed

| Stage | Editable | What happens |
|---|---|---|
| Candidate | Yes, through the CLI only | Human reviews tags, labels, risks; names outcomes; adds negative runs |
| Sealed | Never | Gets a version and a hash. Ready for certify |

- **Human review happens before sealing,** because `provenance` records the decisions.
- **No hand edits in a text editor.** The CLI validates each edit and records who made it.
- **Edits are recorded decisions.** `candidate decide` appends to `decisions.jsonl`. The last decision on a subject wins. Nothing is deleted.
- **At sealing, the CLI proposes the version bump,** by §5.2. A smaller bump than the rules need is refused.
- **Sealed artifacts sit at `library/artifacts/<app>/<capability>/<version>/artifact.json`,** crops beside them.

### 6.5 Approval lives outside the artifact

- **Approval is per context:** artifact version, tenant, app version, patch revision.
- **It lives in the score store** (section 8). No record means draft.
- **States:** `draft`, `approved`, `degraded`, `retired`.
- **One approved key per context and major.**
- **Recorded, but kept out of the key:** engine version, handler set hash, jev version, policy hash. They sit in each batch's `under`.
- **Why kept out:** with shared parts in the key, every pack change would demote every key. Approval checks freshness instead.
- **Sealing is not approval.** Sealed means "content fixed." Approved means "trusted here."
- **The CLI joins artifact and approval records** so reviewers still see status.

### 6.6 Timeouts

- **The artifact holds a default timeout per step.** The recorder sets it from observed timing plus a margin. Recorder defaults keep a 30 s cap.
- **Tuned timeouts live in the score store,** per key (6.5). Certify measures them.
- **Tuned values come in two kinds:** `approved`, used by live replay; `candidate`, used by the next certify batch.
- **Approval installs the values the batch ran with.** So a first approval runs on defaults. Live runs never change timeouts.
- **Certify's bound:** the largest of the floor, 1.5 × the 95th percentile, and 1.2 × the longest sample. Round up to 500 ms. Cap 60 s, since tuned values come from measured samples. Needs 20 clean samples at delay scale 1.
- **Replay freezes tuned timeouts at run start** and logs them. Determinism holds.
- **Full frozen list per run:** artifact version and hash, patch revision, engine version, handler set, tuned timeouts, policy version and hash, app version, evidence level, session capability (ID, hash, patch revision). Each can change a run's behavior or evidence (section 3 §6.5).

---

## 7. Shared syntax

### 7.1 IDs

- **Lower snake case:** `click_search`, `one_result_row`.
- **Unique within their kind:** targets, conditions, steps, inputs, outputs, outcomes.
- **Never numbers.** Numbers shift when a step is inserted, and patches break.
- **Stable across versions.** The recorder reuses IDs by matching fingerprints to the previous version.

### 7.2 Value references

Written as `{namespace.name}`. Five namespaces.

| Namespace | Meaning | Allowed in |
|---|---|---|
| `input` | A caller input | Steps, conditions, target text clues, reconciliation inputs |
| `system` | A value intyy supplies | Steps, conditions, reconciliation inputs |
| `secret` | A secret name, from bank settings | `type` action values only |
| `output` | This capability's output | `compensated_by` inputs only |
| `result` | The reconciliation capability's output | `reconciliation.check.outputs` only |

- **System values in format 1.0:** `run_id` only. Each new system value is a minor format change.
- **Plain text is allowed.** Example: `"Savings"`.
- **References can sit inside text.** Example: `"Ref {system.run_id}"`.
- **Secrets must fill the whole value.** Never joined with other text. Partial secrets can leak.
- **Handler packs have their own format** (`intyy.pack/1.0`). There, `{system.last_good_path}` is allowed, only as a `navigate` location.
- **Packs forbid `{input.*}`.** A pack cannot know a capability's inputs.

### 7.3 Wildcards

- **`*` matches one or more characters.**
- **Used in:** text matching, `location` patterns, `runs_on.app_versions`, `runs_on.paths`, `read` patterns.
- **In path fields, `*` never crosses `/`.** Path fields: `location` patterns, `runs_on.paths`, and policy path patterns.
- **Why:** `/members/*` must not allow `/members/100107/close`.
- **Query parameters:** a path pattern with `?` lists parameters that must be present and match. Others are ignored. Without `?`, the query is ignored.
- **Text and version fields keep the plain rule.** There, `*` may match any character.
- **No regular expressions anywhere.** They are hard to read and easy to get wrong.

### 7.4 Text matching

- **Always trims and collapses spaces.**
- **Ignores letter case by default.** Old bank apps often use capitals. `case_sensitive: true` turns this off.

---

## 8. `schema`

- **One string:** `"intyy.artifact/1.0"`.
- **Minor format change:** new optional fields. **Major:** anything else.
- **The loader rejects files newer than it knows.**
- **The loader rejects unknown fields.** An old loader must not skip a new safety field.

---

## 9. `identity`

| Field | Rule | Example |
|---|---|---|
| `app` | Vendor app ID | `kvfcu` |
| `capability` | Verb first, snake case | `open_share_subaccount` |
| `version` | Semver | `1.0.0` |

- **Only these three fields.** Together they form the unique key.

---

## 10. `runs_on`

| Field | Meaning | Example |
|---|---|---|
| `surface` | Which adapter drives it | `web` or `desktop` |
| `app_versions` | App versions it claims to support, as wildcards | `["8.*"]` |
| `viewport` | Window size and pixel density at recording | `{ "width": 1280, "height": 800, "scale": 1 }` |
| `entry` | Where the run starts, as a path | `/login` |
| `paths` | Every path pattern the capability visits. Required | `["/login", "/home", "/members/search", "/members/*", "/accounts/new"]` |
| `session` | Session capability link, or `null` | `"kvfcu/sign_in@1"` |

- **`app_versions` uses wildcards,** because vendor versions are often not semver. Example: "9.2 SP3."
- **`viewport` matters** because `region` and `image` clues only match at the same window size.
- **`entry` is a path, never a full address.** Each bank hosts the app at its own address. Bank settings supply it.
- **With a `session` link, `entry` is the first task page,** after the prelude. Example: `/home`.
- **With `session: null`, `entry` is where the artifact's own login starts,** or its first page if it needs none. The full example (21) works this way.
- **A patch version may not change `session`.** Changing the login recipe is a minor version. It changes what the run needs.
- **Same rule for `navigate` locations** in steps.
- **Bank settings have a format:** `intyy.settings/1.0` (section 4 §5).
- **`paths` lists every page the run reaches.** Clicks reach pages no `navigate` step names. The bank's allowlist must cover them all.
- **The recorder derives `paths` from discovery.** A human confirms them at review.
- **Widening `paths` is a patch version.** The caller sees no change.

---

## 11. `about`

| Field | Audience | Example |
|---|---|---|
| `title` | Humans | "Open share sub-account" |
| `summary` | Both | "Opens a share sub-account for a member and returns its number." |
| `when_to_use` | Calling agent | "Use when a member asks to open a new share account." |
| `limits` | Both | "Does not move money from other banks." |

- **The recorder drafts it from the goal.** A human edits it in the candidate.
- **`summary` and `when_to_use` become the agent's tool description.**
- **No member data.**

---

## 12. `contract`

**Job:** everything the caller needs, and nothing it does not.

### 12.1 Parts

| Part | Holds |
|---|---|
| `inputs` | What the caller sends |
| `outputs` | What the caller gets on success |
| `outcomes` | Business outcomes the caller must handle |
| `effect` | `read_only` or `commits` |

### 12.2 Input fields

| Field | Meaning | Example |
|---|---|---|
| `name` | Used in `{input.name}` | `member_id` |
| `type` | Value type | `string` |
| `description` | One plain sentence | "The member's ID number" |
| `required` | Must the caller send it? | `true` |
| `sensitivity` | How logs treat it | `pii` |
| `constraints` | Optional limits | See 12.4 |

### 12.3 Types

- **`string`, `integer`, `decimal`, `money`, `date`, `boolean`, `enum`.**
- **`money` is a decimal string,** like `"100.00"`. Floating-point numbers lose cents.
- **`date` is `YYYY-MM-DD`.**

### 12.4 Constraints

| Constraint | Applies to | Example |
|---|---|---|
| `length` | `string` | `{ "min": 5, "max": 8 }` |
| `range` | `integer`, `decimal`, `money`, `date` | `{ "min": "1.00", "max": "10000.00" }` |
| `values` | `enum` | `["savings", "checking"]` |
| `format` | `string` | `digits`, `letters`, or `alphanumeric` |

- **Bad inputs are rejected before the run starts.** No browser opens.

### 12.5 Output fields

- **`name`, `type`, `description`, `sensitivity`.**
- **Outputs return on success only.**
- **Replay converts read text to the declared type.** Example: `"1,250.00"` becomes money `"1250.00"`.
- **Conversion failure is a hard failure.** Redacted evidence keeps the raw text.

### 12.6 Outcome fields

| Field | Meaning | Example |
|---|---|---|
| `code` | Stable name | `member_not_found` |
| `description` | One plain sentence | "No member has this ID" |
| `condition` | Condition ID that detects it | `no_member_text` |

- **Task-specific outcomes live here.** App-wide interruptions live in handler packs.
- **An outcome on the commit step means "the app refused."** Example: "Deposit exceeds daily limit" after Confirm. The action was sent, but nothing changed.
- **The result is `business_outcome` with `effect.commit: refused`.** A human must confirm "no change happened" for each such outcome (17.4, 19.4).

### 12.7 Sensitivity labels

- **`none`, `pii`, `financial`.**
- **Every input and output has one.**
- **The recorder sets labels from policy rules,** never from the LLM. A human confirms them.
- **Masking follows section 4 §9.** In `run_start` and stored results: `[pii]`, `[financial]`. In screen text: references or per-run tokens.

### 12.8 Derived, not stored

- **Required secrets** come from the steps' `{secret.*}` references. The caller never sees secrets.
- **Authorization need** comes from `effect: commits`.

### 12.9 Agent-facing export

- **Zod exports `inputs` and `outputs` as JSON Schema.** That is the calling agent's tool definition.
- **Steps, targets, and conditions stay hidden** from the calling agent.

---

## 13. `targets`

**Job:** name each control once, with many clues that identify it.

### 13.1 Fields

| Field | Meaning | Example |
|---|---|---|
| `id` | Unique name | `search_button` |
| `description` | One plain sentence | "The Search button in the member panel" |
| `within` | Optional parent target | `search_panel` |
| `clues` | The fingerprint | See 13.2 |

- **`within` separates repeated controls.** Example: three "Open" buttons on one page.

### 13.2 Clues

| Clue | Meaning | Strength | On desktop |
|---|---|---|---|
| `role` | Kind of control: button, textbox, link, row | Gate | Yes |
| `name` | Accessible name | Strong | Yes |
| `label` | Visible label beside the control | Strong | Yes |
| `text` | Visible text inside the control | Strong | Yes |
| `region` | Position as fractions of the window: `x`, `y`, `w`, `h` | Medium | Yes |
| `image` | File name of a small crop of the control | Medium | Yes |
| `path` | Page structure path, including frames | Weak | No |

- **Any clue may be missing.** Example: a blank icon has no `text`.
- **`name` and `label` match exactly,** after normalization (7.4).
- **`text` matches if the control's text contains the clue.** Rows hold long text.
- **Text clues may use `{input.*}`.** Example: the row that contains `{input.member_id}`.
- **`region` is document position divided by viewport size.** Scrolling does not change it.
- **`path` may start with `window[popup]`** for pop-up windows, or `native:dialog` for browser dialogs.

### 13.3 How clues vote

1. **`role` filters first,** when recorded. A button never matches a link.
2. **Clues score each candidate:** agreeing weight over the weight of clues both sides have. Missing clues leave the vote.
3. **Evidence floor:** agreeing weight at least 0.20, and a `name`, `label`, `text`, or `image` clue agrees.
4. **Winner:** score 0.70 or more with a 0.15 lead. Otherwise `target_not_found` or `target_ambiguous`.

- **Weights and thresholds live in the replay engine,** not the artifact. Numbers: section 7 §6. They change only with the engine version.
- **Each run logs the engine version.** Same rules every time.

### 13.4 Safety rules

- **Image crops are redacted before saving.**
- **Crops of input boxes are taken before typing.** No member data lands in a crop.
- **Crops are taken only of button-like controls and empty input boxes.** Never rows or cells.
- **A crop with any mask box in it is dropped.** The target keeps its other clues.

### 13.5 Why this beats one selector

- **Scrapers store one selector.** One change breaks them.
- **Role and name lead.** They exist on web and desktop alike.
- **The image crop is the backup** when a screen has no page code.
- **Tenant patches mostly change clues.** Example: Lakeshore renames "Search" to "Find."

---

## 14. `conditions`

**Job:** describe what the screen shows, in one shared language.

### 14.1 Used by

- **Preconditions:** checked before a step.
- **Checkpoints:** checked after a step.
- **Outcome detectors:** in `contract.outcomes`.
- **Handler detectors:** in handler packs (section 5). They use the same language, minus `field_value`. Fixtures hold no field values, so it cannot be tested offline.

### 14.2 Shared fields

| Field | Meaning | Required |
|---|---|---|
| `id` | Unique name | Top-level conditions only |
| `check` | Check type | Yes |
| `description` | One plain sentence | Top-level conditions only |

- **No timeout field.** The step using the condition sets the wait.
- **Replay waits until the condition is true,** up to the timeout. Never a fixed sleep.
- **Each check answers true, false, or unknown.** An ambiguous target gives unknown. Only true passes.

### 14.3 Check types

| Check | Fields | Example |
|---|---|---|
| `element_visible` | `target` | `search_button` is on screen |
| `element_state` | `target`, `state` | `confirm_button` is `enabled` |
| `text_visible` | `text`, `match`, `within`?, `case_sensitive`? | "No member found", `contains` |
| `field_value` | `target`, `value`, `match`, `format`?, `case_sensitive`? | `deposit_box` holds `{input.deposit}` |
| `count` | `within`, `item`, `op`, `value` | `results_table` has `equals` 1 `row` |
| `location` | `pattern` | `/members/*` |

`?` means optional.

- **`field_value` gains optional `format`,** matching the `type` step that filled the field.

### 14.4 Allowed values

- **`state`:** `enabled`, `disabled`, `checked`, `unchecked`, `selected`.
- **`match`:** `exact`, `contains`, `wildcard`.
- **`item`:** `row`, `list_item`, `option`.
- **`op`:** `equals`, `at_least`, `at_most`.
- **`location`:** web reads the URL path. Desktop reads the window title.

### 14.5 Combining

| Combiner | Fields | Meaning |
|---|---|---|
| `all_of` | `checks` | Every check is true |
| `any_of` | `checks` | At least one is true |
| `not` | `of` | The check is false |
| `ref` | `ref` | Use another named condition |

- **Nested checks need no `id` or `description`.**
- **`ref` chains must not loop.** The loader checks.
- **`not` keeps `unknown` as `unknown`.**

### 14.6 Rejected

| Option | Why rejected |
|---|---|
| CSS or XPath selectors | Break on old web apps. Do not exist on desktop |
| Custom scripts | Unreadable for reviewers. Unsafe |
| LLM judges the screen | Not repeatable. Replay must stay model-free |
| Whole-screen picture compare | A clock or a name change breaks it |

---

## 15. `steps`

### 15.1 Fields

| Field | Meaning | Example |
|---|---|---|
| `id` | Stable name | `click_search` |
| `intent` | One plain sentence | "Search for the member" |
| `action` | What to do | See 15.2 |
| `precondition` | Condition ID, checked before | `member_id_entered` |
| `checkpoint` | Condition ID, checked after | `one_result_row` |
| `outcomes` | Outcome codes possible at this step | `["member_not_found"]` |
| `risk` | `idempotent`, `reversible`, or `irreversible` | `idempotent` |
| `timeout_ms` | Default wait, in milliseconds | `5000` |

- **Array order sets step order.**
- **`intent` explains. It never drives replay.** The recorder copies it from the LLM's reason.
- **`outcomes` limits where each outcome is checked.** "Member not found" cannot match on the confirm screen.
- **Every step has a precondition and a checkpoint.** A `read` step usually reuses its precondition.

### 15.2 Action types

| Type | Fields | Note |
|---|---|---|
| `navigate` | `location` | A path. Desktop: open a window |
| `click` | `target` | |
| `type` | `target`, `value`, `format`? | Clears the field first |
| `select` | `target`, `value` | Picks a dropdown option |
| `set_checked` | `target`, `checked` | Safe to repeat, unlike a toggling click |
| `press` | `key` | Example: `Enter` |
| `read` | `target`, `source`, `output`, `pattern`?, `format`? | Reads a value into an output |

- **`read.source`:** `text` or `value`.
- **`read.pattern`** captures the `*` part. Example: `Account * created`.
- **`type.format` and `read.format`** name a display format from policy. `read.format` is required when the output is a `date`.
- **No `wait` action.** Every step waits for its checkpoint.

### 15.3 Rules

- **One action per step.** Each step then has one clear checkpoint.
- **Straight line only. No branches, no loops.** Surprises go to outcomes or handlers.
- **Conditions by ID only, never inline.** Patches can then fix any condition.
- **Retry limits live in the engine.** `risk` decides whether a retry is allowed at all.
- **Only `idempotent` steps are retried.**

---

## 16. `recovery`

**Job:** say what to do when the one irreversible step fails. Nothing else.

### 16.1 Fields

| Field | Meaning | Required |
|---|---|---|
| `commit_point` | Step ID of the irreversible step | Yes |
| `reconciliation` | A `check` or a `waiver` | Yes |
| `compensated_by` | Link to an undo capability | Optional |

- **The whole block exists only when `effect` is `commits`.**
- **App-wide fixes stay out.** Session timeout belongs in handler packs.

### 16.2 Reconciliation check

| Field | Meaning |
|---|---|
| `capability` | A read-only capability, with major version: `app/name@1` |
| `inputs` | Map from its inputs to our values |
| `not_found_outcomes` | Its outcome codes that mean "the commit did not happen" |
| `outputs` | Map from its outputs to our outputs, using `{result.*}` |

How its result is read:

| Its result | Meaning | Next |
|---|---|---|
| `success` | Found. The commit worked | Return `success` with `effect.commit: found_by_check`, plus mapped outputs |
| A listed outcome | Not found. Nothing happened | A human approves any retry |
| Anything else | Unclear | jev decides; if still unclear, a human |

- **It reads a result status, not screens.** No new matching language is needed.
- **The correlation reference makes matching exact.** A step types `{system.run_id}` into a notes field, where policy allows.

### 16.3 Waiver

- **Holds `reason`:** why the app offers no screen to check.
- **Effect:** every failed commit goes straight to a human.
- **`provenance.decisions` records who approved it.**

### 16.4 `compensated_by`

- **Holds `capability` and `inputs`.** Inputs may use `{output.*}`.
- **Always needs a human yes.** intyy never undoes anything alone.

### 16.5 Links use a major version

- **Example:** `kvfcu/find_account_by_reference@1`.
- **The resolver picks the approved 1.x** for the context.
- **If the linked check is not approved in a context,** the commit capability cannot run unattended there.

### 16.6 Commit states

- **The result reports an `effect` block with a `commit` state** (section 3 §5.8). It replaces the old `effect_uncertain` flag.

| State | Data changed? |
|---|---|
| `not_sent` | No |
| `refused` | No |
| `confirmed` | Yes |
| `uncertain` | Unknown |
| `found_by_check` | Yes |
| `absent_by_check` | No |

- **`uncertain` applies only if the commit action was sent.** "`effect_uncertain`" in prose now means `commit: uncertain`.
- **If the commit step fails its precondition,** nothing was sent: `not_sent`. Stop safely.
- **Why a state, not a flag:** a flag cannot say "failed, but the account opened."

---

## 17. `provenance`

**Job:** show where every part came from, and who approved it.

### 17.1 Parts

| Part | Holds |
|---|---|
| `runs` | Source runs |
| `derived_from` | Previous version, or `null` |
| `actions` | Every raw discovery action and its fate |
| `decisions` | Other human decisions |
| `sealed` | Who sealed it, and when |

### 17.2 `runs`

| Field | Example |
|---|---|
| `run_id` | `run_2026-09-24_7kq2m9x4tb` |
| `kind` | `discovery`, `negative_discovery`, `replay` (patches only), or `certify` (patches only) |
| `goal` | "Open a share sub-account for member {input.member_id}" |
| `expected_outcome` | Negative runs only |
| `model` | `claude-sonnet-5` |
| `recorder_version` | `0.3.0` |

- **Run ID format:** `run_` + date + `_` + 10 lowercase Crockford base32 characters. 25 characters, to fit the bank app's notes field (section 3 §7.2).
- **Goals store input names, not values.**
- **Runs are links.** The raw run stays in the evidence folder.

### 17.3 `actions`

| Field | Meaning |
|---|---|
| `run_id`, `seq` | Which run, which action number |
| `llm_tag` | `flow_step`, `incidental`, `correction`, or `exploration` |
| `human_tag` | The final tag after review |
| `decided_by` | Reviewer staff ID |
| `became` | `step:<id>`, `handler_draft:<id>`, or `dropped` |

- **One entry per raw action.** Nothing disappears without a trace.
- **Section 8 builds tag agreement scores from this data.**

### 17.4 `decisions`

| `what` | Example |
|---|---|
| `risk` | `click_confirm` confirmed `irreversible` |
| `sensitivity` | `account_number` confirmed `financial` |
| `outcome_name` | `member_not_found` named |
| `waiver` | Reconciliation waiver approved |
| `refusal` | `limit_exceeded` on the commit step confirmed `no_change` |
| `edit` | `timeout_ms` on `click_search` changed |
| `patch` | A patch change approved (patch files only) |
| `risk_second_look` | `click_remind_later` lowered from unsure to `idempotent`, confirmed by a second staff ID |

```json
{ "what": "risk_second_look", "subject": "click_remind_later", "value": "idempotent", "by": "op_022", "at": "…" }
```

- **Each entry has `subject`, `value`, `by`, and `at`.**
- **Every risk flag appears here.** A human must confirm each one.
- **Every commit-step outcome appears here as a `refusal`.** Example: `{ "what": "refusal", "subject": "limit_exceeded", "value": "no_change", "by": "op_017", "at": "…" }`.
- **When an outcome was adopted from a pack,** `outcome_name`'s `value` is `pack:<handler_id>`. No new decision kind: adoption is a way of naming an outcome.
- **`risk_second_look` is needed for each `risk` decision** whose value is lower than `irreversible`, where the rules said `irreversible` or unsure.
- **`by` must differ** from the `risk` decision's `by`.
- **Applies to artifacts and packs.** Patches cannot change risk (§18.3).
- **When the second reviewer disagrees with the lowering,** the CLI records a `risk` decision of `irreversible` by that reviewer instead, not a `risk_second_look`. Raising risk never needs two people.

### 17.5 Privacy

- **Reviewer IDs are staff IDs,** never names or emails.
- **No member data anywhere in this block.**

---

## 18. Tenant patch format

> **Changed by section 10:** Schema and loader built; merge designed only. See `intyy-design-updates-from-section-10.md` §5.

### 18.1 What a patch is

- **A small file that changes a few targets or conditions for one bank.**
- **The base artifact stays untouched.** Replay merges both at run start.

### 18.2 Fields

| Field | Meaning | Example |
|---|---|---|
| `schema` | Patch format version | `"intyy.patch/1.0"` |
| `tenant` | Which bank | `lakeshore` |
| `base` | Capability and major version it fits | `kvfcu/open_share_subaccount@1` |
| `revision` | Patch number, counting up | `1` |
| `reason` | Why it exists | "Lakeshore labels Search as Find." |
| `targets` | Changes, keyed by target ID | |
| `conditions` | Changes, keyed by condition ID | |
| `provenance` | Runs, decisions, sealed | Same shape as the artifact's |

- **`revision` is a plain number.** A patch has no caller contract, so semver adds nothing.

### 18.3 What a patch may change

| Part | Allowed | Not allowed |
|---|---|---|
| Target | Any clue, and `within` | `id` |
| Leaf condition | `text`, `value`, `match`, `pattern`, `op` | `id`, `check` |
| Combined condition | Nothing | Everything |
| Everything else | Nothing | Contract, steps, recovery, `runs_on`, `about` |

- **Check type or combination changes are structural.** They need a new base version or a bank-specific artifact.
- **An extra screen at one bank is structural too.** Step insertion in patches is deferred.

### 18.4 Merge rules

- **Listed fields replace base fields.**
- **`null` removes a clue.**
- **Unlisted fields keep base values.**

### 18.5 Rules

- **The active patch in a context is the one in its approved key.** A newer sealed revision starts as draft. It replaces the old one only when certified and approved.
- **Supervised runs may use a newer revision,** by the resolver's rules or an operator pin.
- **Why:** "trust is never inherited" applies to patches too.
- **Candidate, then sealed.** Same lifecycle as artifacts.
- **Approval covers base version plus patch revision.**
- **At run start:** merge, check every ID exists, validate the result, freeze, log.
- **Any check fails, the run stops loudly.**

### 18.6 How a patch comes to exist

1. **Replay logs clue disagreements** even when a clear winner still exists.
2. **Certify shows a low locator margin** at one bank only.
3. **intyy drafts a patch** from the observed values, once a source below crosses its threshold.
4. **A human reviews and seals it.** Replay never edits itself.
5. **Certify runs again** for that bank, with the patch.

**Sources and thresholds:**

| Source | Drafts when |
|---|---|
| A differing clue on a clear winner | Same target, clue, and observed value in 5 runs at one tenant, and in 80% of that target's votes |
| A reviewer `patch_needed` fix | 2 fixes on one step that agree on the new control's name, label, or text |
| A human takeover on target trouble | 2 takeovers where the human clicked matching controls, and the checkpoint then passed |
| A certify batch | The same differing value in every baseline run |

- **Other tenants on the same version must not show it.** Otherwise it is an app version change.
- **Drafts change clues only.** No new crops. No structural change. Condition text is designed only.
- **Source runs go in `provenance.runs`,** kind `replay` or `certify`. Both kinds were already allowed.
- **Build status:** stretch.

### 18.7 Example

```json
{
  "schema": "intyy.patch/1.0",
  "tenant": "lakeshore",
  "base": "kvfcu/open_share_subaccount@1",
  "revision": 1,
  "reason": "Lakeshore labels the Search button 'Find' and moves it left.",
  "targets": {
    "search_button": { "clues": { "name": "Find", "text": "Find", "region": null } }
  },
  "conditions": {
    "no_member_text": { "text": "Member does not exist" }
  },
  "provenance": {
    "runs": [{ "run_id": "run_2026-10-02_c9d1wq5e2k", "kind": "replay" }],
    "decisions": [{ "what": "patch", "subject": "search_button", "value": "rename", "by": "op_022", "at": "2026-10-02T09:15:00Z" }],
    "sealed": { "by": "op_022", "at": "2026-10-02T09:20:00Z" }
  }
}
```

---

## 19. Loader checks

The loader runs these on every artifact and every merged patch. Any failure stops the load.

### 19.1 Format

- `schema` is known and not newer than the loader.
- No unknown fields.
- All IDs are lower snake case and unique within their kind.

### 19.2 References

- Every target, condition, input, output, and outcome reference resolves.
- `ref` chains in conditions do not loop.
- Each namespace appears only where 7.2 allows it.
- `{input.*}` names a declared input. `{system.*}` names a known system value.
- `{secret.*}` fills a whole value, inside a `type` action only.
- A `field_value` check on a target that receives a `{secret.*}` may only use the `*` wildcard. It tests "not empty," never the value.

### 19.3 Outputs and outcomes

- Every output has exactly one `read` step that writes it.
- Every `read` step writes a declared output.
- Every outcome in `contract` appears in at least one step's `outcomes`.
- Every step outcome exists in `contract`.

### 19.4 Risk and recovery

- `effect: commits` means exactly one step has `risk: irreversible`.
- That step's ID equals `recovery.commit_point`.
- `effect: read_only` means no irreversible step and no `recovery` block.
- `recovery.reconciliation` holds exactly one of `check` or `waiver`.
- The reconciliation capability is `read_only`.
- The `compensated_by` capability is `commits`.
- Every outcome on the commit step has a `refusal` decision in `provenance`.
- A lowered `irreversible` flag with no matching `risk_second_look` by another staff ID is a blocking review issue. Sealing fails.

### 19.5 Portability

- `runs_on.entry` and every `navigate.location` start with `/`.
- `runs_on.paths` is present and not empty. Each pattern starts with `/`.
- `runs_on.entry` and every `navigate.location` match a pattern in `runs_on.paths`.
- Every input and output has a sensitivity label.
- Combiners have at least one nested check.

### 19.6 Checks that need the policy

These run at sealing and at pre-run check 9 (section 3 §4.8). The artifact loader alone cannot run them.

- Every `{secret.*}` name is declared in the app's policy layer.
- Every `runs_on.paths` pattern sits inside the effective allowlist.

### 19.7 Session link

- The linked capability is `read_only`, has no inputs and no outputs, and has `session: null`.
- An artifact with `session: null` holds its own login, or needs none.

### 19.8 Formats

- `format` names a format from the global list for that value's type.
- A `read` step for a `date` output has a `format`.

### 19.9 Candidate mode

- A candidate may hold a `recovery` placeholder with no capability. Sealing rejects it.

---

## 20. What stays out of the artifact

| Left out | Lives in | Why |
|---|---|---|
| Approval and scores | Score store | Per context, and they change |
| Tuned timeouts | Score store | Environment facts, per context |
| Tenant changes | Patch files | One base serves many banks |
| App-wide interruptions | Handler packs | Session timeout belongs to the app |
| Clue weights and thresholds | Replay engine | Perception rules, not task facts |
| Secret values | Bank settings | Never written down |
| Bank addresses | Bank settings | Each bank hosts the app elsewhere |
| Raw model transcript | Evidence folder | The brief asks for decoupling |
| Content hash | Store index (`index.jsonl`) | Would be circular inside the file |

---

## 21. Full example

> **Illustrative only.** The screens below are invented. Real artifacts come from the recorder, against the bank app's `CONTRACT.md`.
> **Some clues are omitted for brevity.** `search_button` shows a full fingerprint.

```json
{
  "schema": "intyy.artifact/1.0",

  "identity": {
    "app": "kvfcu",
    "capability": "open_share_subaccount",
    "version": "1.0.0"
  },

  "runs_on": {
    "surface": "web",
    "app_versions": ["8.*"],
    "viewport": { "width": 1280, "height": 800, "scale": 1 },
    "entry": "/login",
    "paths": ["/login", "/home", "/members/search", "/members/*", "/accounts/new"],
    "session": null
  },

  "about": {
    "title": "Open share sub-account",
    "summary": "Opens a share sub-account for a member and returns its number.",
    "when_to_use": "Use when a member asks to open a new share account.",
    "limits": "Does not move money from other banks."
  },

  "contract": {
    "inputs": [
      { "name": "member_id", "type": "string", "description": "The member's ID number",
        "required": true, "sensitivity": "pii",
        "constraints": { "format": "digits", "length": { "min": 5, "max": 8 } } },
      { "name": "deposit", "type": "money", "description": "Opening deposit",
        "required": true, "sensitivity": "financial",
        "constraints": { "range": { "min": "1.00", "max": "10000.00" } } }
    ],
    "outputs": [
      { "name": "account_number", "type": "string",
        "description": "The new account's number", "sensitivity": "financial" }
    ],
    "outcomes": [
      { "code": "member_not_found", "description": "No member has this ID",
        "condition": "no_member_text" }
    ],
    "effect": "commits"
  },

  "targets": [
    { "id": "username_box", "description": "User ID box on the login page",
      "clues": { "role": "textbox", "name": "User ID", "label": "User ID" } },
    { "id": "password_box", "description": "Password box on the login page",
      "clues": { "role": "textbox", "name": "Password", "label": "Password" } },
    { "id": "login_button", "description": "Login button",
      "clues": { "role": "button", "name": "Login", "text": "Login" } },
    { "id": "search_panel", "description": "Member search panel on the home page",
      "clues": { "role": "form", "name": "Member Search" } },
    { "id": "member_id_box", "description": "Member ID box in the search panel",
      "within": "search_panel",
      "clues": { "role": "textbox", "label": "Member ID" } },
    { "id": "search_button", "description": "The Search button in the member panel",
      "within": "search_panel",
      "clues": {
        "role": "button",
        "name": "Search",
        "text": "Search",
        "region": { "x": 0.72, "y": 0.31, "w": 0.08, "h": 0.04 },
        "image": "crops/search_button.png",
        "path": "frame[main] > form > table > tr[2] > td[3] > input"
      } },
    { "id": "results_table", "description": "Search results table",
      "clues": { "role": "table", "name": "Search results" } },
    { "id": "member_row", "description": "The result row for this member",
      "within": "results_table",
      "clues": { "role": "row", "text": "{input.member_id}" } },
    { "id": "open_account_button", "description": "Open New Account button on the member page",
      "clues": { "role": "button", "name": "Open New Account" } },
    { "id": "account_type_list", "description": "Account type dropdown",
      "clues": { "role": "combobox", "label": "Account Type" } },
    { "id": "deposit_box", "description": "Opening deposit box",
      "clues": { "role": "textbox", "label": "Opening Deposit" } },
    { "id": "notes_box", "description": "Remarks box, used for the correlation reference",
      "clues": { "role": "textbox", "label": "Remarks" } },
    { "id": "confirm_button", "description": "Confirm button on the account form",
      "clues": { "role": "button", "name": "Confirm" } },
    { "id": "confirmation_message", "description": "Message that shows the new account number",
      "clues": { "text": "created", "region": { "x": 0.30, "y": 0.20, "w": 0.40, "h": 0.05 } } }
  ],

  "conditions": [
    { "id": "login_page_shown", "check": "all_of", "description": "The login page is showing",
      "checks": [
        { "check": "location", "pattern": "/login" },
        { "check": "element_visible", "target": "username_box" }
      ] },
    { "id": "username_filled", "check": "field_value", "description": "The user ID box is not empty",
      "target": "username_box", "value": "*", "match": "wildcard" },
    { "id": "password_filled", "check": "field_value", "description": "The password box is not empty",
      "target": "password_box", "value": "*", "match": "wildcard" },
    { "id": "home_page_shown", "check": "element_visible", "description": "The member search box is showing",
      "target": "member_id_box" },
    { "id": "member_id_entered", "check": "field_value", "description": "The member ID box holds the input",
      "target": "member_id_box", "value": "{input.member_id}", "match": "exact" },
    { "id": "one_result_row", "check": "count", "description": "The results table has exactly one row",
      "within": "results_table", "item": "row", "op": "equals", "value": 1 },
    { "id": "no_member_text", "check": "text_visible", "description": "The app says no member was found",
      "text": "No member found", "match": "contains" },
    { "id": "member_page_shown", "check": "all_of", "description": "The member's page is showing",
      "checks": [
        { "check": "location", "pattern": "/members/*" },
        { "check": "text_visible", "text": "{input.member_id}", "match": "contains" }
      ] },
    { "id": "account_form_shown", "check": "element_visible", "description": "The new account form is showing",
      "target": "deposit_box" },
    { "id": "savings_selected", "check": "field_value", "description": "Savings is chosen as the account type",
      "target": "account_type_list", "value": "Savings", "match": "exact" },
    { "id": "deposit_entered", "check": "field_value", "description": "The deposit box holds the input",
      "target": "deposit_box", "value": "{input.deposit}", "match": "exact" },
    { "id": "reference_entered", "check": "field_value", "description": "The remarks box holds the run ID",
      "target": "notes_box", "value": "{system.run_id}", "match": "exact" },
    { "id": "form_ready", "check": "all_of", "description": "The form is complete and Confirm is enabled",
      "checks": [
        { "ref": "savings_selected" },
        { "ref": "deposit_entered" },
        { "ref": "reference_entered" },
        { "check": "element_state", "target": "confirm_button", "state": "enabled" }
      ] },
    { "id": "confirmation_shown", "check": "text_visible", "description": "The app confirms the new account",
      "text": "Account * created", "match": "wildcard", "within": "confirmation_message" }
  ],

  "steps": [
    { "id": "type_username", "intent": "Enter the operator user ID",
      "action": { "type": "type", "target": "username_box", "value": "{secret.operator_username}" },
      "precondition": "login_page_shown", "checkpoint": "username_filled",
      "outcomes": [], "risk": "idempotent", "timeout_ms": 5000 },
    { "id": "type_password", "intent": "Enter the operator password",
      "action": { "type": "type", "target": "password_box", "value": "{secret.operator_password}" },
      "precondition": "login_page_shown", "checkpoint": "password_filled",
      "outcomes": [], "risk": "idempotent", "timeout_ms": 5000 },
    { "id": "click_login", "intent": "Log in",
      "action": { "type": "click", "target": "login_button" },
      "precondition": "password_filled", "checkpoint": "home_page_shown",
      "outcomes": [], "risk": "idempotent", "timeout_ms": 8000 },
    { "id": "type_member_id", "intent": "Enter the member ID",
      "action": { "type": "type", "target": "member_id_box", "value": "{input.member_id}" },
      "precondition": "home_page_shown", "checkpoint": "member_id_entered",
      "outcomes": [], "risk": "idempotent", "timeout_ms": 5000 },
    { "id": "click_search", "intent": "Search for the member",
      "action": { "type": "click", "target": "search_button" },
      "precondition": "member_id_entered", "checkpoint": "one_result_row",
      "outcomes": ["member_not_found"], "risk": "idempotent", "timeout_ms": 8000 },
    { "id": "open_member", "intent": "Open the member's page",
      "action": { "type": "click", "target": "member_row" },
      "precondition": "one_result_row", "checkpoint": "member_page_shown",
      "outcomes": [], "risk": "idempotent", "timeout_ms": 8000 },
    { "id": "open_account_form", "intent": "Open the new account form",
      "action": { "type": "click", "target": "open_account_button" },
      "precondition": "member_page_shown", "checkpoint": "account_form_shown",
      "outcomes": [], "risk": "idempotent", "timeout_ms": 8000 },
    { "id": "select_savings", "intent": "Choose the savings account type",
      "action": { "type": "select", "target": "account_type_list", "value": "Savings" },
      "precondition": "account_form_shown", "checkpoint": "savings_selected",
      "outcomes": [], "risk": "idempotent", "timeout_ms": 5000 },
    { "id": "type_deposit", "intent": "Enter the opening deposit",
      "action": { "type": "type", "target": "deposit_box", "value": "{input.deposit}" },
      "precondition": "account_form_shown", "checkpoint": "deposit_entered",
      "outcomes": [], "risk": "idempotent", "timeout_ms": 5000 },
    { "id": "type_reference", "intent": "Write the run ID into Remarks for later matching",
      "action": { "type": "type", "target": "notes_box", "value": "{system.run_id}" },
      "precondition": "account_form_shown", "checkpoint": "reference_entered",
      "outcomes": [], "risk": "idempotent", "timeout_ms": 5000 },
    { "id": "click_confirm", "intent": "Confirm and open the account",
      "action": { "type": "click", "target": "confirm_button" },
      "precondition": "form_ready", "checkpoint": "confirmation_shown",
      "outcomes": [], "risk": "irreversible", "timeout_ms": 15000 },
    { "id": "read_account_number", "intent": "Read the new account number",
      "action": { "type": "read", "target": "confirmation_message", "source": "text",
                  "output": "account_number", "pattern": "Account * created" },
      "precondition": "confirmation_shown", "checkpoint": "confirmation_shown",
      "outcomes": [], "risk": "idempotent", "timeout_ms": 5000 }
  ],

  "recovery": {
    "commit_point": "click_confirm",
    "reconciliation": {
      "check": {
        "capability": "kvfcu/find_account_by_reference@1",
        "inputs": { "member_id": "{input.member_id}", "reference": "{system.run_id}" },
        "not_found_outcomes": ["not_found"],
        "outputs": { "account_number": "{result.account_number}" }
      }
    },
    "compensated_by": {
      "capability": "kvfcu/close_account@1",
      "inputs": { "account_number": "{output.account_number}" }
    }
  },

  "provenance": {
    "runs": [
      { "run_id": "run_2026-09-24_7kq2m9x4tb", "kind": "discovery",
        "goal": "Open a share sub-account for member {input.member_id} with {input.deposit}. Return the new account number.",
        "model": "claude-sonnet-5", "recorder_version": "0.3.0" },
      { "run_id": "run_2026-09-24_3hv8n0pzr6", "kind": "negative_discovery",
        "goal": "Look up member {input.member_id}", "expected_outcome": "member_not_found",
        "model": "claude-sonnet-5", "recorder_version": "0.3.0" }
    ],
    "derived_from": null,
    "actions": [
      { "run_id": "run_2026-09-24_7kq2m9x4tb", "seq": 5, "llm_tag": "flow_step",
        "human_tag": "flow_step", "decided_by": "op_017", "became": "step:click_search" },
      { "run_id": "run_2026-09-24_7kq2m9x4tb", "seq": 6, "llm_tag": "flow_step",
        "human_tag": "incidental", "decided_by": "op_017", "became": "handler_draft:stay_signed_in" },
      { "run_id": "run_2026-09-24_7kq2m9x4tb", "seq": 9, "llm_tag": "exploration",
        "human_tag": "exploration", "decided_by": "op_017", "became": "dropped" }
    ],
    "decisions": [
      { "what": "risk", "subject": "click_confirm", "value": "irreversible",
        "by": "op_017", "at": "2026-09-24T14:02:00Z" },
      { "what": "sensitivity", "subject": "account_number", "value": "financial",
        "by": "op_017", "at": "2026-09-24T14:03:00Z" },
      { "what": "outcome_name", "subject": "no_member_text", "value": "member_not_found",
        "by": "op_017", "at": "2026-09-24T14:05:00Z" }
    ],
    "sealed": { "by": "op_017", "at": "2026-09-24T14:10:00Z" }
  }
}
```

---

## 22. Items parked for other sections

| Item | Section |
|---|---|
| Invocation request fields, including authorization and mode | 3. Resolved: section 3 §4 |
| Result contract, including the "unknown outcome code" rule | 3. Resolved: section 3 §5, §5.14 |
| Where input rejection appears in the result | 3. Resolved: section 3 §5.6, status `rejected` |
| How patch revision, engine version, handler set, and tuned timeouts appear in the run log | 3. Resolved: section 3 §6.5 |
| Masking rules per sensitivity label | 4. Resolved: section 4 §9 |
| Secret binding from bank settings, and injection at act time | 4. Resolved: section 4 §8 |
| Never logging observed values of fields filled with secrets | 3 sets the log rule (section 3 §6.7). Resolved: section 4 §8.6 |
| Allowlist built from each bank's address plus artifact paths | 4. Resolved: section 4 §6, using `runs_on.paths` |
| Handler detectors reuse this condition language | 5. Resolved: section 5 §6.3, §13.2 |
| jev's reconciliation input and output | 5. Resolved: section 5 §10.5 |
| Observation format for the discovery LLM | 6. Resolved: section 6 §8 |
| Recorder rules: condition derivation, target ID reuse, default timeouts, label rules | 6. Resolved: section 6 §14 |
| Whether login steps are shared or repeated per artifact | 6. Resolved: section 6 §5: a session capability |
| Clue weights, win thresholds, and wait and poll rules | 7. Resolved: section 7 §5, §6 |
| Retry limits for idempotent steps | 7. Resolved: section 7 §8 |
| Which session runs the reconciliation check after a failed commit | 7. Resolved: section 7 §11.1: a fresh session |
| Score store key, now including `patch_revision` | 8. Resolved: section 8 §5.1 |
| Threshold for drafting a patch from clue disagreements | 8. Resolved: section 8 §13.4 |
| Resolver rules for version and patch selection | 8. Resolved: section 8 §11 |
| CLI commands for candidate edits and sealing | 9. Resolved: section 9 §8.2 |

---

## 23. Terms used in this section

| Term | Meaning |
|---|---|
| Artifact (capability) | The saved recipe for one task |
| Block | One top-level part of the artifact file |
| Candidate | A draft artifact a human can still change |
| Sealed | Frozen. No edits allowed |
| Immutable | Cannot change |
| Content hash | A short fingerprint of a file's content |
| Semver | Three-part version: major.minor.patch |
| Context | One tenant plus one app version |
| Tenant | One customer bank |
| Tenant patch | A small file that changes a few targets or conditions for one bank |
| Revision | A patch's version number |
| Resolver | Picks the right artifact version and patch for a context |
| Score store | Files that hold scores, approval, and tuned timeouts per context |
| Default timeout | The recorder's wait value, stored in the artifact |
| Tuned timeout | The measured wait value per context, stored in the score store |
| Target | One named control, with its fingerprint |
| Fingerprint | Many clues that identify one control |
| Clue | One fact about a control: role, name, label, text, region, image, or path |
| Accessibility tree | The list of controls that screen readers use |
| Condition | A named rule about what the screen shows |
| Precondition | A condition checked before a step |
| Checkpoint | A condition checked after a step |
| Business outcome | A real answer that is not success. Example: member not found |
| Effect | Whether a capability only reads, or commits a change |
| Commit point | The one irreversible step |
| Reconciliation check | A read-only look to learn if the commit worked |
| Waiver | A written reason why no reconciliation check exists |
| Compensation | An undo capability, run only with a human yes |
| Commit state | Whether the irreversible action went out, and what is known about it. Six values, in 16.6 |
| `effect_uncertain` | Commit state `uncertain`: the commit action was sent, but nobody knows yet if it took effect |
| Refusal | An outcome on the commit step: the app said no, and nothing changed |
| Correlation reference | The run ID written into the app, so matching is exact |
| Negative discovery run | Discovery with a bad input, to capture a business outcome |
| Provenance | Where the artifact came from, and who approved which parts |
| Wildcard | `*`, meaning one or more of any character |
| Loader | Code that reads a file and checks it against the schema |
