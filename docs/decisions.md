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
- 2026-09-28 · M01 · `zod` 4 · Zod schemas for every file format and port input (section 9 §5.1). Runtime dependency. `z.toJSONSchema` writes `schemas/`.

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
- 2026-09-26 · M00 · Live is a local step. CI runs only the `check` job · The owner runs the bank app and the live tests locally (build plan §8, last point).
- 2026-09-26 · M00 · `bankapp:smoke` never follows redirects · Every request stays on 127.0.0.1.
- 2026-09-28 · M01 · `library/staff.json` follows build plan §9, not the section 9 §7.7 example · `op_022` is operator and reviewer on `*`, and approver at keystone and lakeshore. The M01 spec points to build plan §9.
- 2026-09-28 · M01 · Every async port operation takes a trailing `signal?: AbortSignal` · Section 9 §5.1 requires an abort signal. The §5 code blocks leave it out for brevity.
- 2026-09-28 · M01 · Port types that later milestones define are opaque branded placeholders · Examples: `Observation`, `ResolvedAction`, `LeaseToken`. Each doc comment names the section and milestone that fills it in.
- 2026-09-28 · M01 · The candidate, log, and evidence store ports are the smallest interfaces section 9 §5.8 needs · §5.8 writes out only `DocumentStore`. Later milestones extend the others.
- 2026-09-28 · M01 · The document store enforces four eyes; the CLI enforces roles · `approve` by the sealer returns `rule: four_eyes`. Roles come from the staff file, which the store does not read.
- 2026-09-28 · M01 · One `index.jsonl` per top-level store folder · Examples: `library/policy/index.jsonl`, `library/settings/index.jsonl`. This matches `library/artifacts/index.jsonl` in section 9 §6.2.
- 2026-09-28 · M01 · `batchId`, `leaseToken`, and `alertId` use the run ID shape with their own prefix · Section 3 §7.2 fixes only the run ID. One shape keeps one parser.
- 2026-09-28 · M01 · `npm run schemas` and schema freshness in `check` land in M01 · The M00 line deferred them until the first schema exists.
- 2026-09-28 · M01 · Settings hold `apps.<app>.locale` and `apps.<app>.time_zone` · Build plan §9 needs `en-US` and `America/New_York`. Section 4 §5.2 has no field. Per app, because a surface session takes them per session. Owner approved.
- 2026-09-28 · M01 · The settings loader rejects tenant IDs `artifacts`, `trust`, and `tests` · Updates file §12 reserves these names under `evidence/`.
- 2026-09-28 · M01 · `policy effective` and `policy check` merge the approved layers that exist and name any missing layer · The kvfcu app layer arrives in M03. A missing app layer allows no paths, so nothing loosens. Runs from M02 still need all three layers. Owner approved.
- 2026-09-28 · M01 · Global policy revision 1 uses section 4 §4.7's structure with the full default lists · Words from section 4 §7.3; sensitive labels from §9.7 and updates §3.2; detectors from updates §3.1. The §4.7 lists are shortened. Owner approved.
- 2026-09-28 · M01 · Sensitive label words go in a new policy field, `redaction.labels`, a map from kind to words · Section 4 §9.7 lists the labels but names no field. Owner approved.
