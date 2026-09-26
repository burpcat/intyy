# README outline

> **For:** the agent, drafting `/README.md` in M07 and finishing it in M12.
> **Brief §6 asks for:** setup, keys and config, and how to run without live services.
> **It also asks for a demo path:** exact commands to run the agent on a goal, then replay the result.
> **Reader:** a reviewer who has never seen intyy. They read many submissions side by side.
> **Rules:** exact commands, copy-paste ready. Short sentences. No design argument here; that goes in `REPORT.md`.

---

## Headings, in order

### 1. intyy

- Two sentences: what intyy does, and for whom.
- One line of the through-line: "The model discovers. The artifact becomes a capability. Replay runs it with no model deciding."
- Links: `REPORT.md`, `evidence/README.md`, `docs/design/`.

### 2. What you need

- Node.js 24, npm, git.
- The bank app's own needs, as its README states. Link to it.
- An Anthropic API key, only for a new discovery run. Not for the short demo path.
- A jev key, only if M09 was built.

### 3. Setup

Two repos, side by side. Exact commands:

```
mkdir intyy-review && cd intyy-review
git clone <intyy repo URL> intyy
git clone <bank app repo URL> kvfcu-bank
cd kvfcu-bank && git checkout <commit from intyy/bankapp.json>
```

**The bank app's `.env`** (build plan §10.3):

| Option | Value |
|---|---|
| `KVFCU_TEST_MODE` | `1` |
| `KVFCU_FIXED_DATE` | `2026-01-15` |
| `KVFCU_VARIANT` | `keystone` |
| `KVFCU_DELAY_SCALE` | `1` |
| Teller, supervisor, restricted users | Your choice of names and passwords |

Then `make up`. It serves `http://127.0.0.1:8080`.

**intyy:**

```
cd ../intyy
npm ci
npx playwright install chromium
npm run build
npm link
cp .env.example .env        # then fill it in: see section 4
npm run bankapp:smoke
intyy staff whoami
intyy settings check --secrets
```

### 4. Keys and configuration

- A table of every `.env` variable: name, what it holds, when it is needed. Source: `.env.example`, build plan §10.2.
- The teller's credentials go in the two `OPERATOR` variables.
- How to make the request index key: `openssl rand -hex 32`.
- `intyy.json`: one line on each field.
- **Where secrets never go:** artifacts, logs, evidence, the command line. One sentence each.

### 5. Demo path

**Short path: no model key needed.** Replays the artifact the library ships.

| # | Command | Expect |
|---|---|---|
| 1 | `intyy replay kvfcu/open_share_subaccount@1 --mode supervised --inputs demo/valid.json` | `success`, with the new account number |
| 2 | `intyy replay kvfcu/open_share_subaccount@1 --mode supervised --inputs demo/missing.json` | `business_outcome`, `member_not_found`, exit 2 |
| 3 | `intyy replay kvfcu/open_share_subaccount@1 --mode supervised --inputs demo/bad.json` | `rejected`, `invalid_input`, exit 4 |
| 4 | `intyy certify case kvfcu/open_share_subaccount@1.0.0 --class valid --profile reply_lost` | `success`, commit `found_by_check` |

- Say what "supervised" means in one line: you confirm the start in the terminal.
- Say why step 4 matters in one line: the reply to Confirm was lost, and a read-only check found the truth.

**Full path: run the agent on a goal.** Section 9 §13.2 of the design.

| # | Command | Expect |
|---|---|---|
| 1 | `intyy discover library/specs/kvfcu/open_share_subaccount.json` | A real LLM run. Prints a candidate ID |
| 2 | `intyy candidate review <id>` | You decide tags, risks, labels, outcomes |
| 3 | `intyy candidate seal <id> --version <next>` | A sealed artifact. The CLI proposes the number |
| 4 | `intyy replay kvfcu/open_share_subaccount@1 --mode supervised --inputs demo/valid.json` | `success` |
| 5 | `intyy replay … --inputs demo/missing.json` | `business_outcome`, exit 2 |
| 6 | `intyy certify case kvfcu/open_share_subaccount@<next> --class valid --profile reply_lost` | `success`, `found_by_check` |

- **Note for the agent:** `1.0.0` already exists, so the new seal needs the next version. Write the rule, not a guessed number: the CLI proposes the bump (section 9 §8.2).
- Say discovery pauses before Confirm and asks for approval. The reviewer answers "approve as irreversible" (section 4 §7.7). Give the exact command the build uses.
- Say the library ships `sign_in@1.0.0`, so discovery signs in first by replay.
- Say `make reset` in the bank app gives clean data before a demo.

### 6. Handoff demo

Two terminals. Copy from the M07 spec, "The live handoff".

- One line: the browser is visible; the human works in the same session the bot used.
- One line: the mailbox in the run folder records the claim, the release, and the human's actions, masked.

### 7. Unattended path

**Only if M10 was built.** Otherwise one line: "Unattended runs are rejected until a key is certified and approved. See REPORT §7."

- The rejected replay, the three certify batches, the approvals, the successful replay. Copy from the M10 spec.

### 8. Running without live services

- The bank app is local. The only live services are the model APIs.
- `--models off` runs replay, certify, and reconcile with no model. Trouble that needs a model climbs to a human.
- Discovery needs a live model. `/evidence/` holds real runs instead.
- CI uses fake twins. No key is needed for `npm run check` or `npm run test:live`.

### 9. Tests

| Command | Needs | Covers |
|---|---|---|
| `npm run check` | Nothing live | Types, lint, structure rules, unit and type tests |
| `npm run test:live` | The bank app, test mode | Surface, guard, replay, faults, handoff |
| `npm run test:safety` | Nothing live | Safety and canary tests, as a JSON report |

- Say the live tests take the instance lock and run one at a time (CONTRACT §2).

### 10. Evidence

- One paragraph: what `/evidence/` holds, and that `evidence/README.md` indexes it.
- A short table of the headline items only: A1, A3, A5, A6, A8, A11. Link each.
- `intyy evidence verify` checks hashes, links, and canaries.

### 11. Exit codes

- The table of section 9 §7.5, codes 0 to 8. One line each.

### 12. Troubleshooting

- **Exit 8, busy:** another run holds the instance lock. The message names it.
- **`secret_unavailable`:** a bound variable is empty. Run `intyy settings check --secrets`.
- **`bankapp:smoke` fails:** the app is down, or test mode is off.
- **A run hangs at the start:** a supervised run waits for your confirmation.
- **After a crash:** `intyy run sweep`, then the `reconcile` command it prints.

### 13. Further reading

- `REPORT.md`, the design write-up.
- `docs/design/`, sections 1 to 10. Section 1 is the overview.
- `docs/milestones/`, how it was built, with each gate.

---

## Checks before the README is done

- [ ] Every command was run once, from a fresh clone, by the owner.
- [ ] No real credential, key, or member value appears. Demo values only.
- [ ] Member `100240` does not appear.
- [ ] Every link resolves.
