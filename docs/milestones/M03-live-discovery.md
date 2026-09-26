# M03 — Live discovery

> **Phase:** A · **Size:** M · **Depends on:** M02 · **Status:** not started

## Read first

- Section 6 §2 (principles), §4 (discovery in one view), §5 (the session capability), §6 (run spec), §7 (example values and formats), §8 (observation), §9 (tools), §10.1 to §10.4 (the loop), §11 (the prompt), §12 (tags), §13 (fingerprint capture), §18 (tests).
- Section 4 §7.7 (risk in discovery, the four answers), §8.2 (declaring a secret), §10 (the LLM's view).
- Section 9 §5.3 (model ports), §5.4 (operator port), §8.1 (spec commands), §10.4, §10.5 (operator commands, mailbox), §16 (model call order, planner cassette).
- Section 3 §6.4, §6.5 (event types, frozen facts), §7.1 (evidence layout, the `llm/` folder).
- Section 7 §13.1 (intervention request fields), §13.4 (the operator port in the build).

## Goal

A real LLM completes `sign_in` on the bank app, through the gate, with a masked record of every turn.

## Why now

- **The brief's one hard rule:** the discovery run must be real (brief §4). This milestone produces the first one.
- **Task discovery needs `sign_in` first.** Tasks start after a replayed sign-in prelude (build plan §7.2).

## Delivers

### Code

- **`src/adapters/claude/`:** the planner port on `@anthropic-ai/sdk`, model `claude-sonnet-5`, tool use with images.
  - **Model call order:** write the exact request bytes to `llm/` first, then send. A failed write stops the call.
  - **Two failures in a row** end the run `failed`, code `model_unavailable`.
- **`src/fakes/cassette-planner/`:** replays saved, masked replies turn by turn. A changed observation stops it loudly.
- **`src/core/model/`:** the run spec schema (section 6 §6).
- **`src/core/orchestrator/`:** the run lifecycle for discovery: pre-run checks for specs, frozen facts, `run_start`, limits, the end.
- **`src/core/discovery/`:**
  - The observation builder: element list, element IDs, history.
  - The marked screenshot: masked, with text tags drawn in an offline Playwright page.
  - Tools: screen tools, `type` values by reference, `read`, control tools.
  - The loop: one turn, gate feedback to the LLM, checks on `done`, how a run ends.
  - Prompts as TypeScript modules in `prompts/`, one per version.
  - Tags on every action. Fingerprint capture, with input crops taken before typing.
- **`src/adapters/mailbox/`:** the operator port on files in the run folder. Requests, decisions, `closed.json`.
- **Irreversible actions in discovery pause** for a human answer through the mailbox (section 4 §7.7).

### Commands

- `spec new | edit | check`.
- `discover <spec>`. It prints the run ID. M04 adds the candidate.
- `operator list | show | decide`. Claims and takeovers come in M07.

### Library files

| File | Agent | Owner |
|---|---|---|
| `library/policy/app/kvfcu/1.json` | Writes the skeleton: declared secrets, `/__test__/` denied, empty path lists | Fills in paths after a manual look. Seals as `op_017`, approves as `op_031` |
| `library/specs/kvfcu/sign_in.json` | Drafts it from section 6 §6.4 with `spec new` | Reviews in git |

## Not in this milestone

- The recorder and candidates. M04.
- Task specs and task discovery. M05, after the prelude exists.
- Takeover during discovery. M07.
- Learning app paths by probing. The owner writes them.

## Tasks, in order

- [ ] 1. Write the run spec schema and `spec new | edit | check`. Test bad example values and missing fields.
- [ ] 2. Write the observation builder. Test masking, caps, frames, dialogs, and visible labels with dropped markup labels.
- [ ] 3. Write the marked screenshot and text tags.
- [ ] 4. Write the tools and their checks. Test stale IDs, mask tokens, unknown outputs, and `done` rules.
- [ ] 5. Write the prompt module, version 1.
- [ ] 6. Write the loop with a scripted planner. Run it on the snapshot surface in `unit`.
- [ ] 7. Write the Claude adapter with the model call order. Test with a fake HTTP layer: stored bytes equal sent bytes.
- [ ] 8. Write the mailbox adapter and `operator list | show | decide`.
- [ ] 9. Write the LLM view test: stored prompts hold no canary value.
- [ ] 10. Write the app policy skeleton. Stop. Ask the owner for the manual look and the paths.
- [ ] 11. Draft `sign_in.json` with the owner. Stop. Ask the owner to run the real discovery.
- [ ] 12. Run the canary scan over the run folder. Copy its masked turns into `tests/fixtures/cassettes/sign_in/`.
- [ ] 13. Write the cassette test in `live`: it replays the owner's run on the bank app.

## Test gate

### Automated (CI `check` job)

- [ ] Run spec checks, element list builder, tool call checks (section 6 §18).
- [ ] The loop completes a scripted goal on the snapshot surface.
- [ ] Model call order: stored bytes equal sent bytes; a failed write stops the call.
- [ ] Two model failures end the run `model_unavailable`.
- [ ] Discovery approvals: `request.json` written, decision read, `closed.json` written.
- [ ] LLM view: no canary value in any stored prompt.

### Live (`npm run test:live`)

- [ ] The cassette replays the saved `sign_in` run on the bank app.
- [ ] A changed observation stops the cassette loudly.

### Owner checks

- [ ] `library/policy/app/kvfcu/1.json` is sealed and approved.
- [ ] A real `sign_in` discovery run ended with `done` accepted.
- [ ] You read its `llm/` folder and screenshots. Nothing sensitive shows. The canary scan is clean.

## Evidence produced

- **A1:** the real `sign_in` discovery run, in `state/evidence/keystone/runs/<run_id>/`. Published in M07.

## Done when

- A real model signed in to the bank app through the gate.
- CI can replay that run without a model key.
