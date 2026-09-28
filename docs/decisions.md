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
- 2026-09-28 · M01 · `DocumentStore` gains `getCandidate`, and `approve` may also return `not_found`, `hash_mismatch`, or `invalid` · `check` and `edit` must read a candidate. Approve reads the sealed file first, and every read checks the hash.
- 2026-09-28 · M01 · `Opaque<Name>` in `src/ports/opaque.ts` brands every placeholder type · One helper replaces about 20 hand-written brands like build plan §5.3's `SurfaceFactory`. Same effect.
- 2026-09-28 · M01 · The lock rules live once, in `src/core/locks/manager.ts`, over a small `LockSlots` interface · Files and memory supply only storage. The order, parent, stale, and wait rules cannot drift between the adapter and its fake.
- 2026-09-28 · M01 · A lock file is created by hard-linking a finished temp file to the lock name · The link fails if the name exists, so create stays exclusive. A reader never sees half a lock file.
- 2026-09-28 · M01 · Settings secret bindings must name an `INTYY_` variable · Section 4 §8.3 fixes that convention. A secret value pasted into `key` then fails the load (§5.4).
- 2026-09-28 · M01 · A missing policy block or field counts as its strictest value · Section 4 §4.4 makes every block optional. Deny by default (§2.1) fills the gap.
- 2026-09-28 · M01 · Browser switches accept only the values the design names · `block` for downloads, uploads, and service workers; `allowlist` or `block` for pop-ups; `surface` for dialogs. Section 4 §6.10 was not in M01's reading.
- 2026-09-28 · M01 · The full path-pattern parse and the ID format parse wait for M02 · M01 checks that a pattern starts with `/` and has no spaces. M02 builds the path matcher and the redactor (section 4 §6.3, §9.8).
- 2026-09-28 · M01 · `DocKind` takes a `parse` function and an optional `idOf` · Policy errors then name the fields of the file's own level. A file stored under another ID fails the load (section 9 §6.2).
- 2026-09-28 · M01 · `risk.reversible_words` merges as an allow list: lower layers may only remove words · A reversible word moves an unsure label below irreversible, so adding one lowers risk (section 4 §2.4). The safe-word exception is for safe words only (§4.2).
- 2026-09-28 · M01 · The merge compares path and secret-path patterns as plain strings · A tenant may keep or drop an app pattern, not write a narrower one. M02's path matcher can accept a pattern the parent's pattern covers.
- 2026-09-28 · M01 · A merge reports every problem, one line each, not just the first · Section 4 §4.3 wants loosening to fail loudly. One load then shows the author every mistake.
- 2026-09-28 · M01 · `src/cli/program.ts` builds the command tree; `main.ts` only calls `run` with the real streams · Tests run the whole CLI in-process with fake streams and a temporary data root.
- 2026-09-28 · M01 · With `--json`, a failed command still prints one JSON document: `{ "error": { "code", "message" } }` · Section 9 §7.4 says `--json` prints exactly one document. The human error still goes to standard error.
- 2026-09-28 · M01 · `--reveal-outputs` and `--models` are global flags, and every other command refuses them with exit 1 · Section 9 §7.3 lists them as global, but only for `replay`, `certify`, and `reconcile`.
- 2026-09-28 · M01 · Any staff member in `staff.json` may `edit` a candidate; `seal` needs reviewer and `approve` needs approver · Section 9 §7.1 names roles for seal and approve only. Edit writes nothing sealed.
- 2026-09-28 · M01 · `check` and `seal` test a layer against its parent's newest approved revision, else sealed, else candidate, and print which · The owner drafts every M01 layer at once. At run time only approved layers load.
- 2026-09-28 · M01 · `check` with no candidate checks the newest approved, else sealed, revision · The owner check `settings check --secrets` runs after approval, when no candidate is left.
- 2026-09-28 · M01 · `approve` needs `--rev`; there is no default revision · A human approves one named revision. Guessing the newest would approve what they did not read.
- 2026-09-28 · M01 · `settings check --secrets` prints its list, then exits 1 if any bound secret is missing · The list is the answer. A missing value means the start check would fail (section 4 §8.4).
- 2026-09-28 · M01 · `policy effective` merges for `--app`, else the only app in the tenant's approved settings · Section 9 §7.2: the app comes from the tenant's settings.
- 2026-09-28 · M01 · A bad `edit` is not saved; the edited file stays in `state/var/tmp` · The CLI stops a bad file before it lands (section 9 §2.6), and the author keeps their work.
- 2026-09-28 · M01 · A lock file that does not parse counts as held · When unsure, assume the worst (section 4 §2.3). `run sweep --force-unlock` clears it.
- 2026-09-28 · M02 · The path matcher strips `;` path parameters before it resolves `.` and `..` · Section 4 §6.3 resolves first. Old Java servers read `..;x` as `..`. Resolving first would let `/members/..;x/admin` hide a jump to `/admin`. Stricter order, same rules.
- 2026-09-28 · M02 · A trailing slash stays after normalizing, so `/members/100107/` does not match `/members/*` · A server may serve another page there. Not matching is the safe direction (section 4 §2.1, deny by default).
- 2026-09-28 · M02 · A query parameter that appears more than once must match the pattern in every copy, and `*` never matches `/` in a query value · Servers differ on which copy wins. Section 4 §6.3 is silent.
- 2026-09-28 · M02 · A path pattern that no clean path can match fails the load · Examples: `//`, a `.` or `..` segment, `**`, `#`, `%`, `;`, a backslash, or a query part without `name=value`. The JSON Schema keeps only the old "starts with /" regex, since it cannot express the full parse. A typo would otherwise pass the loader and silently allow nothing.
- 2026-09-28 · M02 · `extra_origins` stays a plain list of origins, and every extra origin shares the app's path rules. Section 4 §6.6's object form, a purpose and its own path list per origin, is not built. · §6.6 says the build uses no extra hosts. §6.1 defines the allowlist as hosts × paths.
- 2026-09-28 · M02 · The `Allowlist` port type becomes a small interface: `check(url, kind)` and `popups`. The core builds it from settings and the merged policy; the Playwright adapter only asks it. · The path rules then live once, in `src/core/safety/policy/`, and the adapter cannot drift from the gate.
- 2026-09-28 · M02 · The settings loader rejects an origin whose host is an IP address, unless it is loopback. · Section 4 §6.2.
- 2026-09-28 · M02 · A function key such as `F2` is allowed when `risk.key_labels` maps it, though it is not on `actions.keys`. The reviewer may press only Tab and Escape. · Section 4 §6.9. `actions.keys` merges as an allow list, so a lower layer could never add a function key there.
- 2026-09-28 · M02 · A control that is neither button-like nor navigation-like counts as button-like for risk. Examples: a text box, a checkbox, a table. With no list word, it is unsure, so risk treats it as irreversible. · Section 4 §7.4 names only two role groups for risk. When unsure, assume the worst (§2.3).
- 2026-09-28 · M02 · A link counts as navigation-like only when the allowlist allows its target. A link off the list, like the NCUA footer link, is button-like, so a bland label leaves it unsure. A link to an `irreversible` path stays irreversible. · Section 4 §7.4 calls only a link to a plain allowed path navigation-like. §7.12 classes the link to `/accounts/9/close` as irreversible.
- 2026-09-28 · M02 · A known value carries its own token kind in a `kind` field. The redactor uses the kind when a plain reference would mislead: a short sensitive value, or two values that clash. M05 picks the kind from the contract field. · Section 4 §9.6 says "a token" but names no kind. The kind list in §9.4 is fixed.
- 2026-09-28 · M02 · The money detector also masks plain digits with two decimals, like `99.95` or `1250.00`, not only grouped digits like `1,250.00`. · Updates file §3.1 says "grouped digits with 2 decimals". An ungrouped balance would otherwise leak. Stricter is safe.
- 2026-09-28 · M02 · The label rule reads every colon in a line. When the text before a colon holds a label phrase as whole words, the rest of the line is masked. The longest matching phrase picks the kind. Each line is its own label-value pair. · Section 4 §9.7 label source 4 gives one example only. So "Primary Phone: …" masks as `phone`, and "Account State: …" masks as `address`. Over-masking is the safe direction.
- 2026-09-28 · M02 · A token tells values apart by meaning: money by amount, numbers by their digits, other text by its words. So `(555) 010-4477` and `+1 555 010 4477` get one token. · Section 4 §9.3 wants "same value, same token".
- 2026-09-28 · M02 · A known value labelled `none` with four or more characters still becomes its reference. Only a short `none` value is left alone. · Section 4 §9.6 has a short-value table for this. §9.2's "never masked" then means no token and no placeholder.
