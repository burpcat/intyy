# intyy

intyy gives AI agents "hands" in bank back-office apps that have no API.
A model discovers a task once. intyy records it as a reviewed file. Replay then repeats it.

**The model discovers. The artifact becomes a capability. Replay runs it with no model deciding.**
(An *artifact* is the reviewed file that says how to do one task. A *capability* is a sealed artifact an agent can call, like `kvfcu/open_share_subaccount@1`.)

Read next: [REPORT.md](REPORT.md) (the decisions), [evidence/README.md](evidence/README.md) (the proof), [docs/design/](docs/design/) (the design).

## What you need

- Node.js 24, npm, and git.
- The bank app `kvfcu`. Its own README lists what it needs. `bankapp.json` pins its repo and commit.
- An Anthropic API key, only for a new discovery run. The short demo path needs no key.
- A jev key, only for the jev rung (*jev* is the error sorter that reads a stuck screen on rung 2). The ports, the reviewer, and `--models off` are built. The jev adapter is not, because it needs the owner's jev SDK. Without it, trouble climbs to a human.

## Setup

Put the two repos side by side.

```
mkdir intyy-review && cd intyy-review
git clone <intyy repo URL> intyy
git clone https://github.com/burpcat/intyy-bank.git kvfcu-bank
cd kvfcu-bank && git checkout 3652883e009cfeca8cabce7ac78cae1283aabb3f
```

(The URL and commit are the values in `intyy/bankapp.json`.)

**The bank app's `.env`.** Copy its `.env.example`, then set these:

| Option | Value |
|---|---|
| `KVFCU_TEST_MODE` | `1` |
| `KVFCU_FIXED_DATE` | `2026-01-15` |
| `KVFCU_VARIANT` | `keystone` |
| `KVFCU_DELAY_SCALE` | `1` |
| Teller, supervisor, and restricted users | Your choice of names and passwords |

Then start it. It serves `http://127.0.0.1:8080`.

```
make up
```

**intyy.**

```
cd ../intyy
npm ci
npx playwright install chromium
npm run build
npm link
cp .env.example .env
npm run bankapp:smoke
intyy staff whoami
intyy settings check --secrets
```

Fill in `.env` before the last three commands (see the next section).

## Keys and configuration

`.env` is git-ignored. intyy loads it at start. It never overrides a variable already set in your shell.

| Variable | Holds | Needed |
|---|---|---|
| `ANTHROPIC_API_KEY` | Claude key | Discovery only |
| `JEV_API_KEY` | jev key | Not used yet: no jev adapter is built. Leave empty |
| `INTYY_STAFF` | Your staff ID from `library/staff.json`: `op_017`, `op_022`, or `op_031`. Not a secret | Every command that writes |
| `INTYY_KEYSTONE_KVFCU_OPERATOR_USERNAME` | The bank app's teller user name | Replay, certify, discovery |
| `INTYY_KEYSTONE_KVFCU_OPERATOR_PASSWORD` | The teller's password | Replay, certify, discovery |
| `INTYY_KEYSTONE_REQUEST_INDEX_KEY_K1` | intyy's own 64-hex key for the request index | Replay, certify |

Make the index key once: `openssl rand -hex 32`.
Use the teller user from the bank app's `.env` (`KVFCU_TELLER_USER`, `KVFCU_TELLER_PASS`).

`intyy.json` holds these fields:

- `schema`: the file format, `intyy.config/1.0`.
- `library`: reviewed files, in git (`library`).
- `state`: runtime files, never in git (`state`).
- `publish`: where published evidence goes (`evidence`).
- `default_tenant`: the bank a command uses when `--tenant` is absent (`keystone`).
- `model_keys`: which variables hold the model keys.
- `canary_members`: reserved member numbers that must never reach any file.

**Where secrets never go.**

- Artifacts never hold a secret. They hold a name, such as `operator_password`.
- Logs and evidence never hold a secret or a raw sensitive value. Redaction runs at write time.
- The command line never holds an input value. Inputs come from a file or from standard input (`--inputs -`).

## Demo path

### Short path: no model key

This path replays the artifact the library ships.
*Supervised* means you confirm the start in the terminal. Answer `y` at the prompt.
Run `make reset` in `kvfcu-bank` first, for clean data.

| # | Command | Expect |
|---|---|---|
| 1 | `intyy replay kvfcu/open_share_subaccount@1 --mode supervised --inputs demo/valid.json` | `success`, with the new account number |
| 2 | `intyy replay kvfcu/open_share_subaccount@1 --mode supervised --inputs demo/missing.json` | `business_outcome`, `member_not_found`, exit 2 |
| 3 | `intyy replay kvfcu/open_share_subaccount@1 --mode supervised --inputs demo/bad.json` | `rejected`, `invalid_input`, exit 4 |
| 4 | `intyy certify case kvfcu/open_share_subaccount@1.0.0 --class valid --profile reply_lost` | `success`, commit `found_by_check` |

Step 4 matters because the bank's reply to Confirm was lost. A read-only check found what really happened.
`demo/` holds the input files. Its README lists them. All member numbers there are fake.

> TODO(owner): `library/` ships only `kvfcu/sign_in@1.0.0` today. The short path needs `open_share_subaccount@1.0.0` sealed and committed first (M05 owner tasks), and the certify suite sealed (M06).

### Full path: run the agent on a goal

The library ships `sign_in@1.0.0`. Discovery signs in first, by replay.

| # | Command | Expect |
|---|---|---|
| 1 | `intyy discover kvfcu/open_share_subaccount` | A real LLM run in a visible browser. Prints the run ID and a candidate ID |
| 2 | `intyy candidate review <candidate_id>` | You decide tags, risks, labels, and outcomes |
| 3 | `intyy candidate seal <candidate_id> --version <next>` | A sealed artifact |
| 4 | `intyy replay kvfcu/open_share_subaccount@1 --mode supervised --inputs demo/valid.json` | `success` |
| 5 | `intyy replay kvfcu/open_share_subaccount@1 --mode supervised --inputs demo/missing.json` | `business_outcome`, exit 2 |
| 6 | `intyy certify case kvfcu/open_share_subaccount@<next> --class valid --profile reply_lost` | `success`, `found_by_check` |

- The candidate ID looks like `kvfcu/open_share_subaccount/cand_<date>_<id>`. Pass it whole.
- `<next>` is a version that does not exist yet. `1.0.0` is sealed, so pick the next one. `intyy artifact list` shows what exists. `--version` is required today; the CLI does not propose a number.
- To record the two negative runs, run `intyy discover kvfcu/open_share_subaccount.missing --candidate <candidate_id>`. The `.at_limit` spec works the same way.
- Discovery pauses before each risky control and asks for approval. In a second terminal run `intyy operator list`, then `intyy operator show <run_id>`. Answer with `intyy operator decide <run_id> <decision>`. The request lists the allowed decisions.
- Every request says "irreversible". Ignore that word. Answer by the `control:` line in `intyy operator show <run_id>` (design section 4 §7.7):

| `control:` says | Decision |
|---|---|
| `"Submit"` | `approve_reversible` |
| `"Confirm"` | `approve_idempotent` |
| `"OK"` (the box) | `approve_irreversible`, the only one |
| anything else | `decline` |

- A takeover request allows `end_run` or `set_outcome` (with `--outcome <code>`) instead. See the handoff demo.
- Run `make reset` in `kvfcu-bank` before a demo.

## Handoff demo

Use two terminals. Run `make reset` first.
In the visible browser, the human works in the same session the bot used.

1. Terminal 1: `intyy certify case kvfcu/open_share_subaccount@1.0.0 --class valid --profile supervisor_needed --operator mailbox`
2. Terminal 2: `intyy operator list`, then `intyy operator claim <run_id>`.
3. In the browser, do the supervisor approval. Type the supervisor's credentials yourself. intyy never stores them.
4. Terminal 2: `echo "Supervisor approved." | intyy operator release <run_id>`. The note comes from standard input.
5. Terminal 1 prints the result: `success`, commit `confirmed`, one intervention.

The mailbox is a folder in the run's evidence folder. It records the claim, the release, and the human's actions, masked.

> TODO(owner): `supervisor_needed` is a suite extra case. It needs the certify suite sealed (M06) before this runs.

## Unattended path

*Unattended* means an agent calls the capability and no human watches. intyy rejects it until the key is certified and a human approves it.
A *key* is one exact version, like `kvfcu/open_share_subaccount@1.0.0`.
`--pin` is for supervised runs only. It runs one exact key, and it never grants trust.
Keys must be sealed first (see the full path). Use `INTYY_STAFF` or `--staff <id>` to pick who acts.

1. Before any approval, replay is rejected (exit 4):
   `intyy replay kvfcu/open_share_subaccount@1 --mode unattended --inputs demo/valid.json --authorization demo/auth.json`
2. Certify the key with a full batch, as the sealer (`op_017`). `--plan-only` prints the plan and contacts nothing:
   `intyy --staff op_017 certify kvfcu/sign_in@1.0.0`
3. Read the approval screen as another person (`op_022`). It ends with a record hash:
   `intyy --staff op_022 trust review kvfcu/sign_in@1.0.0`
4. Approve with that hash. Standard input is your note:
   `echo "Read the report." | intyy --staff op_022 trust approve kvfcu/sign_in@1.0.0 --expect-record sha256:<hash>`
   Add `--ack <step>` for each fragile step the review asks you to read.
5. Do steps 2 to 4 for each linked key, then for `kvfcu/open_share_subaccount@1.0.0`. The commit key waits for the keys it links.
6. Repeat step 1. Expect `success`, exit 0.

Once a key is approved, live runs score it. Three recipe failures in a row degrade it, and an unattended run is rejected again.
Restore it with `trust restore` after a new passing batch, or after you exclude the bad runs.

> Built, not proven: the full batches and approvals are not run yet. The owner runs them (M10 owner checks).

## Operating trust and drift

All commands below are built. The owner has not run them live. Reasons and notes come from standard input, never from a flag.

| Task | Commands |
|---|---|
| Certify | `certify <key> [--kind quick\|full\|regression] [--instance <facts>] [--plan-only]`; `certify case <key> --profile <id>`; `certify report <batch_id>`; `certify rerun <batch_id> <case_id>` |
| Read trust | `trust list [--state <state>]`; `trust show <key>`; `trust history <key>`; `trust review <key> [--batch <id>] [--full]` |
| Change trust | `trust approve`, `trust reject`, `trust restore`, `trust exclude <key> [run_ids...]`, `trust reinstate`, `trust demote`, `trust retire`, `trust rebuild [<key> \| --all] [--from-evidence]` |
| Reconciliation autonomy | `trust autonomy <key>` reads it. `trust autonomy <key> grant --expect-record <hash>` and `trust autonomy <key> revoke` need a reason on standard input |
| Alerts | `alert list [--state open\|acted\|dismissed]`; `alert show <id>`; `alert act <id>`; `alert dismiss <id>` |
| Drift | `drift report [--since <date>]` writes nothing |
| Majors | `major show <major>`; `major deprecate <major> --successor <n> --retires-on <date>`; `major seal <major>`; `major approve <major> --rev <n>` |
| Packs | `pack impact <scope> <rev>`; `certify <key> --kind regression --pack <scope>@<rev>` (or `--all-affected`); `pack draft list`; `pack draft show <id>` |
| jev | `thresholds edit\|check\|seal\|approve\|show <app> --jev <version>`; `jev report <app>`; `tags report <app>` |
| Operator | `operator dialog <run_id> accept\|dismiss` answers a native dialog during a takeover |

Example, a drill that breaks the button names (the owner restarts the bank app with `KVFCU_STRIP_SEMANTICS=1` first):
`intyy certify kvfcu/open_share_subaccount@1.0.0 --kind quick --instance strip_semantics=1`

## Running without live services

- The bank app is local. The only live services are the model APIs.
- `--models off` runs replay, certify, and reconcile with no model. Trouble that needs a model climbs to a human. Example: `intyy --models off replay kvfcu/open_share_subaccount@1 --mode supervised --inputs demo/valid.json`.
- Discovery needs a live model. `evidence/` holds real runs instead.
- CI uses fake twins. `npm run check` needs no key and no bank app.

## Tests

| Command | Needs | Covers |
|---|---|---|
| `npm run check` | Nothing live | Types, lint, structure rules, unit and type tests, schema freshness, docs check, repo audit |
| `npm run audit` | Git only | No brief PDF, `.env`, `state/`, trace, HAR, video, cookie, or canary in the tree or history. Part of `check` |
| `npm run test:live` | The bank app, in test mode | Surface, guard, replay, faults, handoff |
| `npm run test:safety` | Nothing live | Safety and canary tests. Writes `evidence/tests/safety.json` |

Live tests take the instance lock and run one at a time (`docs/design/CONTRACT.md` §2).

## Evidence

`evidence/` holds published copies of real runs, sealed artifacts, and the safety report. `evidence/README.md` indexes it.
Publish with `intyy evidence publish <targets...>`. A target is a run ID, a batch ID, or a trust key. Add `--with-runs all` to publish every run of a batch, not only the ones that did not pass. Check with `intyy evidence verify`. Verify checks hashes, links, forbidden files, and canaries.

| Item | Shows |
|---|---|
| A1 | `sign_in` discovery, a real LLM run |
| A3 | `open_share_subaccount` discovery, with the irreversible approval |
| A5 | Replay success |
| A6 | Replay `member_not_found`, exit 2 |
| A8 | Reply lost, found by a read-only check |
| A11 | Live handoff |

Links to each file are in `evidence/README.md`. Status today: pending. See the index.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Done. For runs: `success`. For certify: gate passed or batch complete |
| 1 | Usage error, or intyy failed to produce an answer |
| 2 | Run ended in `business_outcome` |
| 3 | Run not final: `running` or `escalated` (`run status` only) |
| 4 | Run `rejected` |
| 5 | Run `failed`, or a certify gate failed |
| 6 | Refused by a rule: role, four eyes, second look, freshness, a changed record |
| 7 | A file failed its schema or loader checks |
| 8 | Busy: a lock is held |

## Troubleshooting

- **Exit 8, busy:** another run holds the instance lock. The message names it.
- **`secret_unavailable`:** a bound variable is empty. Run `intyy settings check --secrets`.
- **`npm run bankapp:smoke` fails:** the app is down, or test mode is off.
- **A run hangs at the start:** a supervised run waits for your confirmation.
- **After a crash:** run `intyy run sweep`. Then run the `reconcile` command it prints.

## Further reading

- [REPORT.md](REPORT.md): the design write-up.
- [docs/design/](docs/design/): sections 1 to 10. Section 1 is the overview.
- [docs/milestones/](docs/milestones/): how it was built, with each gate.
