# M00 — Foundation

> **Phase:** A · **Size:** S · **Depends on:** nothing · **Status:** gate pending (npm link, CI on GitHub)

## Read first

- `CLAUDE.md` (all of it).
- Build plan §5 (code layout, all), §6 (bank app and docs), §8 (CI), §10 (configuration).
- Updates file §2 (renames), §3 (US examples), §14 (pointer notes), §15 (rename script rules).
- `CONTRACT.md` §1 (starting it), §4 (options), §8 (test endpoints, only `GET /__test__/faultlog`).

## Goal

A repo that builds, checks itself, and holds consistent design docs, before any product code exists.

## Why now

- **Every later gate runs on this tooling.** The structure rules must exist before the first import.
- **The renames give one vocabulary.** The agent reads `kvfcu` and `keystone` everywhere, never old placeholders.

## Delivers

### Code and config

- `package.json`: ES modules, `engines.node >= 24`, `bin.intyy` pointing to `dist/cli/main.js`, the scripts in build plan §5.6.
- `tsconfig.json`: `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `module` and `moduleResolution` set to `NodeNext`.
- `.nvmrc` (Node 24), Prettier config.
- `vitest.config.ts` with three projects: `unit`, `types` (type-check mode for `*.test-d.ts`), `live` (one file at a time).
- `eslint.config.js` with typescript-eslint and the two restricted-syntax rules of build plan §5.3.
- `.dependency-cruiser.cjs` with the four import rules of build plan §5.3.
- `tests/structure/imports.test.ts`, plus `tests/structure/fixtures/`: one bad import per rule.
- `src/cli/main.ts`: `intyy --version`, using `commander`.
- `intyy.json`: build plan §10.1, including `canary_members`.
- `bankapp.json`: `{ "repo": …, "commit": …, "contract": "1.1.0", "origin": "http://127.0.0.1:8080" }`.

### Scripts

- `scripts/docs-renames.ts`: applies updates file §2, §3, and §14 to sections 1 to 9. Follows §15.
- `scripts/docs-verify.ts`: fails on any §15 leftover word, or a missing §14 note.
- `scripts/bankapp-smoke.ts`: `GET /` answers; `GET /__test__/faultlog` answers 200 with JSON, which proves test mode.

### Docs

- `docs/typescript-refresher.md`, first entries: ES modules and `import type`; the strict flags; `unknown` versus `any`; union types with a `kind` field; branded types; `satisfies`; `z.infer`; `async` and `await`.
- `docs/decisions.md`: a header, then one line per dependency chosen in this milestone.

### CI

- `.github/workflows/ci.yml` with the `check` job (build plan §8).
- The `live` job only if the owner confirms `make up` runs on a Linux runner. Otherwise record "live is a local step" in `docs/decisions.md`.

### Library files

- None.

## Not in this milestone

- Any port, schema, store, or product logic. M01 starts those.
- The `.env` loader. M01 builds it with the CLI shell.
- Reading anything in `../kvfcu-bank`. The owner answers questions about it.

## Tasks, in order

- [x] 1. Scaffold `package.json`, `tsconfig.json`, `.nvmrc`, Prettier. Install dev tools. Log each dependency in `docs/decisions.md`.
- [x] 2. Add ESLint with the restricted-syntax rules. Point them at `src/core/` and `core/safety/redaction/` as build plan §5.3 says.
- [x] 3. Add dependency-cruiser with the four rules. Write `imports.test.ts` to run it and fail on any violation.
- [x] 4. Write the self-test. Each fixture breaks exactly one rule. The test asserts each rule reports its own fixture.
- [x] 5. Set up the three Vitest projects. Add one trivial test to each so the projects prove they run.
- [ ] 6. Write `src/cli/main.ts` with `--version`. Build, `npm link`, run `intyy --version`.
- [x] 7. Write `docs-renames.ts` and `docs-verify.ts`. Run renames on `docs/design/`. Run it again: nothing changes.
- [x] 8. Stop. Ask the owner to review and commit the rename diff on its own.
- [x] 9. Add `docs:verify` to `npm run check`.
- [x] 10. Ask the owner for the bank app's repo URL and commit. Write `bankapp.json`.
- [x] 11. Write `bankapp-smoke.ts`. It reads the origin from `bankapp.json`. It fails loudly and names the fix.
- [x] 12. Ask the owner two questions: does `make up` run on a Linux runner, and what runtime does it need? Write the CI workflow from the answers.
- [x] 13. Write the first refresher entries and `docs/decisions.md` lines.

## Test gate

### Automated (CI `check` job)

- [x] `npm ci && npm run build && npm run check` is green.
- [x] The structure self-test shows each rule firing on its own fixture.
- [x] `docs:verify` passes. A second `docs:renames` run changes no file.
- [x] `intyy --version` prints the package version.

### Live

- [x] `npm run bankapp:smoke` passes with the bank app running in test mode.

### Owner checks

- [x] The rename diff is reviewed and committed alone.
- [x] `bankapp.json` names the right commit.
- [ ] The CI `check` job is green on GitHub.

## Evidence produced

- None.

## Done when

- The repo builds and checks itself on every push.
- The design docs read `kvfcu`, `keystone`, and US examples everywhere, with pointer notes in place.
- The bank app answers the smoke check.
