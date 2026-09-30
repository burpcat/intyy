# Demo files

These files feed `intyy replay` for the demo path (design section 9 §13.2).
Each holds the `--inputs` or `--authorization` body for
`kvfcu/open_share_subaccount@1`.

| File | Use | Expected result |
|---|---|---|
| `valid.json` | `--inputs` | `success`, with the account number |
| `missing.json` | `--inputs` | `business_outcome`, `member_not_found`, exit 2 |
| `at_limit.json` | `--inputs` | `business_outcome`, commit `refused` (or `not_sent`) |
| `bad.json` | `--inputs` | `rejected`, `invalid_input`, exit 4 |
| `auth.json` | `--authorization` | An example consent block, `intyy.request/1.0` shape |

The member numbers are demo data. They are not the numbers from the real
discovery runs (build plan, M05), so demo and discovery data never mix.
None of these files use the canary member listed in `intyy.json`
(`canary_members`). It never appears in a spec, a fixture, or a demo file.

**Note for the owner:** `member_id` and `deposit` are the input names from
the section 2 §21 full example. The real contract for
`kvfcu/open_share_subaccount@1.0.0` is not sealed yet. Once the owner seals
it, check these names against the sealed contract. Rename the fields in
these files if the sealed contract uses different names.
