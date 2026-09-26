# intyy — design updates from section 10

> **Status:** complete, 25 Sep 2026.
> **Changes:** sections 1 to 9. Source: `10-intyy-build-plan.md`.
> **Precedence:** this file wins over the sections it changes. Then each topic's own section. Then section 1.
> **How it lands:** milestone M00 applies §2 and §3 by script (`npm run docs:renames`), inserts the pointer notes in §14, and checks with `npm run docs:verify`. Everything else stays here, and the pointer notes lead readers to it.

---

## Contents

1. [Earlier update files](#1-earlier-update-files)
2. [Renames in every section](#2-renames-in-every-section)
3. [US examples in redaction and elsewhere](#3-us-examples-in-redaction-and-elsewhere)
4. [Section 1](#4-section-1)
5. [Section 2](#5-section-2)
6. [Section 3](#6-section-3)
7. [Section 4](#7-section-4)
8. [Section 5](#8-section-5)
9. [Section 6](#9-section-6)
10. [Section 7](#10-section-7)
11. [Section 8](#11-section-8)
12. [Section 9](#12-section-9)
13. [Request to the bank app's owner](#13-request-to-the-bank-apps-owner)
14. [Pointer notes for the M00 script](#14-pointer-notes-for-the-m00-script)
15. [Rules for the rename script](#15-rules-for-the-rename-script)

---

## 1. Earlier update files

- **The update files from sections 4 to 9 are already folded in.** Each section header says "amended in place". Section 1 §21 to §27 list the changes.
- **Do not give them to the coding agent.** They are history. The sections are current.

---

## 2. Renames in every section

**Apply in this order,** longest match first. Each row is an exact, case-sensitive string replacement across sections 1 to 9.

| # | Old | New |
|---|---|---|
| 1 | `intyy-section-2-artifact-schema.md` | `2-intyy-artifact-schema.md` |
| 2 | `intyy-context.md` | `1-intyy-component-level-design.md` |
| 3 | `bank-app-handoff.md` | `CONTRACT.md` |
| 4 | `INTYY_BANK_A_SPARROW_CORE_` | `INTYY_KEYSTONE_KVFCU_` |
| 5 | `INTYY_BANK_A_` | `INTYY_KEYSTONE_` |
| 6 | `sparrow.bank-a.example` | `kvfcu.keystone.example` |
| 7 | `bank-a.example` | `keystone.example` |
| 8 | `sparrow-core/open_savings_subaccount` | `kvfcu/open_share_subaccount` |
| 9 | `open_savings_subaccount` | `open_share_subaccount` |
| 10 | `sparrow-core` | `kvfcu` |
| 11 | `bank_a` | `keystone` |
| 12 | `bank_b` | `lakeshore` |
| 13 | `Bank A` | `Keystone` |
| 14 | `bank A` | `keystone` |
| 15 | `Bank B` | `Lakeshore` |
| 16 | `bank B` | `lakeshore` |
| 17 | `{secret.operator_login}` | `{secret.operator_username}` |
| 18 | `10234` | `100107` |
| 19 | `Open savings sub-account` | `Open share sub-account` |
| 20 | `savings sub-account` | `share sub-account` |
| 21 | `new savings account` | `new share account` |

- **Why `100107`:** it is the first valid seed member in CONTRACT §5, with room for sub-accounts.
- **Why "share":** credit unions call savings accounts "shares". The capability is already `open_share_subaccount` in sections 5 to 9.
- **Lines that talk about the placeholders themselves stay as they are.** The script skips any line containing the word "placeholder" (§15).

---

## 3. US examples in redaction and elsewhere

The bank app is a US credit union (CONTRACT). The redaction design used Indian examples. These edits make them US.

### 3.1 Redaction kinds and detectors (section 4 §9)

| Where | Change |
|---|---|
| §4.7 global example, `redaction.detectors` | `["ssn", "card", "aadhaar", "pan", "email", "phone", "money"]` becomes `["ssn", "card", "email", "phone", "money"]` |
| §9.4 kinds table | Delete the `aadhaar` and `pan` rows. The `ssn` row's "Found by" becomes "Detector, label rule" |
| §9.4 note under the table | Becomes: "**SSN** is the US Social Security number. The `ssn` detector also matches ITINs, which share its shape." |
| §9.8 detectors, `ssn` row | Shape: `999-99-9999` or `999 99 9999`. Check: area not 000 or 666; area 900 to 999 only as an ITIN, with group 50–65, 70–88, 90–92, or 94–99 |
| §9.8 detectors | Delete the `aadhaar` and `pan` rows |
| §9.8 detectors, `phone` row | Shape: "US 10 digits, optional +1, with spaces, dots, dashes, or brackets" |
| §9.8 detectors, `money` row | Shape: "`$` or `USD`, or grouped digits with 2 decimals" |
| §9.8 heading "Not masked: routing numbers and IFSC" | Becomes "Not masked: routing numbers" |
| §9.8 first point under it | Becomes: "**A US routing number** names a bank. It is public." |
| §9.8 format pattern example | `SB99999999` matches `SB00481223` becomes `SH99999999` matches `SH00481223` |
| §17 rejected options row | "Masking routing numbers and IFSC" becomes "Masking routing numbers" |

- **Why drop the kinds, not keep them:** the target is US-only. Unused detectors add false masks and test cost.
- **Why add ITIN:** US credit unions serve members with ITINs. The old check rejected area 900 to 999, so ITINs would slip through.
- **`intyy.policy/1.0` is not yet released,** so the kind list changes in place, like earlier amendments.

### 3.2 Label words (section 4 §9.7)

| Kind | New label words |
|---|---|
| `name` | name, customer name, member name, account holder, holder name, joint owner, beneficiary, mother's maiden name |
| `address` | address, street, city, state, zip, zip code, postal code |
| `ssn` | **New row:** ssn, social security, social security number, tax id, tin, itin |

- **The other rows stay.**
- **Label source 3 example:** "Member Name: \| RAVI KUMAR" becomes "Member Name: \| DANA WHITFIELD".

### 3.3 Money, names, and other text

| Section | Old | New |
|---|---|---|
| 1 §5 | "with a $100 deposit" | "with a $137.00 deposit" |
| 1 §5 diagram | "example values 100107 and 100" (after rename 18) | "example values 100107 and 137.00" |
| 1 §20 | "a 2008-era Indian retail bank app" | "a 2008-era US credit union back-office app" |
| 2 §12.4 | `["savings", "current"]` | `["savings", "checking"]` |
| 3 §6.7 | "100107 Ravi Kumar" (after rename 18) | "100107 Dana Whitfield" |
| 3 §6.7 | "\"₹100\" and \"Rs. 100/-\" both" | "\"$100\" and \"USD 100.00\" both" |
| 4 §4.2 | "Indian bank apps say \"Enquiry\" for \"look up\"" | "some core banking apps say \"Inquiry\" for \"look up\"" |
| 4 §7.12 | "Transfer ₹100?" | "Transfer $100?" |
| 4 §9.3 | "The last four of a five-digit ID" | "The last four of a six-digit ID" |
| 4 §9.6 | "\"1023-4\" matches `100107`" (after rename 18) | "\"1001-07\" matches `100107`" |
| 4 §9.6 | "\"₹100\", \"Rs. 100/-\", \"INR 100.00\", \"100.00\", \"$100\"" | "\"$100\", \"$100.00\", \"USD 100.00\", \"100.00\", \"100\"" |
| 4 §9.6 | "Western \"1,250.00\" and Indian \"1,00,000.00\" both parse." | "Western grouping, like \"1,250.00\", parses. Other styles need an app format." |
| 4 §9.9 | "IDs, PIN codes, and ZIP codes do not." | "IDs and ZIP codes do not." |
| 4 §9.13 | `showMember('100107','Ravi')` (after rename 18) | `showMember('100107','Dana')` |
| 4 §11.2 | "Consent for a ₹100 deposit cannot pay ₹10,000." | "Consent for a $100 deposit cannot pay $10,000." |
| 4 §15.3 | "Account opened for Ravi Kumar." | "Account opened for Dana Whitfield." |
| 4 §18 | "dates as DD/MM/YYYY" | "dates as MM/DD/YYYY" |

- **The global `formats.date` list keeps `DD/MM/YYYY`.** It lists accepted formats, not examples. Masking by every format only adds masks.

---

## 4. Section 1

| Where | Change | Why |
|---|---|---|
| §12, "Demo idea" | **Settled:** record with `KVFCU_STRIP_SEMANTICS` off; run a `quick` drill with it on. The crop must carry the vote. Build plan §13.3 | Tests replay, not discovery |
| §16, safety tests | **The member canary is seed member `100240`.** Build plan §13.2 | CONTRACT 1.1.0 has no canary member |
| §17, build plan | **Replaced by section 10 §7:** thirteen milestones, M00 to M12. The thin slice completes at M07. Gates stay mandatory | Old M4 and M6 were too big. Task discovery needs the replay prelude |
| §18, visual crop clue | "Built, thin (M08)" | Milestone named |
| §18, tenant patches | "Format and loader checks built (M04). Merge and patch commands designed" | Cheap to prove the format. Merge is only needed with patch drafting |
| §18, patch drafting and the bank B drill | "Designed. Not built. An optional lakeshore probe with no patch runs in M11" | A third stretch goal. The brief asks for one or two |
| §20 | **Contract:** `CONTRACT.md` 1.1.0. The look is a 2008-era US credit union back-office app | The contract exists now |
| §22 | Section 10 **Done** | — |

---

## 5. Section 2

| Where | Change | Why |
|---|---|---|
| §18, tenant patch format | **Build status:** M04 builds the `intyy.patch/1.0` schema and loader checks. The merge and resolver use of patches are designed only | Build plan §13.5 |
| §12.4 | Enum example: see §3.3 | US wording |

---

## 6. Section 3

| Where | Change |
|---|---|
| §6.7 | Examples: see §3.3 |
| §10, parked "Which runs to copy into `/evidence/`" | **Resolved:** build plan §11 |

---

## 7. Section 4

| Where | Change | Why |
|---|---|---|
| §9.4, §9.6, §9.7, §9.8, §9.9 | US redaction: see §3 | US target |
| §14, "A requirement on the bank app" | **Settled:** seed member `100240` is the canary. It never appears in specs, test data, suites, demo files, fixtures, or doc examples. The canary test scans for it and for the outputs its run returned. A contract change is requested, not required (§13) | No wait on another party |
| §14, "How the canary scans work" | **Publish scans for** `100240` and every secret value bound in the tenant's settings, resolved in memory | Real secrets are the best canaries at publish time |
| §15.1, first point | "The second-reviewer rule is design only" becomes "**Built at sealing** (section 8 §10.2)" | Section 8 built it. This line was missed |
| §18, parked "Canary member and loopback origin in the bank app contract" | **Resolved:** canary above. Loopback is already true: CONTRACT §1 uses `127.0.0.1` | — |

---

## 8. Section 5

| Where | Change |
|---|---|
| Throughout | Renames in §2 |
| §19, parked "Renaming placeholders" | **Resolved:** this file §2 |

---

## 9. Section 6

| Where | Change |
|---|---|
| §21, parked "Which discovery runs go in `/evidence/`" | **Resolved:** all of them. Build plan §11, items A1 to A3 |

---

## 10. Section 7

| Where | Change |
|---|---|
| §24, parked "The stripped-button demo" | **Resolved:** build plan §13.3 |
| §24, parked "Which replay and handoff runs go in `/evidence/`" | **Resolved:** build plan §11, items A5 to A11 |

---

## 11. Section 8

### 11.1 `certify case --operator mailbox` (§7.6)

**The problem:** the live handoff demo needs a fault at an exact step, and a real human answering.

- **The scripted operator ends takeovers.** It must, for batches (§7.6).
- **Only certify can place a fault at a step,** through the route map (§6.4).

**Decision:** `certify case` gains `--operator scripted|mailbox`. Default `scripted`.

| With `mailbox` | Behavior |
|---|---|
| Interventions | Go to the real mailbox. A human answers with `intyy operator` from another terminal |
| Judging | Unchanged. The first intervention's kind, reason, and step are the observed result. Truth checks still read the oracle |
| Plan | Records `operator: mailbox` and the staff ID who started the case |
| Grade | Never approval-grade. Already true for every one-case batch |
| Role | Operator |

- **The certify run spec gains** `operator: "scripted" | "mailbox"` (§7.5).
- **`--profile` also accepts an `extra` case ID** from the suite (§6.1). Example: `supervisor_needed`. That case's own faults and expected result apply. `--class` defaults to the case's class.
- **Why not arm faults by hand with `curl`:** route keys are app internals. Only the route map knows them. The harness boundary would leak into the README.

### 11.2 Other changes

| Where | Change | Why |
|---|---|---|
| §13.4, patch drafting | **Not built.** Design stays | Build plan §13.5 |
| §13.5, lakeshore drill | **Replaced in the build by the lakeshore probe:** a `quick` drill of keystone's approved key at lakeshore, with no patch. Optional, last in M11, first on the cut line | Measures the gap. Needs no patch merge |
| §17 | Patch drafting: "Designed. Not built." Lakeshore drill: "Probe only, optional" | Same |
| §21, parked "Restricted-user case" | **Resolved:** a second env file, `.env.restricted`, loaded in a subshell. No format change. Build plan §13.4 | intyy never overrides variables already set |
| §21, parked "Which batches and drills go in `/evidence/`" | **Resolved:** build plan §11, items B1, B3, B5 | — |
| §21, parked "Milestone for certify and trust (M6)" | **Resolved:** M10 and M11. Build plan §13.6 | — |
| §21, parked "Whether to build patch drafting and the lakeshore drill" | **Resolved:** above | — |

---

## 12. Section 9

| Where | Change | Why |
|---|---|---|
| §6.1, `intyy.json` | `model_keys` fixed: `"claude": "ANTHROPIC_API_KEY"`, `"jev": "JEV_API_KEY"`. New field `canary_members`: `["100240"]` | Parked item. The scanner reads canaries from config, not code |
| §6.6, publish | **Also copies** each sealed artifact version a published run names, to `evidence/artifacts/<app>/<capability>/<version>/`, after checking its hash against the artifact index | The brief asks for an artifact in `/evidence/` |
| §6.6, publish | **Trust snapshots** go to `evidence/trust/scores/<tenant>/…`, mirroring `state/trust/scores/` | A fixed place for reviewers |
| §6.6, publish | **Canary sources:** `canary_members` from `intyy.json`, plus every secret value bound in the tenant's settings, resolved in memory | Real values are the best canaries |
| §6.6, publish | **Warns** when `/evidence/` would pass 60 MB. Never refuses for size | Size is a judgment call; leaks are not |
| §6.6, publish | **Reserved names** under `evidence/`: `artifacts`, `trust`, `tests`. The settings loader rejects a tenant with one of these IDs | Avoids clashes with tenant folders |
| §7.3, new rule for every command | **The CLI loads `<root>/.env`** if present. It never overrides a variable already set | Lets a subshell switch credentials (the restricted-user case) |
| §9.1 | **`certify case` gains `--operator scripted\|mailbox`.** See §11.1 | The live handoff demo |
| §13.1 | **Bank app options for demos:** `KVFCU_TEST_MODE=1`, `KVFCU_FIXED_DATE=2026-01-15`, `KVFCU_VARIANT=keystone`, `KVFCU_DELAY_SCALE=1` | Stable, realistic evidence |
| §13.2 | **Adds the handoff demo:** `intyy certify case kvfcu/open_share_subaccount@1.0.0 --class valid --profile supervisor_needed --operator mailbox`, with `intyy operator claim` and `release` in a second terminal | The brief's handoff path, runnable |
| §19 | **Every item marked 10 is resolved** in the build plan §13 | — |

---

## 13. Request to the bank app's owner

Optional. The build does not wait for it.

- **Add one canary member** to CONTRACT §5, as version 1.2.0.
- **Its values must appear nowhere else:** a name containing `CANARY`, a member number, one existing sub-account number, and a balance.
- **Why:** member `100240`'s name and balance are unknown to intyy. A published canary lets the scan cover them too.
- **When it lands,** add its number to `canary_members` and its name to the canary test. Nothing else changes.

---

## 14. Pointer notes for the M00 script

**Rule:** insert one line directly under each heading below, before any other text:
`> **Changed by section 10:** <note>. See \`intyy-design-updates-from-section-10.md\` §<n>.`

| File | Heading (exact) | Note | § |
|---|---|---|---|
| `1-intyy-component-level-design.md` | `## 12. Seeing the screen` | The stripped-button demo is settled | 4 |
| same | `## 16. How we verify it` | The member canary is seed member 100240 | 4 |
| same | `## 17. Build plan` | Replaced by the build plan's thirteen milestones | 4 |
| same | `## 18. Built, designed, or cut` | Statuses for patches, drafting, and the visual clue changed | 4 |
| same | `## 20. Next: the bank app contract` | The contract is CONTRACT.md 1.1.0 | 4 |
| `2-intyy-artifact-schema.md` | `## 18. Tenant patch format` | Schema and loader built; merge designed only | 5 |
| `3-intyy-run-outputs.md` | `## 10. Items parked for other sections` | Items for section 10 are resolved | 6 |
| `4-intyy-safety-policy.md` | `### 9.4 Kinds` | US kinds: aadhaar and pan removed | 3 |
| same | `### 9.7 The label rule` | US label words | 3 |
| same | `### 9.8 Detectors and format patterns` | US detectors; ITIN added | 3 |
| same | `### A requirement on the bank app` | Settled: member 100240 is the canary | 7 |
| same | `### 15.1 Risk` | The second-reviewer rule is built | 7 |
| same | `## 18. Items parked for other sections` | Items for section 10 are resolved | 7 |
| `5-intyy-handler-packs-and-error-ladder.md` | `## 19. Items parked for other sections` | Items for section 10 are resolved | 8 |
| `6-intyy-discover-and-recorder.md` | `## 21. Items parked for other sections` | Items for section 10 are resolved | 9 |
| `7-intyy-replay-engine-and-handoff.md` | `## 24. Items parked for other sections` | Items for section 10 are resolved | 10 |
| `8-intyy-trust-and-versions.md` | `### 7.6 The scripted operator` | certify case gains --operator mailbox | 11 |
| same | `### 13.4 Patch drafting` | Not built | 11 |
| same | `### 13.5 The lakeshore drill` | Replaced in the build by an optional probe | 11 |
| same | `## 17. Built, thin, or designed` | Patch drafting and the drill statuses changed | 11 |
| same | `## 21. Items parked for other sections` | Items for section 10 are resolved | 11 |
| `9-intyy-interfaces.md` | `### 6.1 Two parts: library and state` | model_keys fixed; canary_members added | 12 |
| same | `### 6.6 Publishing evidence` | Publish copies artifacts, places trust snapshots, warns on size | 12 |
| same | `### 7.3 Global flags` | The CLI loads .env without overriding set variables | 12 |
| same | `### 9.1 Certify` | certify case gains --operator mailbox | 12 |
| same | `### 13.1 Setup` | Exact bank app options | 12 |
| same | `### 13.2 The path` | Adds the handoff demo | 12 |
| same | `## 19. Items parked for other sections` | Items for section 10 are resolved | 12 |

---

## 15. Rules for the rename script

- **Input:** sections 1 to 9 in `docs/design/`. Never this file, the build plan, or `CONTRACT.md`.
- **Order:** §2 rows in order, then §3 edits, then §14 notes.
- **Skip** any line containing "placeholder", case-insensitive. Those lines describe the renames.
- **Row deletions** in §3.1 match whole table rows by their first cell.
- **Idempotent:** a second run changes nothing.
- **`docs:verify` fails** if any of these appear outside skipped lines: `sparrow`, `bank_a`, `bank_b`, `BANK_A`, `bank-a`, `Bank A`, `bank A`, `Bank B`, `bank B`, `open_savings_subaccount`, `10234`, `₹`, `Rs.`, `INR`, `Ravi`, `Kumar`, `IFSC`, `aadhaar`, `Aadhaar`, `` `pan` ``, `Indian`, `operator_login`, `intyy-section-2`, `intyy-context`, `bank-app-handoff`.
- **It also fails** if a §14 heading is missing, or its note is missing.
- **Commit the result on its own,** so the owner reviews one clean diff.
