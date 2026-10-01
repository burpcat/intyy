// Proves certify makes the autonomy evidence (design section 8 §14.2, §7.1, §8.5): `jevCallsOf` labels
// a drill's jev reconcile answers by the drill's known truth (only `by: jev` lines; `unclear` is never
// right or wrong); a full batch with a jev adds `report.jev` and none without one, with `--models off`,
// or as a regression; `recordAutonomyEvidence` writes an earned line for right answers, and for a
// wrong answer a revoked line plus an `autonomy_revoked` alert that names the wrong runs (no alert
// when nothing was held), and nothing for a drill batch. Fakes only. M11 task 6.
import { describe, expect, test } from "vitest";
import { jevCallsOf } from "../../../src/core/certify/jev-table.js";
import { runCertifyFull } from "../../../src/core/certify/full.js";
import { Alert } from "../../../src/core/model/alert.js";
import { BatchReport, type JevCall } from "../../../src/core/model/batch-report.js";
import { recordAutonomyEvidence, readAutonomy } from "../../../src/core/trust/decisions.js";
import { FakeAlertStore } from "../../../src/fakes/alert-store.js";
import { SeededIds } from "../../../src/fakes/ids.js";
import { TableClassifier } from "../../../src/fakes/table-classifier.js";
import { HASHES, KEY } from "../trust/kit.js";
import { WHO, world } from "../trust/live-kit.js";
import { fullDeps, fullInput } from "./full-kit.js";

/** One run-log line, shaped like the executor writes it. */
const line = (by: string, verdict: unknown, event = "reconciliation"): unknown => ({ seq: 1, event, step: "click_confirm", by, data: { verdict, confidence: 0.95 } });
const DRILL = { case_id: "drill_1", run_id: "run_2026-01-15_0000000001" };

describe("jevCallsOf", () => {
  test("labels each jev answer by the truth", () => {
    const lines = [line("jev", "found"), line("jev", "not_found")];
    expect(jevCallsOf({ ...DRILL, truth: "found" }, lines)).toEqual([
      { ...DRILL, answer: "found", truth: "found", label: "right" },
      { ...DRILL, answer: "not_found", truth: "found", label: "wrong" },
    ]);
  });

  test("unclear is below_threshold under either truth", () => {
    for (const truth of ["found", "not_found"] as const) {
      expect(jevCallsOf({ ...DRILL, truth }, [line("jev", "unclear")])[0]?.label).toBe("below_threshold");
    }
  });

  test("the reviewer's answer, other events, odd verdicts, and junk lines are not jev calls", () => {
    const lines = [line("reviewer", "found"), line("jev", "found", "warning"), line("jev", "maybe"), line("jev", undefined), null, "text", 7];
    expect(jevCallsOf({ ...DRILL, truth: "found" }, lines)).toEqual([]);
  });
});

describe("runCertifyFull: report.jev", () => {
  const jev = () => ({ classifier: new TableClassifier({}) });

  test("with a jev wired, the report holds its version and the calls (none here: the double fires no fault)", async () => {
    const { deps, ids } = await fullDeps(undefined, { models: jev(), jevVersion: "jev@fake" });
    const r = await runCertifyFull(fullInput(ids.batchId()), deps);
    if (!r.ok) throw new Error(`batch failed: ${r.failure}`);
    expect(r.value.under.jev).toBe("jev@fake");
    expect(r.value.report.jev).toEqual({ version: "jev@fake", calls: [] });
    expect(BatchReport.safeParse(r.value.report).success).toBe(true);
  });

  test("no jev, or --models off: no jev block", async () => {
    const plain = await fullDeps();
    const a = await runCertifyFull(fullInput(plain.ids.batchId()), plain.deps);
    const off = await fullDeps(undefined, { models: jev(), jevVersion: "jev@fake" });
    const b = await runCertifyFull(fullInput(off.ids.batchId(), { modelsOff: true }), off.deps);
    if (!a.ok || !b.ok) throw new Error("batch failed");
    expect(a.value.report.jev).toBeUndefined();
    expect(b.value.report.jev).toBeUndefined();
  });

  test("a regression batch holds no jev block", async () => {
    const w = await fullDeps(undefined, { models: jev(), jevVersion: "jev@fake" });
    const r = await runCertifyFull(fullInput(w.ids.batchId(), { kind: "regression", pack: "app:kvfcu@2" }), w.deps);
    if (!r.ok) throw new Error("batch failed");
    expect(r.value.report.jev).toBeUndefined();
  });
});

describe("recordAutonomyEvidence", () => {
  const call = (n: number, answer: JevCall["answer"], truth: JevCall["truth"], label: JevCall["label"]): JevCall => ({
    case_id: `drill_${String(n)}`,
    run_id: `run_2026-01-15_${String(n).padStart(10, "0")}`,
    answer,
    truth,
    label,
  });
  const right = (n: number): JevCall => (n % 2 === 0 ? call(n, "found", "found", "right") : call(n, "not_found", "not_found", "right"));

  function report(id: string, calls: JevCall[], over: Record<string, unknown> = {}): BatchReport {
    return BatchReport.parse({
      schema: "intyy.batch_report/1.0",
      batch_id: id,
      tenant: KEY.tenant,
      app: "kvfcu",
      capability: "kvfcu/open_share_subaccount@1",
      ended_at: "2026-01-15T09:00:00.000Z",
      kind: "full",
      under: { engine: "0.4.0", handler_set: HASHES.artifact, jev: "jev@fake", session: null, check: "kvfcu/find_account_by_reference@1.0.0" },
      cases: [{ case_id: "baseline", run_id: "run_0", class: "valid", result: { status: "success", detail: null }, truth: {}, verdict: "pass" }],
      gate: { passed: true },
      coverage_gaps: [],
      stability: null,
      jev: { version: "jev@fake", calls },
      ...over,
    });
  }

  function setup() {
    const w = world();
    const alerts = new FakeAlertStore<Alert>(Alert);
    const alert = { ...w.deps, alerts, clock: w.clock, ids: new SeededIds(w.clock, 3) };
    const run = (rep: BatchReport, withAlert = true) => recordAutonomyEvidence(w.deps, KEY, rep, w.clock.now(), WHO, withAlert ? alert : undefined);
    return { ...w, alerts, run };
  }

  test("right answers write an earned line, and two batches reach ready", async () => {
    const s = setup();
    const ten = Array.from({ length: 10 }, (_, i) => right(i));
    expect(await s.run(report("batch_a", ten))).toMatchObject({ ok: true, value: "earned" });
    expect(await s.run(report("batch_b", ten))).toMatchObject({ ok: true, value: "earned" });
    const a = await readAutonomy(s.deps, KEY);
    expect(a.ok && a.value).toMatchObject({ state: "ready", evidence: { correct: 20, found: 10, not_found: 10, batches: ["batch_a", "batch_b"] } });
    const history = await s.scores.history("keystone/kvfcu/open_share_subaccount@1.0.0/9.2/base");
    expect(history.ok && history.value.map((l) => l.event)).toEqual(["autonomy", "autonomy"]);
  });

  test("a wrong answer after evidence exists revokes it: a revoked line by certify, zero evidence, and an alert naming the wrong run", async () => {
    const s = setup();
    const ten = Array.from({ length: 10 }, (_, i) => right(i));
    await s.run(report("batch_a", ten));
    const wrong = call(11, "found", "not_found", "wrong");
    expect(await s.run(report("batch_b", [...ten, wrong]))).toMatchObject({ ok: true, value: "revoked" });
    const a = await readAutonomy(s.deps, KEY);
    expect(a.ok && a.value).toMatchObject({ state: "revoked", evidence: { correct: 0, wrong: 0, batches: [] }, revoked: { by: "certify" } });
    const listed = await s.alerts.list();
    if (!listed.ok) throw new Error("alerts unreadable");
    expect(listed.value).toHaveLength(1);
    expect(listed.value[0]).toMatchObject({ pattern: "autonomy_revoked", tenant: "keystone", evidence_runs: [wrong.run_id] });
    expect(listed.value[0]?.keys).toEqual(["kvfcu/open_share_subaccount@1.0.0"]);
  });

  test("a wrong answer with nothing held still writes the revoked line, but raises no alert", async () => {
    const s = setup();
    expect(await s.run(report("batch_a", [call(1, "found", "not_found", "wrong")]))).toMatchObject({ ok: true, value: "revoked" });
    const listed = await s.alerts.list();
    expect(listed.ok && listed.value).toEqual([]);
  });

  test("a drill batch, a regression batch, and a batch with no jev calls write nothing", async () => {
    const s = setup();
    const wrong = call(1, "found", "not_found", "wrong");
    for (const rep of [report("batch_a", [wrong], { drill: true }), report("batch_b", [wrong], { kind: "regression" }), report("batch_c", [])]) {
      expect(await s.run(rep)).toMatchObject({ ok: true, value: null });
    }
    const a = await readAutonomy(s.deps, KEY);
    expect(a.ok && a.value).toBeNull();
    const listed = await s.alerts.list();
    expect(listed.ok && listed.value).toEqual([]);
  });
});
