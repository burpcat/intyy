// Proves `runCertifyFull` on the fake kit (design section 8 §7.1 to §7.4 what a full batch runs
// and how each case goes, §7.8 plan and report files, §8.3 void cases re-run up to twice, §9.5 the
// gate, §9.7 the report; build decisions of M10 tasks 3 and 4): the matrix cells skip prelude
// steps and place `@commit_point` and fixed `@step:x` profiles exactly; baseline repeats, twin,
// matrix, extra, and drill cases appear in order with batch seeds; the plan and report parse; a
// drill batch (models off, declared instance) cannot pass rule 1; a harness reset that keeps
// failing makes the case void after three attempts and fails rule 6; an extra that names a
// missing step is void at once; a setup failure fails the batch or the case; the reviewer in
// `deps.models` reaches the replay; `under` names the session version. M10 task 3.
import { describe, expect, test } from "vitest";
import { matrixCells, runCertifyFull, VOID_RERUNS, type CertifyFullInput } from "../../../src/core/certify/full.js";
import { BatchPlan } from "../../../src/core/model/batch-plan.js";
import { BatchReport } from "../../../src/core/model/batch-report.js";
import { TableReviewer, type ReviewerScript } from "../../../src/fakes/table-reviewer.js";
import type { FakeElement, FakeSite } from "../../../src/fakes/snapshot-surface/index.js";
import type { Harness, HarnessFailure, NamedFault } from "../../../src/ports/harness.js";
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
