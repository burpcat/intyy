// Proves demo path step 6 (design section 9 §13.2 row 6): `intyy certify case
// kvfcu/open_share_subaccount@1.0.0 --class valid --profile reply_lost` ends `success`, commit
// `found_by_check`. The bank commits, the reply is lost, and a read-only check finds the account
// (section 5 §14 last row; section 7 §11; section 8 §6.3, `reconciles_found`). The oracle agrees:
// one account exists. Until the owner's steps are done, `beforeAll` fails with one message naming
// what is missing. Never skips. M06 task 12.
import { afterAll, beforeAll, expect, test } from "vitest";
import type { LockHold } from "../../src/ports/locks.js";
import { acquireInstanceLock, locks } from "./replay-demo-kit.js";
import {
  CASE_TIMEOUT_MS,
  certifyCase,
  requireCertifyPrereqs,
  type CaseRun,
} from "./certify-kit.js";

let hold: LockHold | null = null;
let run: CaseRun | null = null;

beforeAll(async () => {
  await requireCertifyPrereqs();
  hold = await acquireInstanceLock("test:live demo-step6");
}, CASE_TIMEOUT_MS);

afterAll(async () => {
  if (run !== null) await run.remove();
  if (hold !== null) await locks.release(hold);
});

test(
  "reply_lost on open_share_subaccount: success, found_by_check",
  async () => {
    run = await certifyCase("reply_lost");
    const c = run.report.cases[0];
    expect(c?.result).toEqual({ status: "success", detail: null });
    expect(run.plan.pin).toBe("kvfcu/open_share_subaccount@1.0.0");
    expect(run.commit).toBe("found_by_check");
    expect(c?.truth.commit?.match).toBe(true);
    expect(c?.verdict).toBe("pass");
    expect(run.code).toBe(0);
  },
  CASE_TIMEOUT_MS,
);
