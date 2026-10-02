// Proves demo path step 6, changed by the owner's waiver decision (docs/decisions.md, 2026-09-30,
// M05). Section 9 §13.2 row 6 assumed a read-only check: `intyy certify case
// kvfcu/open_share_subaccount@1.0.0 --class valid --profile reply_lost` ending `success`, commit
// `found_by_check`. The app shows no account notes, so `open_share_subaccount@1.0.0` has a
// reconciliation WAIVER and no check exists. This test now proves the lost-reply path ends at a
// human decision: the bank commits, the reply is lost, the run asks `reconciliation_decision`
// (reason `reconciliation_waived`, section 3 §5.7; section 2 §16.3), and the scripted operator
// gives no answer, so the case records the escalation and the run ends (section 8 §7.6). The
// commit stays `uncertain` (section 3 §5.12, the worst case). Commit truth may not judge it
// `false`: `uncertain` claims nothing, and with no notes input it is unavailable (section 8 §8.2).
// For a waived artifact certify expects exactly this ending, so the verdict is `pass` and the
// report case is marked `waived` (docs/decisions.md, 2026-09-30, M06; section 8 §8.3). Until the owner's steps are done,
// `beforeAll` fails with one message naming what is missing. Never skips. M06 task 12.
import { afterAll, beforeAll, expect, test } from "vitest";
import type { LockHold } from "../../src/ports/locks.js";
import { acquireInstanceLock, locks } from "./replay-demo-kit.js";
import {
  CASE_TIMEOUT_MS,
  KEY,
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
  "reply_lost on open_share_subaccount: escalated at reconciliation_decision, commit uncertain",
  async () => {
    run = await certifyCase("reply_lost");
    const c = run.report.cases[0];
    expect(c?.result.status).toBe("escalated");
    expect(c?.result.detail).toMatch(/^reconciliation_decision\/reconciliation_waived\/.+$/);
    expect(run.plan.pin).toBe(KEY);
    expect(run.commit).toBe("uncertain");
    expect(c?.truth.commit?.match).not.toBe(false);
    expect(c?.verdict).toBe("pass");
    expect(c?.waived).toBe(true);
  },
  CASE_TIMEOUT_MS,
);
