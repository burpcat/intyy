// Proves the M09 live rows on the live bank app, with the reviewer faked (design section 5 §8.7,
// §8.8, §14; section 8 §7.1, §8.3): the fault table still passes with rung 3 switched on, and
// `unknown_popup` now ends `recovers_or_escalates` through the ladder, with a rung 3 `ladder`
// line by the reviewer. Each case is one `certify case` call, as in fault-table.test.ts, with the
// policy switches on (the real library policy has `replay_reviewer: true`) and a table reviewer
// that the TEST swaps into the wiring: it never reaches production wiring, and no call leaves the
// machine (the key variable holds a made-up value).
// Rung 2 (jev) is not exercised here: the CLI has no jev seam (no adapter exists, section 5
// §10.9), so a certify batch built by the CLI never holds a classifier. A test of jev needs a seam.
// The reviewer's script gives up on every call, so an unknown popup ends in the human handback
// (scripted operator: end the run), which is `escalated`.
// Until the owner's steps are done, `beforeAll` fails with one message naming what is missing.
// Never skips. M09 live rows.
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { TableReviewer, type ReviewerScript } from "../../src/fakes/table-reviewer.js";
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

beforeAll(async () => {
  await requireCertifyPrereqs();
  hold = await acquireInstanceLock("test:live fault-table-models");
  const found = await faultSteps();
  ({ windowStep, commitStep } = found);
  cleanups.push(found.replyLost.remove);
}, CASE_TIMEOUT_MS);

afterAll(async () => {
  for (const c of cleanups.splice(0)) await c();
  if (hold !== null) await locks.release(hold);
});

const GIVE_UP: ReviewerScript = {
  fixStep: [{ when: {}, reply: { answer: { give_up: true, reason: "The popup is not one I can close safely." } } }],
};

/** Runs one case with the reviewer on, and returns it with the reviewer that was asked. */
async function runWithModels(profile: string, at?: string): Promise<{ run: CaseRun; reviewer: TableReviewer }> {
  const reviewer = new TableReviewer(GIVE_UP);
  const run = await certifyCase(profile, at, { wire: { reviewer: () => reviewer } });
  cleanups.push(run.remove);
  return { run, reviewer };
}

/** The profile's own expected ending held: verdict `pass`, gate passed, exit 0. */
function expectJudgedPass(r: CaseRun): void {
  expect(r.report.cases[0]?.verdict).toBe("pass");
  expect(r.report.gate.passed).toBe(true);
  expect(r.code).toBe(0);
}

describe("the fault table still passes with the reviewer switched on", () => {
  test(
    "server_error: recovers at rung 1, success",
    async () => {
      const { run } = await runWithModels("server_error", windowStep);
      expect(run.report.cases[0]?.result).toEqual({ status: "success", detail: null });
      expectJudgedPass(run);
    },
    CASE_TIMEOUT_MS,
  );

  test(
    "maintenance: failed app_error",
    async () => {
      const { run } = await runWithModels("maintenance", windowStep);
      expect(run.report.cases[0]?.result).toEqual({ status: "failed", detail: "app_error" });
      expectJudgedPass(run);
    },
    CASE_TIMEOUT_MS,
  );

  test(
    "known_popup: the kyc_reminder handler still clicks Remind Later",
    async () => {
      const { run } = await runWithModels("known_popup", windowStep);
      expect(run.report.cases[0]?.result).toEqual({ status: "success", detail: null });
      expect(run.recoveries).toContainEqual({ via: "handler", ref: "kyc_reminder" });
      expectJudgedPass(run);
    },
    CASE_TIMEOUT_MS,
  );

  test(
    "session_expire: sign_in recovers the lost session",
    async () => {
      const { run } = await runWithModels("session_expire", windowStep);
      expect(run.report.cases[0]?.result).toEqual({ status: "success", detail: null });
      expect(run.recoveries).toContainEqual({ via: "handler", ref: "session_expired" });
      expectJudgedPass(run);
    },
    CASE_TIMEOUT_MS,
  );

  test(
    "server_error on Confirm: the waiver still sends it to a human, commit uncertain, verdict pass",
    async () => {
      const { run } = await runWithModels("server_error", commitStep);
      const c = run.report.cases[0];
      expect(c?.result).toEqual({
        status: "escalated",
        detail: `reconciliation_decision/reconciliation_waived/${commitStep}`,
      });
      expect(run.commit).toBe("uncertain");
      expect(c?.verdict).toBe("pass");
      expect(c?.waived).toBe(true);
    },
    CASE_TIMEOUT_MS,
  );
});

describe("unknown_popup through the ladder", () => {
  test(
    "ends recovers_or_escalates, with a rung 3 ladder line by the reviewer, and the verdict is pass",
    async () => {
      const { run, reviewer } = await runWithModels("unknown_popup", windowStep);
      const c = run.report.cases[0];
      // Either ending is the profile's rule: the reviewer's fix recovered, or the human handback.
      expect(["success", "escalated"]).toContain(c?.result.status);
      expect(run.ladder.some((l) => l.rung === 2 || l.rung === 3)).toBe(true);
      expect(run.ladder.some((l) => l.rung === 3 && l.by === "reviewer")).toBe(true);
      expect(reviewer.seen.length).toBeGreaterThan(0);
      // Help the case expects is not `assisted`: the profile says it may escalate.
      expectJudgedPass(run);
    },
    CASE_TIMEOUT_MS,
  );
});
