# REPORT outline

> **For:** the agent, drafting `/REPORT.md` in M07 and finishing it in M12. The owner edits and owns every claim.
> **Brief §6 asks for:** about 1 to 3 pages, with seven headings, exactly. Reviewers read many side by side.
> **Target:** about 1,700 words. Under 3 pages.
> **Job:** argue decisions and trade-offs. Details stay in `docs/design/`, linked by section.

---

## Rules for the whole REPORT

- **Use the seven headings below, exactly, in this order.** No extra top-level headings.
- **Each point is a decision, a reason, and a trade-off.** Not a feature list.
- **Every claim links to proof:** code, a design section, or an evidence item (build plan §11).
- **State limits plainly.** Hiding one looks worse than naming it.
- **Simplified Technical English:** short sentences, one idea each, active voice, plain words.
- **No framework name-dropping.** Name a tool only where the choice matters (brief §7).
- **A single line under the title** is allowed: what intyy is, and where the design lives.

---

## 1. Architecture

**Budget:** about 230 words.

**Argue these decisions:**

- **One CLI process and plain files.** No server, queue, or database. The brief warns against building scaling infrastructure. Name the designed service host as the next step.
- **Ports and adapters.** The core sees ports only. Adapters are picked in one place. Fake twins let CI run with no model and no key.
- **The gate holds the only hands.** Every action crosses it by construction, not by discipline. A structure test proves it.
- **Model discovers, plain code records, replay decides nothing.** The through-line of the brief, as three modules.
- **Library, state, evidence.** Reviewed files in git; runtime files out of git; chosen evidence published.
- **Tools:** TypeScript and Playwright as a library; Claude Sonnet 5 for discovery. One line each on why.

**Trade-off to state:** one machine, file locks. Fine for a build; a lock service is designed.

**Refs:** section 1 §4, §15; section 9 §2, §5, §6. **Proof:** `tests/structure/`, A12.

## 2. Artifact schema

**Budget:** about 280 words.

**Argue these decisions:**

- **The promise is separate from the recipe.** The contract (typed inputs, outputs, outcomes, effect) is what a calling agent sees. Steps are how.
- **Ten blocks, each said once.** Steps refer to targets and conditions by name.
- **Targets carry many clues,** not one selector. Show why: a stripped button can still win.
- **Conditions answer true, false, or unknown.** Only true passes.
- **Recovery names the commit point** and links a read-only check capability by major version.
- **Semver follows what the caller sees.** Callers name a major; the resolver picks the rest.
- **Approval and tuned timeouts live outside the artifact.** A sealed file never changes.
- **The artifact exports a tool definition** (`capability describe --format tool`). Built as tooling, not claimed as a stretch goal.

**Show:** one short excerpt of the real `open_share_subaccount@1.0.0` contract block. Link the full file.

**Refs:** section 2 §3, §4, §12 to §17. **Proof:** A4.

## 3. Determinism & error handling

**Budget:** about 320 words. The longest section: the brief weighs it highly.

**Argue these decisions:**

- **Wait for state, never for time.** Condition waits and the outcome race.
- **Clues vote with fixed thresholds** in the engine. The engine version is logged per run.
- **Three kinds of trouble, kept apart in the result:** business outcome, recoverable condition, hard failure. Plus `rejected` and `escalated`. A business outcome exits 2, not 0, and say why.
- **The error ladder:** declared outcomes and handlers first, plain code only; then models, bounded; then a human.
- **The commit point:** write-ahead, never retry, forward only. A lost reply goes to a read-only check in a fresh session.
- **Only plain code may say "nothing changed".**
- **UI drift, secondarily:** missing clues leave the vote; different clues vote against.

**Show:** a short table: fault from `CONTRACT.md` §6, how it ended, evidence link. Rows for A6, A7, A8, A9, A10.

**Refs:** section 3 §5; section 5 §8, §14; section 7 §5, §6, §11; section 1 §19. **Proof:** A5 to A10, B1.

## 4. Heterogeneity & multi-tenant

**Budget:** about 240 words.

**Argue these decisions:**

- **The seam is the surface port:** eyes and hands. Legacy web uses the same adapter. Desktop is a new adapter over OS accessibility trees. No tree at all: region and image clues carry the vote.
- **Artifacts hold paths, not addresses.** Bank settings supply each bank's origin.
- **One base artifact per vendor app, plus small tenant patches.** Patches change clues and condition values only. The format and loader are built; merge is designed.
- **One patch on the session capability** fixes login differences for every capability at that bank.
- **Handler packs at vendor scope** help every tenant at once.
- **Trust is per context:** tenant, app version, patch. Drift shows who broke and why.

**Limits to state:** patches are not merged in the build. An extra screen at one bank needs its own artifact version.

**Refs:** section 1 §14; section 2 §18; section 9 §5.2; section 8 §5.1. **Proof:** B1; B5 if run.

## 5. Escalation & handoff

**Budget:** about 230 words.

**Argue these decisions:**

- **"Stuck" is a ladder result,** not a timer: `stuck`, `unsafe_state`, `needs_human_handler`.
- **The request carries context:** step, trouble, ladder lines, masked screenshot, commit state.
- **One driver at a time.** The lease is `bot`, `human`, or `nobody`. Bot actions are refused unless it holds the lease.
- **Same live session.** The browser is visible; the human works in it.
- **Files as the operator surface.** A mailbox in the run folder, exclusive claims, a second terminal. It is also the evidence.
- **The human's work is checked like the bot's.** Capture through redaction, watchers on the commit, reverify with forward search.

**Limits to state:** no remote console; it is designed. A human's clicks cannot be blocked by the action gate; the network guard still holds.

**Refs:** section 7 §12 to §16, §20; section 9 §10.4, §10.5. **Proof:** A11.

## 6. Safety

**Budget:** about 220 words.

**Argue these decisions:**

- **Deny by default.** Three policy layers; lower layers only tighten; a loosening file fails to load.
- **Two locks:** the action gate, and the network guard in the adapter.
- **Unsure means irreversible.** Irreversible needs authorization or a human yes, and is never retried.
- **Secrets by reference.** Settings bind names to variables. Values never reach artifacts, logs, prompts, or the command line.
- **Redaction at write time,** and a `Masked` type the compiler enforces.
- **Canary tests** prove secrets and a reserved member never reach disk.

**Limits to state, all four:**

- One person played every staff role. Identity is self-declared in the build.
- A name inside a free sentence can slip past redaction. A test tracks it, marked expected.
- The build trusts the caller's authorization. Signed tokens are designed.
- A human's clicks during a takeover are outside the action gate.

**Refs:** section 4 §2, §3, §6, §7, §9, §15. **Proof:** A10, A12.

## 7. Cuts

**Budget:** about 180 words.

**Cover, in this order:**

- **Stretch goals claimed: two.** Confidence and approval; multi-run stability. Claim only what was built.
- **The rung 3 overlap, named plainly.** The reviewer on rung 3 is close to "assisted fallback". It is part of the ladder, bounded to one step, and not claimed.
- **Cut, from build plan §12:** the items not built, in cut order, one line each.
- **Designed, not built:** service host, remote console, desktop adapter, patch merge and drafting, vision discovery, signed authorization.
- **Next, with more time:** three items at most, in priority order.

**Refs:** build plan §7.4, §12, §17.

---

## Checks before the REPORT is done

- [ ] Seven headings, exact wording, in order.
- [ ] Under 3 pages. About 1,700 words.
- [ ] Every claim links to code, a design section, or an evidence item.
- [ ] Every limit above is stated.
- [ ] The stretch goals claimed match what was built.
- [ ] No real credential, key, or member value. No `100240`.
- [ ] The owner can defend every sentence (brief §9).
