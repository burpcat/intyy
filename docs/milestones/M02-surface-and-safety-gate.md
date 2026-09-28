# M02 — Surface and safety gate

> **Phase:** A · **Size:** L · **Depends on:** M01 · **Status:** not started

## Read first

- Section 4 §2 (principles), §3 (the gate), §6 (allowlist, all), §7.1 to §7.6 and §7.8 to §7.12 (risk rules), §8.5 to §8.10 (secret injection and hygiene), §9 (redaction, all), §14 (tests).
- Section 9 §5.2 (surface port), §5.9 (the snapshot surface fake), §16 (hands check, network guard).
- Section 7 §6.1 (candidates and role groups), §9 (native dialogs and pop-up windows).
- Section 2 §13.2 (clues).
- Section 3 §6.7 (redaction points), §7.5 to §7.7 (when to capture, snapshots, what never goes in).
- Updates file §3 (US redaction).

## Goal

One gate that every action must cross, a browser adapter that can only act through it, and redaction on everything written.

## Why now

- **Discovery (M03) is the first code that clicks.** The gate and the guard must exist before it.
- **Redaction must be in place** before the first real screen is ever saved.

## Delivers

### Code

- **`src/adapters/playwright/`:** the surface session, eyes, and hands of section 9 §5.2.
  - Fixed viewport and pixel density. Locale and time zone from settings. A `visible` option.
  - **The network guard:** blocks any host outside settings and any denied path. Emits `network_blocked`.
  - **Eyes:** elements across frames, with role, role group, clues, state, and box. Native dialogs appear as elements. Secret-filled fields report `filled: true` only.
  - **Hands:** one resolved action. Returns `dispatched` and any transport trouble as values.
- **`src/fakes/snapshot-surface/`:** answers from fixtures and scripted screen graphs.
- **`src/core/safety/policy/`:** the allowlist (hosts × paths × action types per actor) and the path matcher with normalizing (section 4 §6.3).
- **`src/core/safety/risk/`:** classes, base class by action type, words, roles, context rules, the final class, the unsure rule.
- **`src/core/safety/gate/`:** the check order of section 4 §3.3, decisions, rule IDs, per-actor meaning, log lines.
- **`src/core/safety/secrets/`:** the start check and injection rules. A secret fills a whole value in a `type` step only.
- **`src/core/safety/redaction/`:** every rule in section 4 §9, with US kinds. The only module that makes `Masked` values.
  - Text rules, known values, the label rule, detectors, digit runs, structure first.
  - Screenshot boxes (fail closed), image crops, DOM and accessibility snapshots, CLI output.
- **`src/core/safety/canary/`:** scans a folder for a marker four ways: raw, base64, URL-encoded, HTML-escaped.
- **A capture helper:** screenshot and snapshots, masked, then written to the evidence store.
- **`tests/contract/surface/`:** one suite, run on the snapshot fake (`unit`) and on Playwright (`live`).

### Commands

- None new.

### Library files

- None. Live tests use a temporary data root with a tiny test policy: the origin host, the start page, and `/__test__/` denied.

## Not in this milestone

- The observation builder for the LLM, marked screenshots, and text tags. M03.
- Clue voting and condition waits. M05.
- The image clue. M08.
- The member canary test. It needs replay (M05).
- Probing the bank app's pages. Live tests touch only the base URL, the NCUA link, and `/__test__/` paths from CONTRACT.

## Tasks, in order

- [x] 1. Write the path matcher and its tests: every example in section 4 §6.3, plus the normalizing tricks.
- [x] 2. Write the allowlist per actor (section 4 §6.9), with keys and browser features (§6.10).
- [x] 3. Write the risk classifier. Test every row of section 4 §7.12, plus word, role, and context cases.
- [x] 4. Write the redactor, rule by rule, test first. Include the US detectors, ITIN, and the known-limit test (marked expected).
- [x] 5. Write the snapshot surface fake and the surface contract suite. (Action tests arrive with the gate in task 7; owner decision.)
- [ ] 6. Write the Playwright adapter: session and guard first, then eyes, then hands, then events.
- [ ] 7. Write the gate. Test the gate matrix: each actor × class × run kind gives the right decision.
- [ ] 8. Write secret injection. Test joined secrets, wrong page, and wrong field kind: all blocked.
- [ ] 9. Write screenshot boxes, crops, and snapshot masking. Test that boxes cover every element rules 1 to 4 name.
- [ ] 10. Write the canary scanner and the capture helper.
- [ ] 11. Write the secret canary test: a scripted run on the snapshot fake types a marked fake secret. Then scan every file written.
- [ ] 12. Write the live tests: the surface contract suite on Playwright, and the network guard.

## Test gate

### Automated (CI `check` job)

- [ ] Path matcher, risk classifier, gate matrix, secret rules (section 4 §14).
- [ ] Redactor units: money, short values, clashing values, each detector's check. The known-limit test runs, marked expected.
- [ ] Screenshot masks cover every element rules 1 to 4 name. A masking failure refuses to save.
- [ ] Secret canary: the marker never reaches any file.
- [ ] Hands import check: only the gate, the adapter, and fakes import `ports/hands.ts`.
- [ ] The surface contract suite passes on the snapshot fake.

### Live (`npm run test:live`)

- [ ] The surface contract suite passes on Playwright.
- [ ] Network guard: the NCUA link, a redirect off the list, and a jump to `/__test__/faultlog` are all blocked.

### Owner checks

- [ ] Watch the network guard test once with `visible: true`. The browser never reaches `www.ncua.gov`.
- [ ] Open one masked screenshot from a live test. Nothing sensitive shows.

## Evidence produced

- None published. The capture helper is ready for M03.

## Done when

- The only way to act on the browser is through the gate, and a test proves it.
- Everything the adapter captures is masked before it is written.
- Section 4 §14 passes, except the member canary (M05) and the LLM view test (M03).
