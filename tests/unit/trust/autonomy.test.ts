// Proves reconciliation autonomy as pure rules (design section 8 §14.2, section 5 §10.6): the ready
// rule (20 correct, 5+ found, 5+ not_found, zero wrong), `unclear` never right or wrong, the fold of
// autonomy history lines into the record (earned adds, a new scope starts over, revoked zeroes,
// granted needs ready and a person), a granted record read under another scope is revoked, the live
// spot check is stable per run and about 1 in 20, and a certify batch's labels make an earned line,
// a revoked line on any wrong answer, or no line for a drill, regression, or jev-less batch.
// No files. M11 task 6.
import { describe, expect, test } from "vitest";
import { BatchReport, type JevCall } from "../../../src/core/model/batch-report.js";
import type { HistoryLine } from "../../../src/core/model/score-history.js";
import type { AutonomyCounts, AutonomyScope } from "../../../src/core/model/score.js";
import {
  countCalls,
  describeAutonomy,
  evidenceLine,
  foldAutonomy,
  grantedFor,
  isReady,
  labelCall,
  spotChecked,
  stateFor,
  type AutonomyLine,
} from "../../../src/core/trust/autonomy.js";
import { rebuild } from "../../../src/core/trust/rebuild.js";
import { approved, batch, HASHES, KEY } from "./kit.js";

const SCOPE: AutonomyScope = { check: "kvfcu/find_account_by_reference@1.0.0", check_patch: null, jev: "jev@fake" };
const OTHER_CHECK: AutonomyScope = { ...SCOPE, check: "kvfcu/find_account_by_reference@1.1.0" };
const OTHER_JEV: AutonomyScope = { ...SCOPE, jev: "jev@next" };

const counts = (over: Partial<AutonomyCounts> = {}): AutonomyCounts => ({ correct: 0, found: 0, not_found: 0, wrong: 0, unclear: 0, ...over });
const HALF = counts({ correct: 10, found: 5, not_found: 5 });

const at = (minute: number): string => `2026-01-15T10:${String(minute).padStart(2, "0")}:00.000Z`;

function earned(minute: number, batchId: string, c: AutonomyCounts, scope: AutonomyScope = SCOPE): AutonomyLine {
  return { event: "autonomy", at: at(minute), by: "certify", reason: `batch ${batchId}`, action: "earned", evidence: [batchId], scope, counts: c };
}
const granted = (minute: number, by = "op_022"): AutonomyLine => ({ event: "autonomy", at: at(minute), by, reason: "Evidence is complete.", action: "granted", evidence: [] });
const revoked = (minute: number, by = "system", scope?: AutonomyScope): AutonomyLine => ({
  event: "autonomy",
  at: at(minute),
  by,
  reason: "Spot check disagreed.",
  action: "revoked",
  evidence: [],
  ...(scope === undefined ? {} : { scope }),
});

/** The record's autonomy after `lines`, through the real rebuild. */
function autonomyOf(lines: HistoryLine[]) {
  const r = rebuild(KEY, HASHES, lines);
  if (!r.ok) throw new Error(`test setup: rebuild failed: ${r.detail ?? r.failure}`);
  return r.value.autonomy;
}

describe("isReady", () => {
  test("20 correct with 20 found and no not_found is not ready: a jev that always says found earns nothing alone", () => {
    expect(isReady(counts({ correct: 20, found: 20, not_found: 0 }))).toBe(false);
  });

  test("15 found and 5 not_found, no wrong, is ready", () => {
    expect(isReady(counts({ correct: 20, found: 15, not_found: 5 }))).toBe(true);
  });

  test("any wrong answer is not ready", () => {
    expect(isReady(counts({ correct: 20, found: 15, not_found: 5, wrong: 1 }))).toBe(false);
  });

  test("19 correct, or 4 of one kind, is not ready; unclear does not matter", () => {
    expect(isReady(counts({ correct: 19, found: 14, not_found: 5 }))).toBe(false);
    expect(isReady(counts({ correct: 20, found: 16, not_found: 4 }))).toBe(false);
    expect(isReady(counts({ correct: 20, found: 10, not_found: 10, unclear: 50 }))).toBe(true);
  });
});

describe("labelCall, countCalls", () => {
  test("an answer is right when it equals the truth, wrong when it does not", () => {
    expect(labelCall("found", "found")).toBe("right");
    expect(labelCall("not_found", "not_found")).toBe("right");
    expect(labelCall("found", "not_found")).toBe("wrong");
    expect(labelCall("not_found", "found")).toBe("wrong");
  });

  test("unclear is never right or wrong, whatever the truth", () => {
    expect(labelCall("unclear", "found")).toBe("below_threshold");
    expect(labelCall("unclear", "not_found")).toBe("below_threshold");
  });

  test("counting: right adds to correct and its kind, wrong to wrong, unclear only to unclear", () => {
    const calls: Pick<JevCall, "answer" | "label">[] = [
      { answer: "found", label: "right" },
      { answer: "found", label: "right" },
      { answer: "not_found", label: "right" },
      { answer: "found", label: "wrong" },
      { answer: "unclear", label: "below_threshold" },
    ];
    expect(countCalls(calls)).toEqual({ correct: 3, found: 2, not_found: 1, wrong: 1, unclear: 1 });
    expect(countCalls([])).toEqual(counts());
  });
});

describe("foldAutonomy through rebuild", () => {
  test("two earned lines reach ready; one does not", () => {
    expect(autonomyOf([earned(1, "batch_a", HALF)])).toMatchObject({ state: "earning", evidence: { correct: 10, found: 5, not_found: 5, batches: ["batch_a"] } });
    const two = autonomyOf([earned(1, "batch_a", HALF), earned(2, "batch_b", HALF)]);
    expect(two).toMatchObject({ state: "ready", ...SCOPE, evidence: { correct: 20, found: 10, not_found: 10, wrong: 0, batches: ["batch_a", "batch_b"] }, granted: null, revoked: null });
  });

  test("unclear counts add up but never help ready", () => {
    const a = autonomyOf([earned(1, "batch_a", counts({ unclear: 30 }))]);
    expect(a).toMatchObject({ state: "earning", evidence: { correct: 0, unclear: 30 } });
  });

  test("granted needs ready and a staff ID", () => {
    const ready = [earned(1, "batch_a", HALF), earned(2, "batch_b", HALF)];
    expect(autonomyOf([...ready, granted(3)])).toMatchObject({ state: "granted", granted: { by: "op_022" }, revoked: null });

    // `foldAutonomy` names the rule; `rebuild` wraps any such failure as a bad history.
    const readyRecord = autonomyOf(ready);
    expect(foldAutonomy(autonomyOf([earned(1, "batch_a", HALF)]), granted(2))).toMatchObject({ ok: false, failure: "illegal_move" });
    expect(foldAutonomy(null, granted(1))).toMatchObject({ ok: false, failure: "illegal_move" });
    expect(foldAutonomy(readyRecord, granted(3, "system"))).toMatchObject({ ok: false, failure: "needs_staff" });
    expect(foldAutonomy(readyRecord, granted(3, "certify"))).toMatchObject({ ok: false, failure: "needs_staff" });
    for (const bad of [[earned(1, "batch_a", HALF), granted(2)], [...ready, granted(3, "system")], [granted(1)]]) {
      expect(rebuild(KEY, HASHES, bad).ok).toBe(false);
    }
  });

  test("a granted record stays granted as evidence grows", () => {
    const lines = [earned(1, "batch_a", HALF), earned(2, "batch_b", HALF), granted(3), earned(4, "batch_c", HALF)];
    expect(autonomyOf(lines)).toMatchObject({ state: "granted", evidence: { correct: 30 } });
  });

  test("revoked zeroes the evidence and the batches, and records who and why", () => {
    const lines = [earned(1, "batch_a", HALF), earned(2, "batch_b", HALF), granted(3), revoked(4)];
    expect(autonomyOf(lines)).toMatchObject({
      state: "revoked",
      ...SCOPE,
      evidence: { correct: 0, found: 0, not_found: 0, wrong: 0, unclear: 0, batches: [] },
      granted: null,
      revoked: { by: "system", reason: "Spot check disagreed." },
    });
  });

  test("after a revocation the key earns from zero again", () => {
    const lines = [earned(1, "batch_a", HALF), earned(2, "batch_b", HALF), revoked(3), earned(4, "batch_c", HALF)];
    expect(autonomyOf(lines)).toMatchObject({ state: "earning", evidence: { correct: 10, batches: ["batch_c"] } });
    expect(autonomyOf([...lines, earned(5, "batch_d", HALF)])).toMatchObject({ state: "ready", evidence: { correct: 20 } });
  });

  test("an earned line for a new check key or jev version starts over", () => {
    for (const other of [OTHER_CHECK, OTHER_JEV]) {
      const a = autonomyOf([earned(1, "batch_a", HALF), earned(2, "batch_b", HALF), earned(3, "batch_c", counts({ correct: 2, found: 1, not_found: 1 }), other)]);
      expect(a).toMatchObject({ state: "earning", check: other.check, jev: other.jev, evidence: { correct: 2, batches: ["batch_c"] } });
    }
  });

  test("a granted record whose scope changes becomes revoked: the grant never carries across", () => {
    const lines = [earned(1, "batch_a", HALF), earned(2, "batch_b", HALF), granted(3), earned(4, "batch_c", HALF, OTHER_JEV)];
    const a = autonomyOf(lines);
    expect(a?.granted).toBeNull();
    expect(a?.revoked).not.toBeNull();
    expect(a?.state).not.toBe("granted");
  });

  test("a ready marker line changes nothing", () => {
    const marker: AutonomyLine = { event: "autonomy", at: at(3), by: "certify", reason: "marker", action: "ready", evidence: [] };
    const base = [earned(1, "batch_a", HALF)];
    expect(autonomyOf([...base, marker])).toEqual(autonomyOf(base));
    expect(autonomyOf([marker])).toBeNull();
  });

  test("foldAutonomy is pure: the same line on the same record gives the same answer", () => {
    const a = foldAutonomy(null, earned(1, "batch_a", HALF));
    const b = foldAutonomy(null, earned(1, "batch_a", HALF));
    expect(a).toEqual(b);
  });

  test("autonomy lines never change the key's trust state", () => {
    const lines = [batch(1, "batch_a"), approved(2), earned(3, "batch_b", HALF), earned(4, "batch_c", HALF), granted(5), revoked(6)];
    const r = rebuild(KEY, HASHES, lines);
    expect(r.ok && r.value.state).toBe("approved");
  });
});

describe("stateFor, grantedFor", () => {
  const grantedRecord = autonomyOf([earned(1, "batch_a", HALF), earned(2, "batch_b", HALF), granted(3)]);

  test("no record is none; a granted record under its own scope is granted", () => {
    expect(stateFor(null, SCOPE)).toBe("none");
    expect(grantedFor(null, SCOPE)).toBe(false);
    expect(stateFor(grantedRecord, SCOPE)).toBe("granted");
    expect(grantedFor(grantedRecord, SCOPE)).toBe(true);
  });

  test("a changed check key, check patch, or jev version reads as revoked, with no write", () => {
    for (const s of [OTHER_CHECK, OTHER_JEV, { ...SCOPE, check_patch: 2 }]) {
      expect(stateFor(grantedRecord, s)).toBe("revoked");
      expect(grantedFor(grantedRecord, s)).toBe(false);
    }
    // A null jev (no jev wired) is also not the granted scope.
    expect(grantedFor(grantedRecord, { ...SCOPE, jev: null })).toBe(false);
  });

  test("a ready record under another scope is still reported as it is (only a grant is scope-bound)", () => {
    const ready = autonomyOf([earned(1, "batch_a", HALF), earned(2, "batch_b", HALF)]);
    expect(stateFor(ready, OTHER_JEV)).toBe("ready");
    expect(grantedFor(ready, SCOPE)).toBe(false);
  });
});

describe("spotChecked", () => {
  test("the same run ID always gives the same answer", () => {
    for (const id of ["run_2026-01-15_aaaaaaaaaa", "run_2026-01-15_bbbbbbbbbb"]) {
      expect(spotChecked(id)).toBe(spotChecked(id));
    }
  });

  test("about 1 in 20 run IDs are picked", () => {
    const n = 4000;
    let hits = 0;
    for (let i = 0; i < n; i += 1) if (spotChecked(`run_2026-01-15_${String(i).padStart(10, "0")}`)) hits += 1;
    expect(hits).toBeGreaterThan(n * 0.03);
    expect(hits).toBeLessThan(n * 0.07);
  });
});

describe("evidenceLine: what a certify batch makes", () => {
  const call = (n: number, answer: JevCall["answer"], truth: JevCall["truth"]): JevCall => ({
    case_id: `drill_${String(n)}`,
    run_id: `run_${String(n)}`,
    answer,
    truth,
    label: labelCall(answer, truth),
  });

  function report(over: Record<string, unknown> = {}): BatchReport {
    return BatchReport.parse({
      schema: "intyy.batch_report/1.0",
      batch_id: "batch_a",
      tenant: "keystone",
      app: "kvfcu",
      capability: "kvfcu/open_share_subaccount@1",
      ended_at: "2026-01-15T09:00:00.000Z",
      kind: "full",
      under: { engine: "0.4.0", handler_set: HASHES.artifact, jev: "jev@fake", session: null, check: "kvfcu/find_account_by_reference@1.0.0" },
      cases: [{ case_id: "baseline", run_id: "run_0", class: "valid", result: { status: "success", detail: null }, truth: {}, verdict: "pass" }],
      gate: { passed: true },
      coverage_gaps: [],
      stability: null,
      jev: { version: "jev@fake", calls: [call(1, "found", "found"), call(2, "not_found", "not_found"), call(3, "unclear", "found")] },
      ...over,
    });
  }

  test("correct answers make an earned line with the counts and the batch ID", () => {
    const line = evidenceLine(report(), at(1));
    expect(line).toMatchObject({
      event: "autonomy",
      by: "certify",
      action: "earned",
      evidence: ["batch_a"],
      scope: SCOPE,
      counts: { correct: 2, found: 1, not_found: 1, wrong: 0, unclear: 1 },
    });
  });

  test("one wrong answer makes a revoked line instead, with no counts", () => {
    const wrong = report({ jev: { version: "jev@fake", calls: [call(1, "found", "found"), call(2, "found", "not_found")] } });
    const line = evidenceLine(wrong, at(1));
    expect(line).toMatchObject({ action: "revoked", by: "certify", evidence: ["batch_a"], scope: SCOPE });
    expect(line?.counts).toBeUndefined();
  });

  test("a drill, a regression, or a quick batch, and a batch with no jev, no calls, or no check, make nothing", () => {
    expect(evidenceLine(report({ drill: true }), at(1))).toBeNull();
    expect(evidenceLine(report({ models_off: true }), at(1))).toBeNull();
    expect(evidenceLine(report({ kind: "regression" }), at(1))).toBeNull();
    expect(evidenceLine(report({ kind: "quick" }), at(1))).toBeNull();
    expect(evidenceLine(report({ jev: undefined }), at(1))).toBeNull();
    expect(evidenceLine(report({ jev: { version: "jev@fake", calls: [] } }), at(1))).toBeNull();
    expect(evidenceLine(report({ under: { engine: "0.4.0", handler_set: HASHES.artifact, jev: "jev@fake", session: null, check: null } }), at(1))).toBeNull();
    expect(evidenceLine(report({ under: { engine: "0.4.0", handler_set: HASHES.artifact, jev: null, session: null, check: "kvfcu/find_account_by_reference@1.0.0" } }), at(1))).toBeNull();
  });

  test("the lines fold: batches of right answers reach ready, then one wrong batch zeroes it", () => {
    const right = [call(1, "found", "found"), call(2, "not_found", "not_found")];
    const batchReport = (id: string, calls: JevCall[]) => report({ batch_id: id, jev: { version: "jev@fake", calls } });
    const many = (n: number) => Array.from({ length: n }, (_, i) => call(i + 1, i % 2 === 0 ? "found" : "not_found", i % 2 === 0 ? "found" : "not_found"));
    const lines: HistoryLine[] = [];
    for (const [i, id] of ["batch_a", "batch_b"].entries()) {
      const l = evidenceLine(batchReport(id, many(10)), at(i + 1));
      if (l !== null) lines.push(l);
    }
    expect(autonomyOf(lines)).toMatchObject({ state: "ready", evidence: { correct: 20 } });
    const bad = evidenceLine(batchReport("batch_c", [...right, call(9, "found", "not_found")]), at(5));
    if (bad !== null) lines.push(bad);
    expect(autonomyOf(lines)).toMatchObject({ state: "revoked", evidence: { correct: 0, wrong: 0 } });
  });
});

describe("describeAutonomy", () => {
  test("none says there is no evidence; a record shows its state against the rule", () => {
    expect(describeAutonomy(null)).toContain("none");
    const a = autonomyOf([earned(1, "batch_a", HALF)]);
    expect(describeAutonomy(a, SCOPE)).toContain("earning");
    expect(describeAutonomy(a, SCOPE)).toContain("need 20 correct");
    const g = autonomyOf([earned(1, "batch_a", HALF), earned(2, "batch_b", HALF), granted(3)]);
    expect(describeAutonomy(g, OTHER_JEV)).toContain("revoked");
  });
});
