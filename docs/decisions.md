# Build decisions

One line per decision: date, milestone, decision, reason.
The design wins over this file. This file fills gaps the design leaves open.

## Dependencies

- 2026-09-26 · M00 · `typescript` ~6.0.3 · The compiler. Pinned below 6.1 because typescript-eslint 8 supports only `<6.1.0`, so TS 7 must wait.
- 2026-09-26 · M00 · `@types/node` 24 · Node types that match the Node 24 runtime in `.nvmrc`.
- 2026-09-26 · M00 · `tsx` · Dev runner for scripts and the CLI without a build (build plan §5.5).
- 2026-09-26 · M00 · `vitest` 5 · Test runner with the `unit`, `types`, and `live` projects (build plan §5.5).
- 2026-09-26 · M00 · `eslint` 10, `@eslint/js`, `typescript-eslint` 8 · Lint, including the two restricted-syntax rules (build plan §5.3).
- 2026-09-26 · M00 · `prettier` · Formatting (build plan §5.5).
- 2026-09-26 · M00 · `dependency-cruiser` 18 · Enforces the four import rules (build plan §5.3).
- 2026-09-26 · M00 · `commander` 15 · The CLI parser, the only runtime dependency so far (build plan §5.5).

## Other decisions

- 2026-09-26 · M00 · Add `tsconfig.build.json` beside `tsconfig.json` · One file cannot both type-check `tests/` and `scripts/` and emit `dist/cli/main.js`. Still one build, no project references. Owner approved.
- 2026-09-26 · M00 · Track `docs/` in git · The rename diff must be reviewable, and CI must run `docs:verify`. Owner approved.
- 2026-09-26 · M00 · Prettier is `npm run format`, not part of `check` · Build plan §5.6 does not list it in `check`.
- 2026-09-26 · M00 · `schemas` and `test:safety` scripts, and schema freshness in `check`, wait for M01 and M07 · No schema or safety test exists yet.
- 2026-09-26 · M00 · The adapter import rule lets an adapter import files in its own folder only · An adapter may span several files. Another adapter stays off limits.
- 2026-09-26 · M00 · Lint rules use `strictTypeChecked` from typescript-eslint · It catches floating promises and unsafe `any` flows in async browser code.
- 2026-09-26 · M00 · `docs:verify` matches `bank-a` only when no letter follows · A plain match also hits `bank-app` in anchor links, which is not a leftover.
- 2026-09-26 · M00 · `docs:verify` skips §14 pointer-note lines · §14 fixes their text, and one note says "aadhaar and pan removed".
- 2026-09-26 · M00 · `docs:renames` fixes "new share share sub-account" in section 6 · §2 row 20 doubles "share" there. Owner approved.
