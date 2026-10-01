// Proves `runCertifyFull` on the fake kit (design section 8 §7.1 to §7.4 what a full batch runs
// and how each case goes, §7.8 plan and report files, §8.3 void cases re-run up to twice, §9.5 the
// gate, §9.7 the report; build decisions of M10 tasks 3 and 4): the matrix cells skip prelude
// steps and place `@commit_point` and fixed `@step:x` profiles exactly; baseline repeats, twin,
// matrix, extra, and drill cases appear in order with batch seeds; the plan and report parse; a
// drill batch (models off, declared instance) cannot pass rule 1; a harness reset that keeps
// failing makes the case void after three attempts and fails rule 6; an extra that names a
// missing step is void at once; a setup failure fails the batch or the case; the reviewer in
// `deps.models` reaches the replay; `under` names the session version. M10 task 3.
// M10 task 10 adds the stability runs (section 8 §7.2, §8.4, §9.3, build decisions of task 10):
// levels x seeds x twins cases after the drills, twins share seed and inputs, the report holds the
// curve (null with no setting), the harness gets entropy and seed, a wrong run fails `no_wrong`
// only, a void run `no_void` only, an unexplained run neither the gate nor the outcome score, and
// a listed ending for a style that fired is `explained`.
// M10 task 11 adds tuned timeouts (section 8 §9.6, §9.7): the report's `timeouts` proposes a value
// per step from 20 or more clean samples, leaves out a faulted step's matrix sample, lists a step
// with too few samples, echoes the timeouts the batch ran with (and every run freezes them), and
// proposes nothing when the fault log's nominal delays show the batch ran scaled.
import { describe, expect, test } from "vitest";
import { matrixCells, runCertifyFull, VOID_RERUNS, type CertifyFullInput } from "../../../src/core/certify/full.js";
import { BatchPlan } from "../../../src/core/model/batch-plan.js";
import { BatchReport } from "../../../src/core/model/batch-report.js";
import { TableReviewer, type ReviewerScript } from "../../../src/fakes/table-reviewer.js";
import { ExplainedEnding } from "../../../src/core/model/faults.js";
import type { FakeElement, FakeSite } from "../../../src/fakes/snapshot-surface/index.js";
import type { FaultLogEntry, Harness, HarnessFailure, NamedFault } from "../../../src/ports/harness.js";
import { fail, type Outcome } from "../../../src/ports/outcome.js";
import type { ReviewerInput } from "../../../src/ports/models.js";
import { ORIGIN, TENANT, fixtureSite } from "../replay/executor-harness.js";
import type { RouteMappingHarness } from "./route-mapping-harness.js";
import { MISSING, VALID, fullDeps, fullInput, profile } from "./full-kit.js";

/** The finished batch, or a thrown error. */
async function batchOf(input: (id: string) => CertifyFullInput, ...args: Parameters<typeof fullDeps>) {
  const { deps, ids, route } = await fullDeps(...args);
  const r = await runCertifyFull(input(ids.batchId()), deps);
  if (!r.ok) throw new Error(`full batch failed: ${r.failure}${r.detail === undefined ? "" : ` ${r.detail}`}`);
  return { ...r.value, deps, route };
}

const caseIds = (b: { report: BatchReport }): string[] => b.report.cases.map((c) => c.case_id);

describe("matrixCells", () => {
  const each = profile("each", "@each_request_step");
  const commit = profile("commit", "@commit_point");
  const fixed = profile("fixed", "@step:open_member");

  test("@each_request_step makes one cell per task request step, none for session:* steps", () => {
    const cells = matrixCells([each], ["session:login", "click_search", "session:logout", "click_confirm"], "click_confirm");
    expect(cells.map((c) => [c.step, c.at])).toEqual([
      ["click_search", "@step:click_search"],
      ["click_confirm", "@step:click_confirm"],
    ]);
  });

  test("@commit_point sits on the commit step and a fixed @step:x on its own step", () => {
    const cells = matrixCells([commit, fixed], ["open_member", "click_confirm"], "click_confirm");
    expect(cells).toEqual([
      { profile: commit, step: "click_confirm", at: undefined },
      { profile: fixed, step: "open_member", at: undefined },
    ]);
  });

  test("cells follow the profile order, then the step order", () => {
    const cells = matrixCells([fixed, each, commit], ["a", "b"], "b");
    expect(cells.map((c) => `${c.profile.id}:${c.step}`)).toEqual(["fixed:open_member", "each:a", "each:b", "commit:b"]);
  });

  test("no profiles, no cells", () => {
    expect(matrixCells([], ["a"], "a")).toEqual([]);
  });
});

describe("runCertifyFull: a clean batch", () => {
  test("the plan and report parse, and the gate passes on a clean app", async () => {
    const b = await batchOf((id) => fullInput(id));
    expect(BatchPlan.safeParse(b.plan).success).toBe(true);
    expect(BatchReport.safeParse(b.report).success).toBe(true);
    expect(b.plan).toMatchObject({ kind: "full", pin: "kvfcu/open_sub@1.0.0", started_by: "op_017" });
    expect(b.report.kind).toBe("full");
    expect(b.report.gate).toEqual({
      passed: true,
      rules: { complete: true, no_wrong: true, baseline: true, matrix: true, extra: true, no_void: true },
    });
    expect(b.report.stability).toBeNull();
    expect(b.report.drill).toBeUndefined();
    expect(b.failing).toEqual([]);
    expect(b.scores).toMatchObject({ outcome_score: 1, verdicts: { pass: 8, void: 0, wrong: 0 } });
    expect(b.report.outcome_score).toBe(1);
    expect(b.report.verdicts).toEqual(b.scores.verdicts);
  });

  test("cases run in order: baseline repeats, twin, matrix, extra, drills; groups and seeds follow", async () => {
    const extra = { id: "slow_search_case", class: "valid", faults: [{ kind: "server_error" as const, at: "@step:click_search" }], expect: { status: "success" } };
    const reconciling = profile("reply_lost", "@commit_point", "reconciles_found");
    const b = await batchOf((id) =>
      fullInput(id, { extra: [extra], drills: 2, profiles: [profile("server_error", "@each_request_step"), reconciling] }),
    );
    expect(caseIds(b)).toEqual([
      "baseline",
      "baseline_valid_2",
      "baseline_valid_3",
      "twin",
      "server_error.click_search",
      "server_error.click_confirm",
      "reply_lost.click_confirm",
      "slow_search_case",
      "drill_1",
      "drill_2",
    ]);
    expect(b.report.cases.map((c) => c.group)).toEqual([
      "baseline", "baseline", "baseline", "twin", "matrix", "matrix", "matrix", "extra", "drill", "drill",
    ]);
    for (const c of b.plan.cases) {
      const id = c.case_id;
      expect(c.seed).toBe(`${b.plan.batch_id}:${id === "twin" ? "baseline" : id}`);
    }
    expect(b.plan.cases.map((c) => c.profile)).toEqual([
      null, null, null, null, "server_error", "server_error", "reply_lost", "slow_search_case", "reply_lost", "reply_lost",
    ]);
  });

  test("the baseline repeats use pool values 1 to 3; the twin repeats the first run's seed and inputs", async () => {
    const pools = { "members.valid": ["700114", "700115", "700116"] };
    const b = await batchOf((id) => fullInput(id, { pools, profiles: [] }));
    const byId = new Map(b.plan.cases.map((c) => [c.case_id, c]));
    expect(byId.get("baseline")?.inputs).toEqual({ member_id: "700114" });
    expect(byId.get("baseline_valid_2")?.inputs).toEqual({ member_id: "700115" });
    expect(byId.get("baseline_valid_3")?.inputs).toEqual({ member_id: "700116" });
    expect(byId.get("twin")?.inputs).toEqual(byId.get("baseline")?.inputs);
    expect(byId.get("twin")?.seed).toBe(byId.get("baseline")?.seed);
    expect(new Set(b.plan.cases.map((c) => c.run_id)).size).toBe(b.plan.cases.length);
  });

  test("every class gets three repeats; the matrix class's first repeat is the plain baseline", async () => {
    const b = await batchOf((id) => fullInput(id, { classes: [VALID, MISSING], profiles: [] }));
    expect(caseIds(b)).toEqual([
      "baseline", "baseline_valid_2", "baseline_valid_3",
      "baseline_missing_1", "baseline_missing_2", "baseline_missing_3",
      "twin",
    ]);
    const missing = b.plan.cases.find((c) => c.case_id === "baseline_missing_1");
    expect(missing).toMatchObject({ class: "missing", group: "baseline" });
    expect(missing?.inputs).toEqual({ member_id: "700199" });
  });

  test("each run's run.json carries the batch ID and its case ID", async () => {
    const b = await batchOf((id) => fullInput(id));
    for (const c of b.plan.cases) {
      const json = await b.deps.evidence.readRunJson(TENANT, c.run_id);
      if (!json.ok) throw new Error(`no run.json for ${c.case_id}`);
      expect(json.value).toMatchObject({ batch_id: b.plan.batch_id, case_id: c.case_id });
    }
  });

  test("the matrix cases name their step; a fault that never fired is a coverage gap", async () => {
    const b = await batchOf((id) => fullInput(id));
    expect(b.report.coverage_gaps?.length).toBe(4);
    expect(b.report.coverage_gaps?.join("\n")).toContain("never fired");
    expect(b.plan.cases.find((c) => c.case_id === "server_error.click_search")?.faults).toEqual([
      { kind: "server_error", route: "POST /search", nth: 1, repeat: "once" },
    ]);
    expect(b.plan.cases.find((c) => c.case_id === "reply_lost.click_confirm")?.faults[0]?.route).toBe("POST /confirm");
  });

  test("margins come from the logged votes, with the batch's lowest and its step", async () => {
    const b = await batchOf((id) => fullInput(id, { profiles: [] }));
    expect(Object.keys(b.report.margin?.targets ?? {}).sort()).toEqual([
      "account_number_display",
      "confirm_button",
      "member_id_box",
      "search_button",
    ]);
    expect(b.report.margin?.lowest).toBe(Math.min(...Object.values(b.report.margin?.targets ?? {}).map((t) => t.lowest)));
    expect(b.report.margin?.step).not.toBeNull();
    expect(b.scores.margin).toEqual({ lowest: b.report.margin?.lowest, step: b.report.margin?.step });
    expect(b.report.fragile).toEqual(b.scores.fragile);
  });

  test("`under` names the engine, the handler set (null with none), and the session's exact version", async () => {
    const b = await batchOf((id) => fullInput(id));
    expect(b.under).toEqual({ engine: "0.1.0", handler_set: null, jev: null, session: "kvfcu/sign_in@1.0.0", check: null });
    expect(b.report.under).toEqual(b.under);
  });

  test("the matrix `suite.matrix.profiles` list picks profiles by ID", async () => {
    const b = await batchOf((id) => fullInput(id, { matrixProfiles: ["reply_lost"] }));
    expect(b.plan.cases.filter((c) => c.group === "matrix").map((c) => c.case_id)).toEqual(["reply_lost.click_confirm"]);
  });
});

describe("runCertifyFull: drills, extra cases, and drill batches", () => {
  test("a drill case is judged on truth only: a mismatching ending still passes it", async () => {
    // The double never fires the fault, so the run succeeds; `reconciles_found` expects a commit
    // that was found by reconciliation, so the matrix case does not match and the drill case does.
    const reconciling = profile("reply_lost", "@commit_point", "reconciles_found");
    const b = await batchOf((id) => fullInput(id, { profiles: [reconciling], drills: 1 }));
    const verdict = (id: string) => b.report.cases.find((c) => c.case_id === id)?.verdict;
    expect(verdict("reply_lost.click_confirm")).not.toBe("pass");
    expect(verdict("drill_1")).toBe("pass");
    expect(b.report.gate.rules).toMatchObject({ matrix: false, no_wrong: true, no_void: true });
    expect(b.report.gate.passed).toBe(false);
  });

  test("drills run the commit-step profiles that reconcile, round robin", async () => {
    const a = profile("lost_a", "@commit_point", "reconciles_found");
    const c = profile("lost_c", "@commit_point", "reconciles_absent");
    const b = await batchOf((id) => fullInput(id, { profiles: [a, profile("plain", "@step:click_search"), c], drills: 3 }));
    const drills = b.plan.cases.filter((x) => x.group === "drill");
    expect(drills.map((d) => [d.case_id, d.profile])).toEqual([["drill_1", "lost_a"], ["drill_2", "lost_c"], ["drill_3", "lost_a"]]);
  });

  test("with no reconciling profile no drill runs, and the report lists the gap", async () => {
    const b = await batchOf((id) => fullInput(id, { drills: 3 }));
    expect(b.plan.cases.some((c) => c.group === "drill")).toBe(false);
    expect(b.report.coverage_gaps?.some((g) => g.includes("drills"))).toBe(true);
  });

  test("an extra case with its own class and faults is a case of group extra", async () => {
    const extra = { id: "supervisor", class: "valid", faults: [{ kind: "server_error" as const, at: "@step:click_search" }], expect: { status: "success" } };
    const b = await batchOf((id) => fullInput(id, { extra: [extra], profiles: [] }));
    const got = b.report.cases.find((c) => c.case_id === "supervisor");
    expect(got).toMatchObject({ group: "extra", verdict: "pass", class: "valid" });
  });

  test("an extra that names an unknown class stops the batch", async () => {
    const extra = { id: "bad", class: "nope", faults: [{ kind: "server_error" as const, at: "@step:click_search" }], expect: { status: "success" } };
    const { deps, ids } = await fullDeps();
    const r = await runCertifyFull(fullInput(ids.batchId(), { extra: [extra], profiles: [] }), deps);
    expect(r).toMatchObject({ ok: false, failure: "unknown_class" });
  });

  test("an extra that names a missing step is void at once, with no re-run, and fails rule 6", async () => {
    const extra = { id: "ghost", class: "valid", faults: [{ kind: "server_error" as const, at: "@step:no_such_step" }], expect: { status: "success" } };
    const without = await batchOf((id) => fullInput(id, { profiles: [] }));
    const withGhost = await batchOf((id) => fullInput(id, { extra: [extra], profiles: [] }));
    const ghost = withGhost.report.cases.find((c) => c.case_id === "ghost");
    expect(ghost).toMatchObject({ verdict: "void", run_id: "none", group: "extra" });
    expect(ghost?.note).toContain(withGhost.plan.batch_id);
    expect(withGhost.plan.cases.find((c) => c.case_id === "ghost")).toMatchObject({ run_id: "none" });
    expect(withGhost.report.gate.rules).toMatchObject({ no_void: false, extra: false, baseline: true, matrix: true });
    expect(withGhost.report.gate.passed).toBe(false);
    // Why equal: the case could not be placed, so it never reached a reset, and it was not re-run.
    expect(withGhost.route.calls.filter((c) => c === "reset")).toHaveLength(without.route.calls.filter((c) => c === "reset").length);
    expect(withGhost.failing).toEqual([]);
  });

  test("--models off makes the batch a drill: models_off, and rule 1 fails alone", async () => {
    const b = await batchOf((id) => fullInput(id, { modelsOff: true }));
    expect(b.plan).toMatchObject({ drill: true, models_off: true });
    expect(b.report).toMatchObject({ drill: true, models_off: true });
    expect(b.report.gate.rules).toEqual({ complete: false, no_wrong: true, baseline: true, matrix: true, extra: true, no_void: true });
    expect(b.report.gate.passed).toBe(false);
    expect(b.under.jev).toBeNull();
  });

  test("a declared instance that differs makes the batch a drill, without models_off", async () => {
    const b = await batchOf((id) => fullInput(id, { declaration: { by: "op_017", differs: ["strip_semantics"] } }));
    expect(b.plan).toMatchObject({ drill: true, declaration: { by: "op_017", differs: ["strip_semantics"] } });
    expect(b.plan.models_off).toBeUndefined();
    expect(b.report.gate.rules?.complete).toBe(false);
    expect(b.report.gate.passed).toBe(false);
  });
});

/** A harness wrapper whose `reset` can fail the next few times, and that records clock calls. */
class FlakyHarness implements Harness {
  failResets = 0;
  resets = 0;
  clockCalls: (string | null)[] = [];
  clockFailure: HarnessFailure | null = null;
  constructor(private readonly inner: RouteMappingHarness) {}
  features() { return this.inner.features(); }
  reset(): Promise<Outcome<void, HarnessFailure>> {
    this.resets += 1;
    if (this.failResets > 0) {
      this.failResets -= 1;
      return Promise.resolve(fail("unreachable", "bank app unreachable"));
    }
    return this.inner.reset();
  }
  setChaos(c: { entropy?: number; seed?: string }) { return this.inner.setChaos(c); }
  addFaults(f: NamedFault[]) { return this.inner.addFaults(f); }
  clearFaults() { return this.inner.clearFaults(); }
  faultLog() { return this.inner.faultLog(); }
  oracle(notes: Parameters<Harness["oracle"]>[0]) { return this.inner.oracle(notes); }
  setClock(date: string | null): Promise<Outcome<void, HarnessFailure>> {
    this.clockCalls.push(date);
    return this.clockFailure === null ? this.inner.setClock(date) : Promise.resolve(fail(this.clockFailure, "no clock"));
  }
}

/** Runs a batch whose harness fails its next `n` resets once the twin has run. */
async function flakyBatch(n: number, over: Partial<CertifyFullInput> = {}) {
  let flaky: FlakyHarness | undefined;
  const { deps, ids, route } = await fullDeps(fixtureSite(), {}, (h) => (flaky = new FlakyHarness(h)));
  const input = fullInput(ids.batchId(), {
    ...over,
    progress: (line) => {
      if (line.startsWith("twin:") && flaky !== undefined) flaky.failResets = n;
    },
  });
  const r = await runCertifyFull(input, deps);
  if (!r.ok) throw new Error(`full batch failed: ${r.failure}`);
  return { ...r.value, route, flaky };
}

describe("runCertifyFull: void cases (section 8 §8.3)", () => {
  test("a reset that keeps failing makes the case void after three attempts, and the batch goes on", async () => {
    expect(VOID_RERUNS).toBe(2);
    const b = await flakyBatch(VOID_RERUNS + 1);
    const first = b.report.cases.find((c) => c.case_id === "server_error.click_search");
    expect(first).toMatchObject({ verdict: "void", run_id: "none", group: "matrix" });
    expect(first?.note).toContain("harness_unreachable");
    expect(b.flaky?.failResets).toBe(0);
    // The next case ran normally.
    expect(b.report.cases.find((c) => c.case_id === "server_error.click_confirm")).toMatchObject({ verdict: "pass" });
    expect(b.report.verdicts?.void).toBe(1);
    expect(b.report.gate.rules).toMatchObject({ no_void: false, matrix: false, baseline: true, no_wrong: true });
    expect(b.report.gate.passed).toBe(false);
    expect(b.failing).toEqual([]);
  });

  test("a reset that fails twice is re-run and the case passes", async () => {
    const b = await flakyBatch(VOID_RERUNS);
    expect(b.report.cases.find((c) => c.case_id === "server_error.click_search")?.verdict).toBe("pass");
    expect(b.report.verdicts?.void).toBe(0);
    expect(b.report.gate.passed).toBe(true);
  });
});

describe("runCertifyFull: setup runs", () => {
  test("a setup that cannot end as its class expects stops the batch with setup_failed", async () => {
    const { deps, ids } = await fullDeps();
    const bad = { ...VALID, expect: { status: "business_outcome", outcome: "member_not_found" } };
    const r = await runCertifyFull(fullInput(ids.batchId(), { setup: [{ app: "kvfcu", capability: "open_sub", major: 1, cls: bad }] }), deps);
    expect(r).toMatchObject({ ok: false, failure: "setup_failed" });
  });

  test("a setup that names a capability with no sealed artifact stops the batch", async () => {
    const { deps, ids } = await fullDeps();
    const r = await runCertifyFull(fullInput(ids.batchId(), { setup: [{ app: "kvfcu", capability: "no_such", major: 1, cls: VALID }] }), deps);
    expect(r).toMatchObject({ ok: false, failure: "setup_failed" });
  });

  test("setup runs go in the plan with purpose setup, never in the report's cases", async () => {
    const b = await batchOf((id) => fullInput(id, { profiles: [], setup: [{ app: "kvfcu", capability: "open_sub", major: 1, cls: VALID }] }));
    const setups = b.plan.cases.filter((c) => c.purpose === "setup");
    expect(setups.length).toBeGreaterThan(1);
    expect(setups[0]).toMatchObject({ case_id: "setup_1", class: "valid" });
    expect(setups[0]?.group).toBeUndefined();
    expect(b.report.cases.every((c) => !c.case_id.startsWith("setup_"))).toBe(true);
    expect(BatchPlan.safeParse(b.plan).success).toBe(true);
    expect(b.report.gate.passed).toBe(true);
  });

  test("a setup that fails after the batch started makes that case void", async () => {
    // The class answers "success" to the first look (the batch's own start) and "failed" after,
    // so the batch starts, and the next setup does not end as expected.
    let looks = 0;
    const flipping = { ...VALID };
    Object.defineProperty(flipping, "expect", {
      get: () => {
        looks += 1;
        return looks <= 2 ? { status: "success" } : { status: "failed" };
      },
    });
    const b = await batchOf((id) => fullInput(id, { setup: [{ app: "kvfcu", capability: "open_sub", major: 1, cls: flipping }] }));
    expect(b.report.cases.some((c) => c.verdict === "void")).toBe(true);
    expect(b.report.gate.rules?.no_void).toBe(false);
    expect(b.report.gate.passed).toBe(false);
  });
});

describe("runCertifyFull: business date", () => {
  test("the test data set's date is set at the start, and a harness without a clock is no error", async () => {
    let flaky: FlakyHarness | undefined;
    const { deps, ids } = await fullDeps(fixtureSite(), {}, (h) => (flaky = new FlakyHarness(h)));
    const r = await runCertifyFull(fullInput(ids.batchId(), { businessDate: "2026-01-15", profiles: [] }), deps);
    expect(r.ok).toBe(true);
    expect(flaky?.clockCalls).toEqual(["2026-01-15"]);

    const second = await fullDeps(fixtureSite(), {}, (h) => {
      const f = new FlakyHarness(h);
      f.clockFailure = "unsupported";
      return f;
    });
    const r2 = await runCertifyFull(fullInput(second.ids.batchId(), { businessDate: "2026-01-15", profiles: [] }), second.deps);
    expect(r2.ok).toBe(true);
  });

  test("a clock call that fails for another reason stops the batch", async () => {
    const { deps, ids } = await fullDeps(fixtureSite(), {}, (h) => {
      const f = new FlakyHarness(h);
      f.clockFailure = "unreachable";
      return f;
    });
    const r = await runCertifyFull(fullInput(ids.batchId(), { businessDate: "2026-01-15", profiles: [] }), deps);
    expect(r).toMatchObject({ ok: false, failure: "harness_unreachable" });
  });
});

describe("runCertifyFull: a failed gate lists the runs that did not pass", () => {
  test("a wrong run fails no_wrong and the matrix, and its run ID is in `failing`", async () => {
    // The member is missing, but the class expects success: a failed truth check, so `wrong`.
    const { deps, ids } = await fullDeps(fixtureSite({ result: "not_found" }));
    const r = await runCertifyFull(fullInput(ids.batchId(), { profiles: [profile("e", "@each_request_step")] }), deps);
    if (!r.ok) throw new Error("expected ok");
    expect(r.value.report.verdicts?.wrong).toBeGreaterThan(0);
    expect(r.value.report.gate.rules).toMatchObject({ no_wrong: false, baseline: false, matrix: false });
    expect(r.value.report.gate.passed).toBe(false);
    expect(r.value.failing).toHaveLength(r.value.report.cases.filter((c) => c.verdict !== "pass").length);
    expect(r.value.scores.outcome_score).toBe(0);
  });
});

/** /home first loads with a notice and no member ID box, so `type_member_id` cannot find its
 * target; Close reloads /home, and the box is there (same shape as ladder-rungs-executor.test.ts). */
function boxSite(): FakeSite {
  let visits = 0;
  const box: FakeElement = { id: "member_id_box", role: "textbox", roleGroup: "text_entry", label: "Member ID", field: { kind: "text", value: "" } };
  const search: FakeElement = { id: "search_button", role: "button", roleGroup: "button_like", name: "Search", text: "Search", onClick: { go: "/result" } };
  const notice: FakeElement = { id: "notice", role: "generic", roleGroup: "container", text: "Branch profile review is pending." };
  const close: FakeElement = { id: "close", role: "button", roleGroup: "button_like", name: "Close", text: "Close", onClick: { go: "/home" } };
  const login: FakeElement = { id: "login_button", role: "button", roleGroup: "button_like", name: "Login", text: "Login", onClick: { go: "/home" } };
  const confirm: FakeElement = { id: "confirm_button", role: "button", roleGroup: "button_like", name: "Confirm", text: "Confirm", onClick: { go: "/done" } };
  const done: FakeElement = { id: "account_number_display", role: "generic", roleGroup: "container", label: "Account number", text: "SH1234567" };
  return {
    origin: ORIGIN,
    screens: {
      "/": { elements: [login] },
      get "/home"() {
        visits += 1;
        return { elements: visits === 1 ? [notice, close] : [box, search] };
      },
      "/result": { elements: [confirm] },
      "/done": { elements: [done] },
    },
  };
}

const GIVE_UP: ReviewerScript = { fixStep: [{ when: {}, reply: { answer: { give_up: true, reason: "no" } } }] };

describe("runCertifyFull: the models in deps reach the replay", () => {
  test("the reviewer in deps.models is asked when a step is stuck; with --models off it is not", async () => {
    // Probe: the site's first screen has a notice, so the baseline's first step is stuck and rung 3 runs.
    const asked = new TableReviewer(GIVE_UP);
    const on = await fullDeps(boxSite(), { models: { reviewer: asked } });
    await runCertifyFull(fullInput(on.ids.batchId(), { profiles: [] }), on.deps);
    expect(asked.seen.length).toBeGreaterThan(0);
    expect((asked.seen[0]?.input as ReviewerInput).step.id).toBe("type_member_id");

    const idle = new TableReviewer(GIVE_UP);
    const off = await fullDeps(boxSite(), { models: { reviewer: idle } });
    await runCertifyFull(fullInput(off.ids.batchId(), { profiles: [], modelsOff: true }), off.deps);
    expect(idle.seen).toEqual([]);
  });
});

/** A site whose Confirm result follows `mode`: the stability tests flip it while entropy is on. */
function modeSite(mode: { value: "found" | "not_found" | "stuck" }): FakeSite {
  const sites = { found: fixtureSite(), not_found: fixtureSite({ result: "not_found" }), stuck: fixtureSite({ confirm: "stuck" }) };
  return {
    ...sites.found,
    screens: {
      ...sites.found.screens,
      get "/result"() {
        const screen = sites[mode.value].screens["/result"];
        if (screen === undefined) throw new Error("test setup: no /result screen");
        return screen;
      },
    },
  };
}

const entropyEntry = (style: string): FaultLogEntry => ({
  seq: 1, time: "2026-01-15T09:00:00.000Z", method: "POST", path: "/confirm", route_count: 1,
  decision: "entropy", fault_kind: "server_error", block_point: "none", style, named_id: null, delay_ms: 0,
});

/** Wraps the harness: records `setChaos`, tells the site its mode while entropy is on, can fail
 * `setChaos` at entropy above 0, and can add fired entropy faults to the fault log. */
class ChaosHarness implements Harness {
  chaos: { entropy?: number; seed?: string }[] = [];
  entropy = 0;
  failChaos = false;
  fire: string[] = [];
  constructor(private readonly inner: RouteMappingHarness, private readonly mode: { value: "found" | "not_found" | "stuck" }, private readonly onMode: "found" | "not_found" | "stuck") {}
  features() { return this.inner.features(); }
  reset() { return this.inner.reset(); }
  setChaos(c: { entropy?: number; seed?: string }): Promise<Outcome<void, HarnessFailure>> {
    this.chaos.push(c);
    if (this.failChaos && (c.entropy ?? 0) > 0) return Promise.resolve(fail("unreachable", "chaos refused"));
    this.entropy = c.entropy ?? 0;
    this.mode.value = this.entropy > 0 ? this.onMode : "found";
    return this.inner.setChaos(c);
  }
  addFaults(f: NamedFault[]) { return this.inner.addFaults(f); }
  clearFaults() { return this.inner.clearFaults(); }
  async faultLog() {
    const log = await this.inner.faultLog();
    return log.ok && this.entropy > 0 ? { ...log, value: [...log.value, ...this.fire.map(entropyEntry)] } : log;
  }
  oracle(notes: Parameters<Harness["oracle"]>[0]) { return this.inner.oracle(notes); }
  setClock(date: string | null) { return this.inner.setClock(date); }
}

const STAB = { class: "valid", levels: [0.05, 0.3], seeds: 2, twins: true };

/** A stability batch on the mode site. `setup` tunes the wrapper before the run. */
async function stabilityBatch(
  onMode: "found" | "not_found" | "stuck",
  over: Partial<CertifyFullInput> = {},
  setup: (h: ChaosHarness) => void = () => undefined,
) {
  const mode: { value: "found" | "not_found" | "stuck" } = { value: "found" };
  let chaos: ChaosHarness | undefined;
  const { deps, ids } = await fullDeps(modeSite(mode), {}, (h) => {
    chaos = new ChaosHarness(h, mode, onMode);
    setup(chaos);
    return chaos;
  });
  const r = await runCertifyFull(fullInput(ids.batchId(), { profiles: [], stability: STAB, ...over }), deps);
  if (!r.ok) throw new Error(`full batch failed: ${r.failure}${r.detail === undefined ? "" : ` ${r.detail}`}`);
  return { ...r.value, chaos: chaos?.chaos ?? [] };
}

const stabCases = <T extends { group?: string | undefined }>(cases: T[]): T[] => cases.filter((c) => c.group === "stability");

describe("runCertifyFull: stability runs (section 8 §7.2, §9.3)", () => {
  test("levels x seeds x twins cases run after the drills, in level, seed, twin order", async () => {
    const reconciling = profile("reply_lost", "@commit_point", "reconciles_found");
    const b = await batchOf((id) => fullInput(id, { profiles: [reconciling], drills: 1, stability: STAB }));
    expect(caseIds(b).slice(-9)).toEqual([
      "drill_1",
      "stab_0.05_1", "stab_0.05_1_twin", "stab_0.05_2", "stab_0.05_2_twin",
      "stab_0.3_1", "stab_0.3_1_twin", "stab_0.3_2", "stab_0.3_2_twin",
    ]);
    expect(stabCases(b.report.cases)).toHaveLength(8);
    expect(stabCases(b.plan.cases)).toHaveLength(8);
    expect(stabCases(b.plan.cases).every((c) => c.class === "valid" && c.profile === null && c.faults.length === 0)).toBe(true);
    expect(BatchPlan.safeParse(b.plan).success).toBe(true);
    expect(BatchReport.safeParse(b.report).success).toBe(true);
  });

  test("a twin shares its first run's seed and inputs; seeds and pool values differ per seed number", async () => {
    const pools = { "members.valid": ["700114", "700115", "700116"] };
    const b = await batchOf((id) => fullInput(id, { pools, profiles: [], stability: STAB }));
    const byId = new Map(b.plan.cases.map((c) => [c.case_id, c]));
    for (const level of ["0.05", "0.3"]) {
      for (const n of [1, 2]) {
        const first = byId.get(`stab_${level}_${String(n)}`);
        const twin = byId.get(`stab_${level}_${String(n)}_twin`);
        expect(twin?.seed).toBe(first?.seed);
        expect(twin?.inputs).toEqual(first?.inputs);
        expect(first?.seed).toBe(`${b.plan.batch_id}:s${level}:${String(n)}`);
        expect(first?.inputs).toEqual({ member_id: n === 1 ? "700114" : "700115" });
      }
    }
    expect(new Set(stabCases(b.plan.cases).map((c) => c.run_id)).size).toBe(8);
  });

  test("the report's curve has a row per level, with four judged runs each, and a clean app passes them all", async () => {
    const b = await batchOf((id) => fullInput(id, { profiles: [], stability: STAB }));
    expect(b.report.stability).toHaveLength(2);
    expect(b.report.stability?.map((l) => [l.entropy, l.runs, l.pass, l.wrong, l.twin_mismatch])).toEqual([
      [0.05, 4, 1, 0, 0],
      [0.3, 4, 1, 0, 0],
    ]);
    expect(b.report.gate.passed).toBe(true);
  });

  test("twins:false halves the runs", async () => {
    const b = await batchOf((id) => fullInput(id, { profiles: [], stability: { ...STAB, twins: false } }));
    expect(caseIds(b).filter((c) => c.startsWith("stab_"))).toEqual(["stab_0.05_1", "stab_0.05_2", "stab_0.3_1", "stab_0.3_2"]);
    expect(b.report.stability?.map((l) => l.runs)).toEqual([2, 2]);
  });

  test("with no stability setting no stability case runs and the curve is null", async () => {
    for (const stability of [undefined, null]) {
      const b = await batchOf((id) => fullInput(id, { profiles: [], ...(stability === undefined ? {} : { stability }) }));
      expect(caseIds(b).some((c) => c.startsWith("stab_"))).toBe(false);
      expect(b.report.stability).toBeNull();
    }
  });

  test("a stability class the suite does not define stops the batch with unknown_class", async () => {
    const { deps, ids } = await fullDeps();
    const r = await runCertifyFull(fullInput(ids.batchId(), { profiles: [], stability: { ...STAB, class: "nope" } }), deps);
    expect(r).toMatchObject({ ok: false, failure: "unknown_class" });
  });

  test("the harness gets the level as entropy and the case's seed, and entropy 0 after each run", async () => {
    const b = await stabilityBatch("found");
    const seen = b.chaos.filter((c) => (c.entropy ?? 0) > 0);
    const planned = stabCases(b.plan.cases).map((c) => ({ entropy: Number(c.case_id.split("_")[1]), seed: c.seed }));
    expect(seen).toEqual(planned);
    expect(b.chaos.filter((c) => c.entropy === 0).length).toBeGreaterThanOrEqual(planned.length);
  });

  test("a wrong stability verdict fails no_wrong only, and the run is listed in `failing`", async () => {
    // Why wrong: while entropy is on the member is missing, but the class expects success (a failed outcome truth check).
    const b = await stabilityBatch("not_found");
    const stab = stabCases(b.report.cases);
    expect(stab.map((c) => c.verdict)).toEqual(Array(8).fill("wrong"));
    expect(b.report.gate.rules).toEqual({ complete: true, no_wrong: false, baseline: true, matrix: true, extra: true, no_void: true });
    expect(b.report.gate.passed).toBe(false);
    expect(b.report.stability?.map((l) => l.wrong)).toEqual([4, 4]);
    expect(b.failing).toEqual(stab.map((c) => c.run_id));
    expect(b.scores.outcome_score).toBe(1);
  });

  test("a void stability case fails no_void only, and the curve leaves it out", async () => {
    const b = await stabilityBatch("found", {}, (h) => { h.failChaos = true; });
    const stab = stabCases(b.report.cases);
    expect(stab).toHaveLength(8);
    expect(stab.every((c) => c.verdict === "void" && c.run_id === "none")).toBe(true);
    expect(b.report.gate.rules).toEqual({ complete: true, no_wrong: true, baseline: true, matrix: true, extra: true, no_void: false });
    expect(b.report.gate.passed).toBe(false);
    expect(b.report.stability?.every((l) => l.runs === 0)).toBe(true);
    expect(b.report.coverage_gaps?.filter((g) => g.includes("stab_")).length).toBe(8);
  });

  test("an unexplained stability run leaves the gate passing and the outcome score untouched", async () => {
    // Confirm does nothing while entropy is on, and no rule explains the ending.
    const b = await stabilityBatch("stuck");
    const stab = stabCases(b.report.cases);
    expect(stab.map((c) => c.verdict)).toEqual(Array(8).fill("unexplained"));
    expect(b.report.gate.passed).toBe(true);
    expect(b.report.gate.rules).toEqual({ complete: true, no_wrong: true, baseline: true, matrix: true, extra: true, no_void: true });
    expect(b.scores.outcome_score).toBe(1);
    expect(b.report.outcome_score).toBe(1);
    expect(b.failing).toEqual([]);
    expect(b.report.stability?.map((l) => [l.runs, l.unexplained, l.pass, l.twin_mismatch])).toEqual([[4, 1, 0, 0], [4, 1, 0, 0]]);
  });

  test("a listed ending for a style that fired is explained; without the style or the table it is not", async () => {
    const plain = await stabilityBatch("stuck");
    const result = stabCases(plain.report.cases)[0]?.result;
    const detail = result?.detail;
    if (result === undefined || detail === null || detail === undefined) throw new Error("expected a failing stability run");
    const rule = (styles: string[]) =>
      ExplainedEnding.parse(
        result.status === "failed"
          ? { styles, status: "failed", endings: [detail] }
          : { styles, status: "escalated", endings: [detail.split("/").slice(0, 2).join("/")] },
      );

    const hit = await stabilityBatch("stuck", { explainedEndings: [rule(["maintenance"])] }, (h) => { h.fire = ["maintenance"]; });
    expect(stabCases(hit.report.cases).map((c) => c.verdict)).toEqual(Array(8).fill("explained"));
    expect(hit.report.stability?.map((l) => [l.explained, l.faults])).toEqual([[1, 1], [1, 1]]);
    expect(hit.report.gate.passed).toBe(true);

    const otherStyle = await stabilityBatch("stuck", { explainedEndings: [rule(["maintenance"])] }, (h) => { h.fire = ["hang"]; });
    expect(stabCases(otherStyle.report.cases).every((c) => c.verdict === "unexplained")).toBe(true);
    const noTable = await stabilityBatch("stuck", {}, (h) => { h.fire = ["maintenance"]; });
    expect(stabCases(noTable.report.cases).every((c) => c.verdict === "unexplained")).toBe(true);
  });
});

/** Wraps the harness so every logged request shows a nominal delay of `delayMs`. */
class DelayHarness implements Harness {
  constructor(private readonly inner: RouteMappingHarness, private readonly delayMs: number) {}
  features() { return this.inner.features(); }
  reset() { return this.inner.reset(); }
  setChaos(c: { entropy?: number; seed?: string }) { return this.inner.setChaos(c); }
  addFaults(f: NamedFault[]) { return this.inner.addFaults(f); }
  clearFaults() { return this.inner.clearFaults(); }
  async faultLog() {
    const log = await this.inner.faultLog();
    return log.ok ? { ...log, value: log.value.map((e) => ({ ...e, delay_ms: this.delayMs })) } : log;
  }
  oracle(notes: Parameters<Harness["oracle"]>[0]) { return this.inner.oracle(notes); }
  setClock(date: string | null) { return this.inner.setClock(date); }
}

const FIVE_SEEDS = { "members.valid": ["700114", "700115", "700116", "700117", "700118"] };

describe("runCertifyFull: tuned timeouts (section 8 §9.6)", () => {
  test("30 stability runs and the baseline give 20 or more clean samples: every step gets its floor", async () => {
    const stability = { class: "valid", levels: [0.05, 0.15, 0.3], seeds: 5, twins: true };
    const b = await batchOf((id) => fullInput(id, { pools: FIVE_SEEDS, profiles: [], stability }));
    expect(BatchReport.safeParse(b.report).success).toBe(true);
    expect(b.report.timeouts).toEqual({
      ran_with: {},
      ran_with_from: null,
      proposed: { type_member_id: 5000, click_search: 10000, click_confirm: 15000, read_account_number: 5000 },
      not_proposed: {},
    });
  });

  test("a step with too few samples is listed with its count, and the matrix leaves out the faulted step", async () => {
    // Four baseline runs, then four matrix cells: click_search is faulted in two and click_confirm in two.
    const b = await batchOf((id) => fullInput(id));
    expect(b.report.timeouts?.proposed).toEqual({});
    expect(b.report.timeouts?.not_proposed).toEqual({
      type_member_id: "8 samples",
      click_search: "6 samples",
      click_confirm: "6 samples",
      read_account_number: "8 samples",
    });
  });

  test("the timeouts the batch ran with show as ran_with, and every run freezes them", async () => {
    const timeouts = { values: { click_search: 12000 }, from: "batch_2026-01-15_aaaaaaaaaa" };
    const b = await batchOf((id) => fullInput(id, { profiles: [], timeouts }));
    expect(b.report.timeouts).toMatchObject({ ran_with: { click_search: 12000 }, ran_with_from: "batch_2026-01-15_aaaaaaaaaa" });
    const first = b.plan.cases[0];
    const json = await b.deps.evidence.readRunJson(TENANT, first?.run_id ?? "");
    if (!json.ok) throw new Error("no run.json");
    expect((json.value as { frozen: { frozen: { timeouts: unknown } } }).frozen.frozen.timeouts).toEqual({ click_search: 12000 });
  });

  test("a batch whose fault log shows 6 s delays against 1 s step times ran scaled: no proposals", async () => {
    const stability = { class: "valid", levels: [0.05, 0.15, 0.3], seeds: 5, twins: true };
    const { deps, ids } = await fullDeps(fixtureSite(), {}, (h) => new DelayHarness(h, 6000));
    const r = await runCertifyFull(fullInput(ids.batchId(), { pools: FIVE_SEEDS, profiles: [], stability }), deps);
    if (!r.ok) throw new Error(`full batch failed: ${r.failure}`);
    expect(r.value.report.timeouts).toMatchObject({ proposed: {}, scaled: true });
    expect(BatchReport.safeParse(r.value.report).success).toBe(true);
  });
});
