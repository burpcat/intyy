# intyy report

intyy gives AI agents hands in bank back-office apps that have no API. The full design is in [docs/design/](docs/design/).

> DRAFT (M12). The owner edits and owns every claim. A line marked `TODO(owner)` waits for an evidence run. The status of each evidence item is in [evidence/README.md](evidence/README.md).

## 1. Architecture

**One CLI process and plain files.** There is no server, queue, or database. The brief warns against scaling infrastructure. A designed service host is the next step ([build plan §17](docs/design/10-intyy-build-plan.md)). The trade-off is one machine and file locks. That is fine for a build.

**Ports and adapters.** The core talks to the world only through ports (interfaces). One file, `src/cli/wiring.ts`, picks the adapters. Each port has a fake twin, so CI runs with no model and no key ([section 9 §2, §5](docs/design/9-intyy-interfaces.md)).

**The action gate holds the only hands.** Only `src/core/safety/gate/`, the Playwright adapter, and the fakes may import the hands port. Every browser action crosses the gate by construction, not by discipline. Proof: `tests/structure/imports.test.ts`.

**The model discovers, plain code records, replay decides nothing.** These are three modules: `src/core/discovery/`, `src/core/recorder/`, and `src/core/replay/`. A model appears on replay only on ladder rungs 2 and 3, and only to sort trouble. It never picks the next step.

**Library, state, evidence.** Reviewed files live in `library/`, in git. Runtime files live in `state/`, never in git. Chosen runs publish to `evidence/`.

**Tools.** TypeScript in strict mode, so the schemas and the compiler agree. Playwright as a library, for a visible browser. Claude Sonnet 5 for discovery and for the rung 3 reviewer. TypeSafe Jev, pinned to `jev-1.13.0`, sorts screens on rung 2: it returns typed labels with probabilities, fast and cheap ([decisions.md](docs/decisions.md), M09).

See [section 1 §4, §15](docs/design/1-intyy-component-level-design.md).

## 2. Artifact schema

**The promise is separate from the recipe.** The contract is what a calling agent sees: typed inputs, outputs, outcomes, and the effect. The steps are how the task is done. A caller reads the first and never needs the second.

**Targets carry many clues, not one selector.** A control has a role, a name, a label, a region, a picture, and more. Clues vote with fixed thresholds. A button that loses its name can still win on its region and picture (B1).

**Conditions answer true, false, or unknown.** Only true passes. Unknown never passes quietly.

**Recovery names the commit point** and links a read-only check capability by major version. After a lost reply, intyy runs that check. It never repeats the commit. The check is required. A waiver is allowed only when it cites the discovery run that found no screen to read the result.

**Semver follows what the caller sees.** A caller names a major version, such as `@1`. The resolver picks the rest.

**Approval and tuned timeouts live outside the artifact.** A sealed file never changes. Changes go through the CLI as new revisions.

**The artifact exports a tool definition.** `intyy capability describe <key> --format tool` prints `{name, description, input_schema}` for an agent.

```
TODO(owner): paste the contract block of the sealed kvfcu/open_share_subaccount@1.0.0 here,
and link the full file.
```

See [section 2 §3, §4, §12 to §17](docs/design/2-intyy-artifact-schema.md). Proof: A4.

## 3. Determinism & error handling

**Wait for state, never for time.** Steps wait on a condition. After a commit, an outcome race watches the screen for the declared outcomes and the checkpoint. The first one to appear wins.

**Three kinds of trouble stay apart in the result.** A *business outcome* is a normal answer from the bank, such as `member_not_found`. A *recoverable condition* has a handler, such as an expired session. A *hard failure* has neither. Two more results exist: `rejected` (refused before any action) and `escalated` (a human must act).

**A business outcome exits 2, not 0.** A script that ignores it would treat "no such member" as success ([section 9 §7.5](docs/design/9-intyy-interfaces.md)).

**The error ladder.** Rung 1 is plain code: declared outcomes and handler packs. Rung 2 is jev, which only sorts the screen into a known label. Rung 3 is the reviewer, bounded to one step and checked by the gate. Rung 4 is a human.

**The commit point is write-ahead, never retried, forward only.** intyy writes and flushes `commit_intent` before the click. If that write fails, it sends nothing. After the click, a lost reply goes to the read-only check in a fresh session.

**The check is bank-agnostic.** A bank app may give no reference to match a run, as with kvfcu, which shows no notes. Then the check counts instead: it reads a count before the run and again after the lost reply. One more means found. The same means absent. Anything else goes to a human. The trade-off: a count returns no outputs, and a change by another teller in the same minute would mislead it ([decisions.md](docs/decisions.md), M05).

**Only plain code may say "nothing changed".** A model never reports `refused` or `absent`.

**UI drift is secondary.** A missing clue leaves the vote. A different clue votes against.

Fault paths from `docs/design/CONTRACT.md` §6:

| Fault | How it should end | Result | Evidence |
|---|---|---|---|
| Member does not exist | `business_outcome`, `member_not_found`, exit 2 | TODO(owner) | A6 |
| Member at the sub-account limit | `business_outcome`, commit `refused` | TODO(owner) | A7 |
| Reply to Confirm lost | commit `found_by_check`, outputs unavailable | TODO(owner) | A8 |
| Session expires mid-run | `success`, one recovery by the `sign_in` handler | TODO(owner) | A9 |
| Restricted user | `failed`, `permission_denied` | TODO(owner) | A10 |

See [section 3 §5](docs/design/3-intyy-run-outputs.md), [section 5 §8, §14](docs/design/5-intyy-handler-packs-and-error-ladder.md), [section 7 §5, §6, §11](docs/design/7-intyy-replay-engine-and-handoff.md).

## 4. Heterogeneity & multi-tenant

**The seam is the surface port: eyes and hands.** Legacy web uses the Playwright adapter. A desktop app needs a new adapter over the operating system's accessibility tree. That adapter is designed, not built. With no tree at all, region and picture clues carry the vote. The strip-semantics drill tests that case (B1).

**Artifacts hold paths, not addresses.** Bank settings supply each bank's origin. One artifact can serve two banks that host the same app at different addresses.

**One base artifact per vendor app, plus small tenant patches.** A patch changes clues and condition values only. The patch format and its checks are built (`src/core/model/patch.ts`). The merge is designed, not built.

**One patch on the session capability fixes login differences** for every capability at that bank. **Handler packs at vendor scope** help every tenant at once.

**Trust is per context:** tenant, app version, and patch. Live scores demote a key that starts to fail. The drift reader ties a drop to a pack, engine, or jev change.

**Limits.** Patches are not merged. An extra screen at one bank needs its own artifact version. Only one tenant, `keystone`, has settings and test data. TODO(owner): state whether the lakeshore probe (B5) ran.

See [section 1 §14](docs/design/1-intyy-component-level-design.md), [section 2 §18](docs/design/2-intyy-artifact-schema.md), [section 8 §5.1](docs/design/8-intyy-trust-and-versions.md).

## 5. Escalation & handoff

**"Stuck" is a ladder result, not a timer.** The reasons are `stuck`, `unsafe_state`, and `needs_human_handler`. A takeover also starts when a person touches the browser while the bot drives.

**The request carries context:** the step, the trouble, the ladder lines, a masked screenshot, and the commit state.

**One driver at a time.** The control lease is `bot`, `human`, or `nobody`. The gate refuses bot actions unless the bot holds the lease. Human input while the bot drives moves the lease to `nobody` at once.

**Same live session.** The browser is visible. The human works in the session the bot used.

**Files are the operator surface.** A `mailbox/` folder in the run folder holds the request, the claim, and the release. A second terminal runs `intyy operator list | claim | release`. The first claimer wins. A second claimer exits 6. The mailbox is also the evidence.

**The human's work is checked like the bot's.** Capture runs through redaction. Watchers read the commit's checkpoint while a human drives. On handback, forward search finds the resume step, and no step is retried across the commit.

**Result.** TODO(owner): result of A11. Expected: `success`, commit `confirmed`, one intervention.

**Limits.** There is no remote console; it is designed ([section 7 §19](docs/design/7-intyy-replay-engine-and-handoff.md)). The adapter does not report a human's address-bar navigation. A human's clicks are outside the action gate. The network guard still holds.

See [section 7 §12 to §16](docs/design/7-intyy-replay-engine-and-handoff.md), [section 9 §10.4](docs/design/9-intyy-interfaces.md).

## 6. Safety

**Deny by default.** Three policy layers (global, app, tenant) combine. Lower layers only tighten. A file that loosens fails to load.

**Two locks.** The action gate checks every action. The network guard, in the adapter, checks every request.

**Unsure means irreversible.** An irreversible action needs authorization or a human yes, and is never retried.

**Secrets by reference.** Settings bind a name, such as `operator_password`, to an environment variable. The value never reaches an artifact, a log, a prompt, or the command line. Inputs come from files or standard input.

**Redaction at write time.** Only `src/core/safety/redaction/` creates `Masked` values, and the compiler enforces it.

**Canary tests.** A reserved member number and every bound secret must never reach disk. `intyy evidence publish` scans in memory and refuses on one hit. TODO(owner): A12, `evidence/tests/safety.json`.

**Limits, all four.**

- One person played every staff role. Identity is self-declared ([build plan §11.4](docs/design/10-intyy-build-plan.md)).
- A name inside a free sentence can slip past redaction. A test tracks it, marked as expected: `tests/unit/safety/redaction.test.ts`, "known limit".
- The build trusts the caller's authorization. Signed tokens are designed.
- A human's clicks during a takeover are outside the action gate.

See [section 4 §2, §3, §6, §7, §9, §15](docs/design/4-intyy-safety-policy.md).

## 7. Cuts

**Stretch goals claimed: two.** Confidence and approval: a scorer, a six-rule gate, trust states, and `trust approve`. Unattended replay stays rejected until a key is approved (B4). Multi-run stability: stability levels, seeds, and twin runs in a full batch (B3). TODO(owner): keep each claim only if its evidence is published.

**The rung 3 overlap.** The reviewer on rung 3 is close to "assisted fallback". It is part of the ladder, bounded to one step, and checked by the gate. It is not claimed as a stretch goal.

**Built but not claimed.** Drift alerts, major-version records, pack regression batches, and reconciliation autonomy. They have no real evidence.

**Cut** ([build plan §12](docs/design/10-intyy-build-plan.md)). The lakeshore probe. `clue_drift`, which needs patch drafting. A CI job against the bank app: the app lives outside this repo, so live tests run locally. A rows diff for the reconciliation check, which would return outputs.

**Designed, not built.** Service host, remote operator console, desktop adapter, patch merge and drafting, vision-driven discovery, signed authorization.

**Next, with more time.**

1. Patch merge, so one artifact serves many tenants with small overrides.
2. A rows diff check, so a found commit returns its outputs.
3. A desktop adapter behind the same surface port.
