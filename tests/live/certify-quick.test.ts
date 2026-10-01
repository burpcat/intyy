// Proves, on the live bank app, that a `quick` certify batch on keystone with the instance flag
// off passes: `certify kvfcu/open_share_subaccount@1.0.0 --kind quick`, no `--instance`. The
// gate passes and the batch is no drill (design section 8 §7.1; section 9 §9.1, §9.2). Needs the
// owner's sealed artifact, approved suite, test data, faults, and packs: until they exist,
// `beforeAll` fails with one message naming what is missing. Never skips. The instance lock is
// held for the file. M08 gate row "A quick batch on keystone, flag off, passes".
import { afterAll, beforeAll, expect, test } from "vitest";
import type { LockHold } from "../../src/ports/locks.js";
import { acquireInstanceLock, locks } from "./replay-demo-kit.js";
import { QUICK_TIMEOUT_MS, certifyQuick, requireCertifyPrereqs, type QuickRun } from "./certify-kit.js";

let hold: LockHold | null = null;
let batch: QuickRun | null = null;

beforeAll(async () => {
  await requireCertifyPrereqs();
  hold = await acquireInstanceLock("test:live certify-quick");
}, 60_000);

afterAll(async () => {
  if (batch !== null) await batch.remove();
  if (hold !== null) await locks.release(hold);
});

test(
  "a quick batch with no --instance passes the gate and is not a drill",
  async () => {
    batch = await certifyQuick();
    expect(batch.report.gate.passed).toBe(true);
    expect(batch.code).toBe(0);
    expect(batch.report.drill).toBeUndefined();
    expect(batch.plan.drill).toBeUndefined();
    expect(batch.plan.declaration).toBeUndefined();
    expect(batch.plan.kind).toBe("quick");
    expect(batch.report.cases.map((c) => c.case_id)).toContain("baseline");
  },
  QUICK_TIMEOUT_MS,
);
