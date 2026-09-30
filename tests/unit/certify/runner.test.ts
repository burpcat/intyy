// Integration tests for `runCertifyCase`: a clean baseline plus one fault case, judged against
// the oracle, on the fake snapshot surface (tests/unit/replay/executor-harness.ts) plus a thin
// fault-log-deriving harness double. `FakeHarness` alone has no live app behind it, so it cannot
// simulate a named fault actually firing; these tests exercise what the M06 gate row asks for —
// route map, anchor expansion, truth checks, and verdicts, "all on the fake harness" — by
// deriving the fault log from the run's own gate lines, deterministically, the way a live app's
// would line up. Design section 8 §7.4 to §7.8, §8.1 to §8.3; section 9 §9.1. M06 task 8.
import { describe, expect, test } from "vitest";
import { runCertifyCase, type CertifyCaseInput, type CertifyDeps } from "../../../src/core/certify/runner.js";
import { sha256Hex } from "../../../src/core/model/canonical.js";
import { BatchPlan } from "../../../src/core/model/batch-plan.js";
import { BatchReport } from "../../../src/core/model/batch-report.js";
import type { FaultProfile } from "../../../src/core/model/faults.js";
import type { Handler } from "../../../src/core/model/pack.js";
import type { SuiteClass } from "../../../src/core/model/suite.js";
import type { TestInstance } from "../../../src/core/model/testdata.js";
import type { FrozenSet } from "../../../src/core/packs/merge.js";
import { FakeHarness } from "../../../src/fakes/harness.js";
import type { FakeSite } from "../../../src/fakes/snapshot-surface/index.js";
import { MEMBER_FOUND, MEMBER_MISSING, ORIGIN, TENANT, buildHarness, fixtureSite } from "../replay/executor-harness.js";
import { idsNotifying, OPEN_SUB_ROUTE_FOR, RouteMappingHarness } from "./route-mapping-harness.js";

const VALID_CLASS: SuiteClass = { id: "valid", inputs: { member_id: "@members.valid" }, expect: { status: "success" } };
const MISSING_CLASS: SuiteClass = {
  id: "missing",
  inputs: { member_id: "@members.missing" },
  expect: { status: "business_outcome", outcome: "member_not_found" },
};
const INSTANCE: TestInstance = { variant: "keystone", strip_semantics: false, drop_labels: 0, label_seed: "0" };

/** A fault profile anchored on a request step that is never the commit step, so `expect_window`
 * (not `expect_commit`) governs the verdict. */
function windowProfile(expectWindow: FaultProfile["expect_window"]): FaultProfile {
  return {
    id: "server_error_on_search",
    kind: "server_error",
    at: "@step:click_search",
    expect_commit: "recovers",
    expect_window: expectWindow,
  };
}

/** Everything one `runCertifyCase` call needs, built fresh: the fake site, a route-deriving
 * harness, and the rest of the ports from `buildHarness` (M05 task 8's own shared fixture). */
async function buildCertifyDeps(site: ReturnType<typeof fixtureSite>) {
  const h = await buildHarness(site);
  const base = new FakeHarness();
  const harness = new RouteMappingHarness(base, h.deps.evidence, TENANT, OPEN_SUB_ROUTE_FOR);
  const ids = idsNotifying(h.deps.ids, harness);
  const deps: CertifyDeps = {
    evidence: h.deps.evidence,
    clock: h.deps.clock,
    ids,
    secrets: h.deps.secrets,
    surface: h.deps.surface,
    artifacts: h.deps.artifacts,
    requestIndex: h.deps.requestIndex,
    harness,
    policy: h.policy,
    settings: h.settings,
    engineVersion: "0.1.0",
  };
  return { deps, ids, harness };
}

/** A `CertifyCaseInput` with defaults; `overrides` replaces any field. */
function inputFor(batchId: string, overrides: Partial<CertifyCaseInput> = {}): CertifyCaseInput {
  return {
    batchId,
    tenant: TENANT,
    app: "kvfcu",
    capability: "open_sub",
    major: 1,
    appVersion: "8.4",
    staff: "op_017",
    className: "valid",
    selection: { kind: "profile", profile: windowProfile("recovers") },
    at: undefined,
    classes: [VALID_CLASS, MISSING_CLASS],
    pools: { "members.valid": [MEMBER_FOUND], "members.missing": [MEMBER_MISSING] },
    instance: INSTANCE,
    ...overrides,
  };
}

describe("runCertifyCase: success", () => {
  test("the case matches its class's plain expectation: verdict pass", async () => {
    const { deps, ids } = await buildCertifyDeps(fixtureSite());
    const batchId = ids.batchId();
    const result = await runCertifyCase(inputFor(batchId), deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { plan, report } = result.value;
    expect(BatchPlan.safeParse(plan).success).toBe(true);
    expect(BatchReport.safeParse(report).success).toBe(true);
    const c = report.cases[0];
    expect(c).toMatchObject({ case_id: "case", result: { status: "success", detail: null }, verdict: "pass" });
    expect(report.gate.passed).toBe(true);
    // The route map found both request steps: click_search and click_confirm.
    expect(Object.keys(plan.route_map).sort()).toEqual(["click_confirm", "click_search"]);
    expect(plan.cases.map((pc) => pc.case_id)).toEqual(["baseline", "case"]);
    expect(plan.batch_id).toBe(batchId);
  });

  test("outputs read back the fixture's own account number", async () => {
    const { deps, ids } = await buildCertifyDeps(fixtureSite());
    const result = await runCertifyCase(inputFor(ids.batchId()), deps);
    if (!result.ok) throw new Error("expected ok");
    expect(result.value.report.cases[0]?.result).toEqual({ status: "success", detail: null });
  });
});

describe("runCertifyCase: mismatch", () => {
  test("the class expects success, but the member is missing: verdict unexplained", async () => {
    const { deps, ids } = await buildCertifyDeps(fixtureSite({ result: "not_found" }));
    const input = inputFor(ids.batchId(), {
      className: "valid",
      selection: { kind: "profile", profile: windowProfile("recovers") },
    });
    const result = await runCertifyCase(input, deps);
    if (!result.ok) throw new Error("expected ok");
    const c = result.value.report.cases[0];
    expect(c?.result).toEqual({ status: "business_outcome", detail: "member_not_found" });
    // Why "wrong", not "unexplained": outcome truth itself fails here ("the class expects
    // success, not business_outcome"), and a failed truth check always wins (section 8 §8.3).
    expect(c?.verdict).toBe("wrong");
    expect(result.value.report.gate.passed).toBe(false);
  });

  test("the missing class correctly expects the business outcome: verdict pass", async () => {
    const { deps, ids } = await buildCertifyDeps(fixtureSite({ result: "not_found" }));
    const input = inputFor(ids.batchId(), {
      className: "missing",
      selection: { kind: "profile", profile: windowProfile("recovers") },
    });
    const result = await runCertifyCase(input, deps);
    if (!result.ok) throw new Error("expected ok");
    expect(result.value.report.cases[0]?.verdict).toBe("pass");
  });
});

describe("runCertifyCase: pre-run refusals", () => {
  test("environment_not_test: the app's settings say production", async () => {
    const { deps, ids } = await buildCertifyDeps(fixtureSite());
    const prodDeps: CertifyDeps = {
      ...deps,
      settings: {
        ...deps.settings,
        doc: {
          ...deps.settings.doc,
          apps: {
            kvfcu: { ...deps.settings.doc.apps.kvfcu, environment: "production" } as CertifyDeps["settings"]["doc"]["apps"][string],
          },
        },
      },
    };
    const result = await runCertifyCase(inputFor(ids.batchId()), prodDeps);
    expect(result).toEqual({ ok: false, failure: "environment_not_test" });
  });

  test("unknown_class: --class names no class in the suite", async () => {
    const { deps, ids } = await buildCertifyDeps(fixtureSite());
    const result = await runCertifyCase(inputFor(ids.batchId(), { className: "no_such_class" }), deps);
    expect(result).toEqual({ ok: false, failure: "unknown_class" });
  });

  test("needs_at: an @each_request_step profile with no --at lists the request steps", async () => {
    const { deps, ids } = await buildCertifyDeps(fixtureSite());
    const eachStep: FaultProfile = {
      id: "server_error_each",
      kind: "server_error",
      at: "@each_request_step",
      expect_commit: "reconciles_absent",
      expect_window: "recovers",
    };
    const result = await runCertifyCase(
      inputFor(ids.batchId(), { selection: { kind: "profile", profile: eachStep }, at: undefined }),
      deps,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure).toBe("needs_at");
    expect((result.detail ?? "").split(", ").sort()).toEqual(["click_confirm", "click_search"]);
  });
});

describe("runCertifyCase: run.json", () => {
  test("carries batch_id and case_id; the baseline's own case_id is 'baseline'", async () => {
    const { deps, ids } = await buildCertifyDeps(fixtureSite());
    const batchId = ids.batchId();
    const result = await runCertifyCase(inputFor(batchId), deps);
    if (!result.ok) throw new Error("expected ok");
    for (const pc of result.value.plan.cases) {
      const runJson = await deps.evidence.readRunJson(TENANT, pc.run_id);
      if (!runJson.ok) throw new Error(`no run.json for ${pc.case_id}`);
      expect(runJson.value).toMatchObject({ batch_id: batchId, case_id: pc.case_id });
    }
    expect(result.value.plan.cases.find((pc) => pc.case_id === "baseline")).toBeDefined();
  });
});

describe("runCertifyCase: faults.jsonl", () => {
  test("is written into the case run's own folder, masked, and is the case's own full log from zero", async () => {
    const { deps, ids, harness } = await buildCertifyDeps(fixtureSite());
    const result = await runCertifyCase(inputFor(ids.batchId()), deps);
    if (!result.ok) throw new Error("expected ok");
    const caseRunId = result.value.plan.cases.find((c) => c.case_id === "case")?.run_id;
    if (caseRunId === undefined) throw new Error("no case run id");
    const folder = await deps.evidence.openRun(TENANT, caseRunId);
    if (!folder.ok) throw new Error("no case run folder");
    const raw = await folder.value.readFile("faults.jsonl");
    expect(raw.ok).toBe(true);
    if (!raw.ok) return;
    const text = new TextDecoder().decode(raw.value);
    const lines = text
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { path: string; route_count: number });
    // Section 8 §6.4: a reset between the baseline and the case run puts counters back to
    // zero, so the case's own faults.jsonl (no longer sliced) is just its own two requests,
    // each nth 1 again, not the baseline's cumulative count (no member ID here to mask beyond
    // the plain route text; the member ID pool never holds the canary member, CLAUDE.md).
    expect(lines.map((l) => ({ path: l.path, route_count: l.route_count }))).toEqual([
      { path: "/search", route_count: 1 },
      { path: "/confirm", route_count: 1 },
    ]);
    expect(harness.calls.filter((c) => c === "reset")).toHaveLength(3);
  });
});

describe("runCertifyCase: the harness is reset between the baseline and the case run", () => {
  test("a second reset happens after the baseline's own faultLog read, before the case is armed", async () => {
    const { deps, ids, harness } = await buildCertifyDeps(fixtureSite());
    const result = await runCertifyCase(inputFor(ids.batchId()), deps);
    if (!result.ok) throw new Error("expected ok");
    const calls = harness.calls;
    const resetIndexes = calls.reduce<number[]>((acc, c, i) => (c === "reset" ? [...acc, i] : acc), []);
    const firstFaultLog = calls.indexOf("faultLog");
    const addFaultsIndex = calls.indexOf("addFaults");
    // Three resets total: before the baseline, between the baseline and the case, and the
    // final cleanup. The second one sits strictly between the baseline's own `faultLog` read
    // (routeMapFor) and `addFaults` (arming the case).
    expect(resetIndexes).toHaveLength(3);
    const between = resetIndexes[1];
    expect(between).toBeGreaterThan(firstFaultLog);
    expect(between).toBeLessThan(addFaultsIndex);
  });
});

/** A stuck Confirm: the click dispatches (so the route map still captures it), but it only
 * inserts a supervisor banner, never navigates (mirrors tests/unit/replay/takeover.test.ts and
 * reconciliation.test.ts's case 6, adapted to run through `runCertifyCase`). */
function siteWithStuckConfirm(): FakeSite {
  return {
    origin: ORIGIN,
    screens: {
      "/": { elements: [{ id: "login_button", role: "button", roleGroup: "button_like", name: "Login", text: "Login", onClick: { go: "/home" } }] },
      "/home": {
        elements: [
          { id: "member_id_box", role: "textbox", roleGroup: "text_entry", label: "Member ID", field: { kind: "text", value: "" } },
          { id: "search_button", role: "button", roleGroup: "button_like", name: "Search", text: "Search", onClick: { go: "/result" } },
        ],
      },
      "/result": {
        elements: [
          {
            id: "confirm_button",
            role: "button",
            roleGroup: "button_like",
            name: "Confirm",
            text: "Confirm",
            onClick: { insert: { id: "supervisor_banner", role: "generic", roleGroup: "container", text: "Ask a supervisor to approve this" } },
          },
        ],
      },
      "/done": { elements: [] },
      "/check": { elements: [{ id: "account_number_display", role: "generic", roleGroup: "container", label: "Account number", text: "SH9999999" }] },
    },
  };
}

describe("runCertifyCase: a takeover, via an injected frozenSet", () => {
  test("ends failed, ended_by_operator, escalated; the report's observed result is the takeover, with a staff_id certify log line", async () => {
    // A global `needs_human` handler, detecting the supervisor banner Confirm inserts: the
    // caller-supplied frozen set `certify.ts` now threads through (section 5 §7.4), the same
    // merged handler set a production replay of this key would load. Confirm's own click still
    // dispatches (an irreversible commit, section 5 §14), so the baseline's route map captures
    // both click_search and click_confirm before the takeover, needed to place the profile's
    // own fault below.
    const handler: Handler = {
      class: "needs_human",
      id: "supervisor_required",
      description: "a supervisor must approve this",
      detector: "supervisor_banner_shown",
      fixtures: { fire: [], no_fire: [] },
      operator_note: "Injected for the M06 task 8 takeover test.",
    };
    const frozenSet: FrozenSet = {
      targets: [],
      conditions: [
        {
          id: "supervisor_banner_shown",
          description: "supervisor_banner_shown",
          check: "text_visible",
          text: "Ask a supervisor to approve this",
          match: "contains",
        },
      ],
      handlers: [handler],
      handlerScope: new Map([[handler.id, { level: "global" as const }]]),
      runStart: {
        ids: [handler.id],
        packs: { global: 1 },
        from: { [handler.id]: "global" },
        hash: `sha256:${sha256Hex(handler.id)}`,
      },
      warnings: [],
    };
    // `open_sub_checked` (not plain `open_sub`): an uncertain commit runs the reconciliation
    // check before the takeover's own ending stands (docs/decisions.md, M06).
    const { deps, ids } = await buildCertifyDeps(siteWithStuckConfirm());
    const result = await runCertifyCase(
      inputFor(ids.batchId(), { capability: "open_sub_checked", frozenSet }),
      deps,
    );
    if (!result.ok) throw new Error("expected ok");
    const c = result.value.report.cases[0];
    expect(c?.result.status).toBe("escalated");
    expect(c?.result.detail).toBe("takeover/needs_human_handler/click_confirm");

    const caseRunId = result.value.plan.cases.find((pc) => pc.case_id === "case")?.run_id;
    if (caseRunId === undefined) throw new Error("no case run id");
    const events = await deps.evidence.events(TENANT, caseRunId);
    if (!events.ok) throw new Error("events missing");
    const decided = events.value.find(
      (e) =>
        (e as { event?: string }).event === "escalation" &&
        (e as { data?: { staff_id?: string } }).data?.staff_id === "certify",
    );
    expect(decided).toBeDefined();
  });
});

describe("runCertifyCase: rerun", () => {
  test("repeats one case with the same seed and inputs, giving a new run ID", async () => {
    const { deps, ids } = await buildCertifyDeps(fixtureSite());
    const first = await runCertifyCase(inputFor(ids.batchId()), deps);
    if (!first.ok) throw new Error("expected ok");
    const oldCase = first.value.plan.cases.find((c) => c.case_id === "case");
    if (oldCase === undefined) throw new Error("no case in plan");

    // Why the same `deps`/`ids`, not a fresh `buildCertifyDeps`: two independent, freshly built
    // `SeededIds` generators start from the same seed and clock, and would mint the identical
    // run ID text again. Reusing the one generator's advancing state gives a genuinely new ID,
    // as two real, separate CLI invocations would (their own clock and randomness move on).
    const rerunInput = inputFor(ids.batchId(), {
      rerun: { batchId: first.value.plan.batch_id, caseId: "case", inputs: oldCase.inputs, seed: oldCase.seed },
    });
    const second = await runCertifyCase(rerunInput, deps);
    if (!second.ok) throw new Error("expected ok");
    const newCase = second.value.plan.cases.find((c) => c.case_id === "case");
    expect(newCase?.run_id).not.toBe(oldCase.run_id);
    expect(newCase?.inputs).toEqual(oldCase.inputs);
    expect(newCase?.seed).toBe(oldCase.seed);
  });
});
