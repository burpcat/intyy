// Proves the M09 live rows on the live bank app, with the reviewer faked (design section 5 §8.7,
// §8.8, §14; section 8 §7.1, §8.3): the fault table still passes with rung 3 switched on, and
// `unknown_popup` now ends `recovers_or_escalates` through the ladder, with a rung 3 `ladder`
// line by the reviewer. Each case is one `certify case` call, as in fault-table.test.ts, with the
// policy switches on (the real library policy has `replay_reviewer: true`) and a table reviewer
// that the TEST swaps into the wiring: it never reaches production wiring, and no call leaves the
// machine (the key variable holds a made-up value).
// Rung 2 (jev) has its own describe blocks below: the wiring has a seam for it (`classifier` and
// `jevVersion`, like `reviewer`), so the TEST swaps in a table classifier, with a made-up
// TYPESAFE_API_KEY, and the real jev adapter is never built. Policy `replay_jev` is on in the real
// library's global policy, which the temp data root links read-only. The kit deletes any real key
// `.env` holds for a model with no fake, so no case can reach a live model.
// The reviewer's script gives up on every call, so an unknown popup ends in the human handback
// (scripted operator: end the run), which is `escalated`. jev's table answers `needs_review` and
// `unclear` with low confidence, so it never decides an outcome and never says "found"; it only sorts.
// Until the owner's steps are done, `beforeAll` fails with one message naming what is missing.
// Never skips. M09 live rows.
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { TableClassifier, type ClassifierScript } from "../../src/fakes/table-classifier.js";
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

/** The pinned version the real wiring reports. A fake jev reports it too, so the freeze matches. */
const JEV_VERSION = "jev-1.13.0";

/** jev never decides here: low confidence, so every answer climbs or goes to a human. */
const JEV_UNSURE: ClassifierScript = {
  trouble: [{ when: {}, reply: { answer: { bucket: "needs_review", handler: null, outcome: null, confidence: 0.5 } } }],
  reconcile: [{ when: {}, reply: { answer: { verdict: "unclear", confidence: 0.5 } } }],
};

/** The reviewer for the jev cases: gives up on a fix, and has no opinion on a reconciliation. */
const REVIEWER_WITH_OPINION: ReviewerScript = {
  ...GIVE_UP,
  secondOpinion: [{ when: {}, reply: { answer: { verdict: "unclear", confidence: 0.5 } } }],
};

/** Runs one case with jev and the reviewer both faked, and returns it with the fakes that were asked. */
async function runWithJev(
  profile: string,
  at?: string,
): Promise<{ run: CaseRun; reviewer: TableReviewer; jev: TableClassifier }> {
  const reviewer = new TableReviewer(REVIEWER_WITH_OPINION);
  const jev = new TableClassifier(JEV_UNSURE);
  const run = await certifyCase(profile, at, {
    wire: { reviewer: () => reviewer, classifier: () => jev, jevVersion: JEV_VERSION },
  });
  cleanups.push(run.remove);
  return { run, reviewer, jev };
}

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
      expect(run.recoveries).toContainEqual(expect.objectContaining({ via: "handler", ref: "kyc_reminder" }));
      expectJudgedPass(run);
    },
    CASE_TIMEOUT_MS,
  );

  test(
    "session_expire: sign_in recovers the lost session",
    async () => {
      const { run } = await runWithModels("session_expire", windowStep);
      expect(run.report.cases[0]?.result).toEqual({ status: "success", detail: null });
      expect(run.recoveries).toContainEqual(expect.objectContaining({ via: "handler", ref: "session_expired" }));
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

describe("the fault table still passes with jev and the reviewer faked", () => {
  test(
    "server_error: recovers at rung 1, success",
    async () => {
      const { run } = await runWithJev("server_error", windowStep);
      expect(run.report.cases[0]?.result).toEqual({ status: "success", detail: null });
      expectJudgedPass(run);
    },
    CASE_TIMEOUT_MS,
  );

  test(
    "maintenance: failed app_error",
    async () => {
      const { run } = await runWithJev("maintenance", windowStep);
      expect(run.report.cases[0]?.result).toEqual({ status: "failed", detail: "app_error" });
      expectJudgedPass(run);
    },
    CASE_TIMEOUT_MS,
  );

  test(
    "known_popup: the kyc_reminder handler still clicks Remind Later",
    async () => {
      const { run } = await runWithJev("known_popup", windowStep);
      expect(run.report.cases[0]?.result).toEqual({ status: "success", detail: null });
      expect(run.recoveries).toContainEqual(expect.objectContaining({ via: "handler", ref: "kyc_reminder" }));
      expectJudgedPass(run);
    },
    CASE_TIMEOUT_MS,
  );

  test(
    "session_expire: sign_in recovers the lost session",
    async () => {
      const { run } = await runWithJev("session_expire", windowStep);
      expect(run.report.cases[0]?.result).toEqual({ status: "success", detail: null });
      expect(run.recoveries).toContainEqual(expect.objectContaining({ via: "handler", ref: "session_expired" }));
      expectJudgedPass(run);
    },
    CASE_TIMEOUT_MS,
  );

  test(
    "server_error on Confirm: an unclear reconciliation still goes to a human, commit uncertain, verdict pass",
    async () => {
      const { run } = await runWithJev("server_error", commitStep);
      const c = run.report.cases[0];
      // Only plain code may say "nothing changed": jev's `unclear` never ends the run on its own.
      expect(c?.result.status).toBe("escalated");
      expect(c?.result.detail).toMatch(/^reconciliation_decision\//);
      expect(run.commit).toBe("uncertain");
      expect(c?.verdict).toBe("pass");
    },
    CASE_TIMEOUT_MS,
  );
});

describe("unknown_popup through rungs 2 and 3, both faked", () => {
  test(
    "ends recovers_or_escalates, with a rung 2 line by jev and a rung 3 line by the reviewer, verdict pass",
    async () => {
      const { run, reviewer, jev } = await runWithJev("unknown_popup", windowStep);
      const c = run.report.cases[0];
      expect(["success", "escalated"]).toContain(c?.result.status);
      expect(run.ladder.some((l) => l.rung === 2 && l.by === "jev")).toBe(true);
      expect(run.ladder.some((l) => l.rung === 3 && l.by === "reviewer")).toBe(true);
      expect(jev.seen.length).toBeGreaterThan(0);
      expect(reviewer.seen.length).toBeGreaterThan(0);
      expectJudgedPass(run);
    },
    CASE_TIMEOUT_MS,
  );
});
