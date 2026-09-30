// Proves every named-fault row of design section 5 §14 that has a rung 1 answer ends as the
// table says, on the live bank app, with a fixed seed (one batch ID, so the case seed repeats).
// Each case is one `certify case` call: a clean baseline, then one fault (section 8 §6.3, §7.4).
// Also proves: `unknown_popup` ends `escalated` (rungs 2 and 3 are off; that is
// `recovers_or_escalates`), and the prelude case, where `session_expire` at a task step is
// recovered by `sign_in` and the task then resumes (section 7 §10). `blank`, `hang`,
// `unavailable`, and `logout` stay CI-only (docs/decisions.md, M06: CONTRACT §6 names no kind
// for them). `supervisor_required` has no standard profile: its handback needs a human.
// Until the owner's steps are done, `beforeAll` fails with one message naming what is missing.
// Never skips. M06 task 12.
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { LockHold } from "../../src/ports/locks.js";
import { acquireInstanceLock, locks } from "./replay-demo-kit.js";
import {
  CASE_TIMEOUT_MS,
  certifyCase,
  faultSteps,
  requireCertifyPrereqs,
  type CaseRun,
} from "./certify-kit.js";

let hold: LockHold | null = null;
const cleanups: (() => Promise<void>)[] = [];
let windowStep = "";
let commitStep = "";
let replyLost: CaseRun | null = null;

beforeAll(async () => {
  await requireCertifyPrereqs();
  hold = await acquireInstanceLock("test:live fault-table");
  const found = await faultSteps();
  ({ windowStep, commitStep, replyLost } = found);
  cleanups.push(found.replyLost.remove);
}, CASE_TIMEOUT_MS);

afterAll(async () => {
  for (const c of cleanups.splice(0)) await c();
  if (hold !== null) await locks.release(hold);
});

/** Runs one case, and queues its temp root for removal. */
async function run(profile: string, at?: string): Promise<CaseRun> {
  const r = await certifyCase(profile, at);
  cleanups.push(r.remove);
  return r;
}

/** The profile's own expected ending held: verdict `pass`, gate passed, exit 0. */
function expectJudgedPass(r: CaseRun): void {
  expect(r.report.cases[0]?.verdict).toBe("pass");
  expect(r.report.gate.passed).toBe(true);
  expect(r.code).toBe(0);
}

describe("window open: an idempotent step (section 5 §14, middle column)", () => {
  test(
    "server_error: back to the last good page, resume, success",
    async () => {
      const r = await run("server_error", windowStep);
      expect(r.report.cases[0]?.result).toEqual({ status: "success", detail: null });
      expect(r.recoveries.length).toBeGreaterThanOrEqual(1);
      expectJudgedPass(r);
    },
    CASE_TIMEOUT_MS,
  );

  test(
    "maintenance: failed app_error (transient)",
    async () => {
      const r = await run("maintenance", windowStep);
      expect(r.report.cases[0]?.result).toEqual({ status: "failed", detail: "app_error" });
      expectJudgedPass(r);
    },
    CASE_TIMEOUT_MS,
  );

  test(
    "known_popup: kyc_reminder clicks Remind Later, the request re-sends, success",
    async () => {
      const r = await run("known_popup", windowStep);
      expect(r.report.cases[0]?.result).toEqual({ status: "success", detail: null });
      expect(r.recoveries).toContainEqual({ via: "handler", ref: "kyc_reminder" });
      expectJudgedPass(r);
    },
    CASE_TIMEOUT_MS,
  );

  test(
    "unknown_popup: ends escalated (rungs 2 and 3 are off), which is recovers_or_escalates",
    async () => {
      const r = await run("unknown_popup", windowStep);
      expect(r.report.cases[0]?.result.status).toBe("escalated");
      expectJudgedPass(r);
    },
    CASE_TIMEOUT_MS,
  );

  test(
    "the prelude: session_expire at a task step, sign_in recovers the lost session, the task resumes and succeeds",
    async () => {
      const r = await run("session_expire", windowStep);
      expect(r.report.cases[0]?.result).toEqual({ status: "success", detail: null });
      expect(r.recoveries).toContainEqual({ via: "handler", ref: "session_expired" });
      expectJudgedPass(r);
    },
    CASE_TIMEOUT_MS,
  );
});

// Why these two rows differ from section 5 §14: the owner chose a reconciliation waiver for
// open_share_subaccount (docs/decisions.md, 2026-09-30, M05), so no check exists. Every failed
// commit goes straight to a human (section 2 §16.3). The scripted operator gives no answer, the
// case records the escalation, and the run ends with the commit `uncertain` (section 8 §7.6;
// section 3 §5.12). Certify expects exactly this ending for a waived artifact (docs/decisions.md,
// 2026-09-30, M06), so the verdict is `pass` and the report case is marked `waived`.
describe("window closed: right after Confirm, with a waiver (section 5 §14, right column)", () => {
  /** Ended at the human decision, commit uncertain, nothing judged false. */
  function expectWaivedEnding(r: CaseRun): void {
    const c = r.report.cases[0];
    expect(c?.result).toEqual({
      status: "escalated",
      detail: `reconciliation_decision/reconciliation_waived/${commitStep}`,
    });
    expect(r.commit).toBe("uncertain");
    expect(c?.truth.commit?.match).not.toBe(false);
    expect(c?.verdict).toBe("pass");
    expect(c?.waived).toBe(true);
  }

  test(
    "drop_after_confirm: the waiver sends the lost reply to a human: escalated, commit uncertain",
    () => {
      // The same case the step lookup already ran (fixed seed), so it is not run twice.
      const r = replyLost;
      if (r === null) throw new Error("the reply_lost case did not run in beforeAll");
      expectWaivedEnding(r);
    },
    CASE_TIMEOUT_MS,
  );

  test(
    "server_error on Confirm: the waiver sends it to a human: escalated, commit uncertain",
    async () => {
      expectWaivedEnding(await run("server_error", commitStep));
    },
    CASE_TIMEOUT_MS,
  );
});
