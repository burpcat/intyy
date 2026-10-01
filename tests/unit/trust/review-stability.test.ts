// Proves the approval screen's stability line (design section 9 §9.3's example screen; section 8
// §9.3 the curve; build decision of M10 task 10): a batch report with a curve prints one entry per
// level (`<level>: <pass>% pass`, then unexplained, assisted, or wrong counts) and the worst twin
// mismatch with its level; a report with no curve, or an empty one, prints `not run`. No files, no
// clock. M10 task 10.
import { describe, expect, test } from "vitest";
import { BatchReport, type StabilityLevel } from "../../../src/core/model/batch-report.js";
import { hashJson } from "../../../src/core/model/canonical.js";
import { buildReview, type ReviewFacts } from "../../../src/core/trust/approval.js";
import { rebuild } from "../../../src/core/trust/rebuild.js";
import { batch, h, HASHES, KEY, SCORES } from "./kit.js";

const level = (entropy: number, over: Partial<StabilityLevel> = {}): StabilityLevel => ({
  entropy, runs: 5, pass: 1, explained: 0, assisted: 0, unexplained: 0, wrong: 0, faults: 0, rungs: { "1": 0, "2": 0, "3": 0 }, escalations: {}, twin_mismatch: 0, ...over,
});

/** Review facts for a passing full batch whose report carries `stability`. */
function factsWith(stability: StabilityLevel[] | null | undefined): ReviewFacts {
  const report = BatchReport.parse({
    schema: "intyy.batch_report/1.0",
    batch_id: "batch_a",
    tenant: "keystone",
    app: "kvfcu",
    capability: "kvfcu/open_share_subaccount@1",
    ended_at: "2026-01-15T09:00:00.000Z",
    kind: "full",
    cases: [{ case_id: "baseline_1", run_id: "run_1", class: "valid", result: { status: "success", detail: null }, truth: {}, verdict: "pass" }],
    gate: { passed: true, rules: { complete: true, no_wrong: true, baseline: true, matrix: true, extra: true, no_void: true } },
    ...(stability === undefined ? {} : { stability }),
  });
  const rec = rebuild(KEY, HASHES, [batch(1, "batch_a", { report_hash: hashJson(report), scores: SCORES })]);
  if (!rec.ok) throw new Error("test setup: rebuild failed");
  return {
    key: KEY,
    record: rec.value,
    batchId: "batch_a",
    report,
    now: { engine: "0.4.0", handlerSet: h("handlers") },
    artifactSealed: true,
    links: [],
    sealer: "op_017",
    who: { staff: "op_022", roles: ["approver"] },
    decisions: [],
    prior: [],
  };
}

describe("the review screen's stability line", () => {
  test("a curve prints each level, its unexplained count, and the worst twin mismatch with its level", () => {
    const curve = [level(0.05), level(0.3, { pass: 0.8, unexplained: 0.2, twin_mismatch: 0.2 })];
    expect(buildReview(factsWith(curve)).stability).toBe("0.05: 100% pass   0.3: 80% pass, 1 unexplained   twins 0.2 at 0.3");
  });

  test("assisted and wrong runs are named; a clean curve says no twin mismatch level", () => {
    const text = buildReview(factsWith([level(0.15, { pass: 0.6, assisted: 0.2, unexplained: 0.2, wrong: 1 })])).stability;
    expect(text).toContain("0.15: 60% pass");
    expect(text).toContain("1 unexplained");
    expect(text).toContain("1 assisted");
    expect(text).toContain("1 WRONG");
    expect(buildReview(factsWith([level(0.05)])).stability).toBe("0.05: 100% pass   twins 0");
  });

  test("a report with no curve, a null curve, or an empty one says not run", () => {
    for (const stability of [undefined, null, []]) {
      expect(buildReview(factsWith(stability)).stability).toBe("not run");
    }
  });
});
