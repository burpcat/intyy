# intyy report

intyy gives AI agents hands in bank back-office apps that have no API. The full design is in [docs/design/](docs/design/). Every evidence ID below (A1 to A12, B1 to B5) is a row in [evidence/README.md](evidence/README.md).

> DRAFT (M12). The owner edits and owns every claim. A line marked `TODO(owner)` waits for an M10 evidence run.

## 1. Architecture

**One CLI process and plain files.** There is no server, queue, or database. The brief warns against scaling infrastructure. The trade-off is one machine and file locks. A service host is designed as the next step ([build plan §17](docs/design/10-intyy-build-plan.md)).

**Ports and adapters.** The core talks to the world only through ports. One file, `src/cli/wiring.ts`, picks the adapters. Each port has a fake twin, so CI runs with no model, no key, and no bank app ([section 9 §2, §5](docs/design/9-intyy-interfaces.md)).

**The action gate holds the only hands.** Only the gate, the Playwright adapter, and the fakes may import the hands port. Every browser action crosses the gate by construction, not by discipline. `tests/structure/imports.test.ts` proves it.

**The model discovers, plain code records, replay decides nothing.** These are three modules: `src/core/discovery/`, `src/core/recorder/`, and `src/core/replay/`. On replay, a model appears only on ladder rungs 2 and 3, to sort or clear trouble on one step. It never picks the next step.

**Library, state, evidence.** Reviewed files live in `library/`, in git. Runtime files live in `state/`, never in git. Chosen runs are published to `evidence/` after a canary scan.

**Tools.** TypeScript in strict mode, so the schemas and the compiler agree. Playwright as a library, for a visible browser a person can take over. Claude Sonnet 5 for discovery and the rung 3 reviewer. TypeSafe jev, pinned to `jev-1.13.0`, sorts a stuck screen on rung 2 into typed labels with probabilities.

See [section 1 §4, §15](docs/design/1-intyy-component-level-design.md).

## 2. Artifact schema

**The promise is separate from the recipe.** The contract is what a calling agent sees: typed inputs, outputs, outcomes, and the effect. The steps say how. A caller reads the first and never needs the second. From the sealed [`open_share_subaccount@1.0.3`](library/artifacts/kvfcu/open_share_subaccount/1.0.3/artifact.json):

```
inputs:   member_id  string, pii, 6 digits      deposit  money, financial, min 0.01
outputs:  account_number  string, pii
outcomes: member_not_found   limit_exceeded
effect:   commits
```

**Each block is said once.** Steps refer to targets and conditions by name.

**Targets carry many clues, not one selector:** role, name, label, region, picture, and path. Clues vote with fixed weights and thresholds. A missing clue leaves the vote. A different clue votes against.

**Conditions answer true, false, or unknown.** Only true passes.

**Recovery names the commit point** and links a read-only check by major version. After a lost reply, intyy runs that check and never repeats the commit. A waiver is accepted only when it cites the discovery run that found no screen to read the result. `1.0.3` carries such a waiver (A2): kvfcu's member page lists sub-accounts with no count to read.

**Semver follows what the caller sees.** A caller names a major, such as `@1`. The resolver picks the rest.

**Approval and tuned timeouts live outside the artifact.** A sealed file never changes. `capability describe --format tool` exports it as a tool definition.

See [section 2 §3, §4, §12 to §17](docs/design/2-intyy-artifact-schema.md). Proof: A4.

## 3. Determinism & error handling

**Wait for state, never for time.** Steps wait on a condition. After an action, an outcome race watches for the checkpoint and the declared outcomes. The first to appear wins.

**Three kinds of trouble stay apart.** A *business outcome* is a normal answer, such as `member_not_found`. A *recoverable condition* has a handler, such as an expired session. A *hard failure* has neither. `rejected` means refused before any action; `escalated` means a person must act. **A business outcome exits 2, not 0,** so a script that ignores it cannot read "no such member" as success.

**The error ladder.** Rung 1 is plain code: declared outcomes and handler packs. Rung 2 is jev, which only sorts. Rung 3 is the reviewer, bounded to one step and checked by the gate. Rung 4 is a person.

**The commit point is write-ahead, never retried, forward only.** intyy flushes `commit_intent` before the click. If that write fails, nothing is sent. A lost reply goes to the check, or, with a cited waiver, straight to a person with commit `uncertain`. **Only plain code may say "nothing changed".** A model never reports `refused` or `absent`.

Fault paths from `docs/design/CONTRACT.md` §6, on the live bank app:

| Fault | Result | Evidence |
|---|---|---|
| Member does not exist | `business_outcome`, `member_not_found`, exit 2 | A6 |
| Member at the sub-account limit | `business_outcome`, commit `refused` | A7 |
| Reply to Confirm lost | `escalated`, `reconciliation_waived`, commit `uncertain`: a person decides | A8 |
| Session expires mid-run | `success`, recovered by the `sign_in` handler | A9 |
| Restricted user | `failed`, `permission_denied` | A10 |
| Unknown pop-up | `success`: jev said `needs_review`; the reviewer closed the notice | B2 |

See [section 3 §5](docs/design/3-intyy-run-outputs.md), [section 5 §8, §14](docs/design/5-intyy-handler-packs-and-error-ladder.md), [section 7 §5, §6, §11](docs/design/7-intyy-replay-engine-and-handoff.md).

## 4. Heterogeneity & multi-tenant

**The seam is the surface port: eyes and hands.** Legacy web uses the Playwright adapter. A desktop app needs a new adapter over the OS accessibility tree; it is designed, not built. With no tree, region and picture clues must carry the vote.

**That last case has a real limit (B1).** With semantics stripped, kvfcu's Search button becomes a bare 72 px image. intyy masks every image over 64 px, since it may show a cheque or a signature, so it never crops it and the picture clue cannot vote. The run does not guess: the gate blocks the reviewer's click on the unknown control, and the run escalates `unsafe_state`. We kept the privacy rule.

**Artifacts hold paths, not addresses.** Bank settings supply each bank's origin.

**One base artifact per vendor app, plus small tenant patches.** A patch changes clues and condition values only. The format and its checks are built (`src/core/model/patch.ts`); the merge is designed. **One patch on the session capability** fixes login differences for every capability at that bank. **Handler packs at vendor scope** help every tenant at once.

**Trust is per context:** tenant, app version, and patch. Live scores demote a key that starts to fail.

**Limits.** Patches are not merged. Only `keystone` has settings and test data; the lakeshore probe (B5) was cut.

See [section 1 §14](docs/design/1-intyy-component-level-design.md), [section 2 §18](docs/design/2-intyy-artifact-schema.md), [section 8 §5.1](docs/design/8-intyy-trust-and-versions.md).

## 5. Escalation & handoff

**"Stuck" is a ladder result, not a timer:** `stuck`, `unsafe_state`, or `needs_human_handler`. A takeover also starts when a person touches the browser while the bot drives.

**The request carries context:** the step, the trouble, the ladder lines, a masked screenshot, and the commit state.

**One driver at a time.** The control lease is `bot`, `human`, or `nobody`. The gate refuses bot actions unless the bot holds the lease.

**Same live session.** The browser is visible. The person works in the session the bot used.

**Files are the operator surface.** A `mailbox/` folder in the run holds the request, claim, and release. A second terminal runs `intyy operator list | claim | release`. The first claimer wins; a second exits 6. The mailbox is also the evidence.

**The person's work is checked like the bot's.** Capture runs through redaction. On handback, forward search finds the resume step, and no step before a sent commit is retried.

**Result (A11).** A supervisor approval mid-task: `success`, one intervention, six captured human actions, then the bot sent the commit itself, `confirmed`.

**Limits.** There is no remote console; it is designed ([section 7 §19](docs/design/7-intyy-replay-engine-and-handoff.md)). A person's clicks are outside the action gate; the network guard still holds.

See [section 7 §12 to §16](docs/design/7-intyy-replay-engine-and-handoff.md), [section 9 §10.4](docs/design/9-intyy-interfaces.md).

## 6. Safety

**Deny by default.** Three policy layers (global, app, tenant) combine. Lower layers only tighten; a file that loosens fails to load.

**Two locks.** The action gate checks every action. The network guard, in the adapter, checks every request.

**Unsure means irreversible.** An irreversible action needs authorization or a person's yes, and is never retried. B1 shows it: an unidentified control stayed unclicked.

**Secrets by reference.** Settings bind a name to an environment variable. The value never reaches an artifact, a log, a prompt, or the command line.

**Redaction at write time.** Only `src/core/safety/redaction/` creates `Masked` values; the compiler enforces it.

**Canary tests.** A reserved member and every bound secret must never reach disk. `evidence publish` scans in memory and refuses on one hit. A12: 422 safety and canary tests pass, with one known limit marked expected.

**Limits, all four.**

- One person played every staff role. Identity is self-declared.
- A name inside a free sentence can slip past redaction. A test tracks it, marked expected.
- The build trusts the caller's authorization. Signed tokens are designed.
- A person's clicks during a takeover are outside the action gate.

See [section 4 §2, §3, §6, §7, §9, §15](docs/design/4-intyy-safety-policy.md).

## 7. Cuts

**Stretch goals claimed: two.** Confidence and approval: a scorer, a gate, trust states, and four-eyes `trust approve`; unattended replay is rejected until a key is approved (B4). Multi-run stability: entropy levels, seeds, and twin runs in each full batch (B3). TODO(owner): keep each claim only once B3 and B4 are published.

**The rung 3 overlap.** The reviewer on rung 3 is close to "assisted fallback". It is part of the ladder, bounded to one step, checked by the gate, and not claimed.

**Built but not claimed.** Drift alerts, major-version records, pack regression batches, and reconciliation autonomy. They have no live evidence.

**Cut** ([build plan §12](docs/design/10-intyy-build-plan.md)). The lakeshore probe. `clue_drift`, which needs patch drafting. A CI job against the bank app: it lives outside this repo, so live tests run locally.

**Designed, not built.** Service host, remote console, desktop adapter, patch merge and drafting, vision-driven discovery, signed authorization.

**Next, with more time.**

1. A rows read capability for kvfcu, so a lost reply is settled by a check, not a person.
2. Patch merge, so one artifact serves many tenants.
3. A desktop adapter behind the same surface port.
