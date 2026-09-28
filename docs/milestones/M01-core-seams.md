# M01 — Core seams

> **Phase:** A · **Size:** M · **Depends on:** M00 · **Status:** done

## Read first

- Section 9 §2 (principles), §5 (ports, all), §6.1 to §6.5 (data root, library, state, indexes, git), §7 (CLI, all), §12 (locks), §16 (tests).
- Section 3 §6.1, §6.2 (log format), §6.6 (write-ahead rule), §7.1 to §7.3 (evidence folder, run ID, `run.json`).
- Section 4 §2 (principles), §4 (policy file), §5 (settings file), §8.1 to §8.4 (secret chain, binding, start check), §8.11 (intyy's own keys).
- Build plan §9 (library ships), §10 (configuration).

## Goal

Every seam later work plugs into: ports, stores, locks, the CLI shell, identity, and the policy and settings files.

## Why now

- **Every feature writes files, takes locks, and runs from the CLI.** Build these once, tested, before any browser.
- **Policy and settings must exist** before the gate (M02) can check anything.

## Delivers

### Code

- **`src/ports/`:** every port of section 9 §5, as written. Also `outcome.ts`, `masked.ts`, `secret.ts`.
  - `surface.ts` holds the opaque `SurfaceFactory`. `hands.ts` holds the real shape (build plan §5.3).
  - `Secret` never prints its value. `toString()` and `toJSON()` return `"[secret]"`.
- **`src/core/model/`:** Zod schemas for `intyy.config/1.0`, `intyy.staff/1.0`, `intyy.policy/1.0`, `intyy.settings/1.0`, `intyy.index/1.0`, `intyy.lock/1.0`.
- **`src/core/safety/policy/`:** the three-layer merge; loosening fails loudly; bounds; a stable hash (section 4 §4.2 to §4.8).
- **`src/adapters/files/`:** the four store shapes of section 9 §5.8. Atomic writes through `state/var/tmp`. One `index.jsonl` per store. The seal hash excludes `approved`. Every read checks the hash.
- **Evidence store:** `appendEvent(line, { durable: true })` flushes to disk. A failed write returns `write_failed`.
- **`src/adapters/system/`:** clock, and IDs. Run IDs follow section 3 §7.2: `run_` + date + `_` + 10 Crockford base32 characters.
- **`src/adapters/env-secrets/`:** the secret port, reading the variables that settings bind.
- **Locks:** run, instance, and score locks, with exclusive create, stale checks, and the order rule (section 9 §12).
- **`src/fakes/`:** in-memory stores and locks, a manual clock, seeded IDs, a map for secrets.
- **`src/cli/`:** `main.ts`, `wiring.ts`, `output.ts`, `exit-codes.ts`, and the global flags of section 9 §7.3.
  - Role checks read the staff file.
  - Every command starts with the sweep. For now it is a stub that finds no runs.
- **The `.env` loader:** reads `<root>/.env` with `util.parseEnv`. Sets only variables not already set.

### Commands

- `staff whoami`, `staff check`.
- `policy edit | check | seal | approve | effective`.
- `settings edit | check | seal | approve`, and `settings check --secrets` (prints names and "set" or "missing", never values).

### Library files

| File | Agent | Owner |
|---|---|---|
| `library/staff.json` (build plan §9) | Drafts it | Reviews in git |
| `library/policy/global/1.json` | Drafts the candidate from section 4 §4.7 | Seals as `op_017`, approves as `op_031` |
| `library/policy/tenant/keystone/1.json` | Drafts the candidate: opts in the three capabilities | Seals as `op_017`, approves as `op_022` |
| `library/settings/keystone/1.json` | Drafts the candidate from build plan §9 and §10 | Seals as `op_017`, approves as `op_022` |

## Not in this milestone

- The app policy for `kvfcu`. The owner writes its paths in M03, after a manual look.
- The path matcher and allowlist checks. M02 builds them with the gate.
- Artifact, candidate, and pack schemas. M04 and M06 add them.
- Any adapter that opens a browser or calls a model.

## Tasks, in order

- [x] 1. Write `outcome.ts`, `masked.ts`, `secret.ts`. Add type tests: a raw string does not fit where `Masked` is required.
- [x] 2. Write every port interface from section 9 §5. Add doc comments that cite the section.
- [x] 3. Write the clock and ID adapters and their fakes. Test the run ID format.
- [x] 4. Write the store contract suites first. Run them against the fakes.
- [x] 5. Write the file store adapters. Run the same suites in a temporary data root.
- [x] 6. Add durable append to the evidence store. Test a failed write returns `write_failed`.
- [x] 7. Write the locks and their tests: busy, fail fast, bounded wait, child shares the hold, stale cleared, other host held.
- [x] 8. Write the config, staff, policy, settings, index, and lock schemas.
- [x] 9. Write the policy merge. Test that a loosening layer fails to load, and that the hash is stable.
- [x] 10. Write the CLI shell: flags, output rules, exit codes, the `.env` loader, role checks, the sweep stub.
- [x] 11. Write the test that no command accepts an input value as a flag.
- [x] 12. Write the staff, policy, and settings commands. Four eyes: approve refuses the sealer, exit 6.
- [x] 13. Draft the four library files as candidates. Stop. Ask the owner to seal and approve them.

## Test gate

### Automated (CI `check` job)

- [x] Store contract suites pass on fakes and on file adapters.
- [x] Store sealing: seal writes the index; the hash excludes `approved`; a changed file fails to load with exit 7.
- [x] Four eyes: every approve refuses the sealer, exit 6.
- [x] Policy merge: loosening fails; bounds hold; the hash is stable.
- [x] Locks: all six cases above. Busy exits 8.
- [x] Exit codes: each status and refusal maps to its code (section 9 §7.5).
- [x] Output rules: terminal versus pipe; `--json` prints exactly one document.
- [x] No inputs on flags.
- [x] The `.env` loader never overrides a variable already set.
- [x] `Secret` never appears in JSON, `console.log`, or error text.
- [x] The masked type test fails to compile a raw string.

### Live

- [x] None.

### Owner checks

- [x] The four library files are sealed and approved through the CLI.
- [x] `intyy staff whoami` prints `op_017` and its roles.
- [x] `intyy settings check --secrets` shows every bound name as "set".

## Evidence produced

- None.

## Done when

- Files, locks, and the CLI behave as section 9 says, with tests to prove it.
- Keystone has sealed, approved policy and settings.
