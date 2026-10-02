// Proves the route map: fault log plus run log give each step's route key and count.
// Design section 8 §6.4. M06 task 8.
import { describe, expect, test } from "vitest";
import { actionTimesFromRunLog, buildRouteMap, requestSteps } from "../../../src/core/certify/route-map.js";
import type { FaultLogEntry } from "../../../src/ports/harness.js";

/** One masked `gate` log line, allowed by default. */
function gateLine(step: string | null, at: string, decision: "allowed" | "blocked" | "needs_approval" | "observed" = "allowed") {
  return {
    seq: 1,
    at,
    run_id: "run_2026-01-15_0000000001",
    step,
    by: "engine",
    event: "gate",
    data: { actor: "engine", action: "click", decision },
  };
}

/** One fault log entry at `time`, on `route`, counter `nth`. */
function entry(time: string, route: string, nth: number): FaultLogEntry {
  return {
    seq: nth,
    time,
    method: route.split(" ")[0] ?? "GET",
    path: route.split(" ")[1] ?? "/",
    route_count: nth,
    decision: "pass",
    fault_kind: null,
    block_point: "none",
    style: null,
    named_id: null,
    delay_ms: 0,
  };
}

describe("actionTimesFromRunLog", () => {
  test("keeps only allowed gate lines with a real step, in arrival order", () => {
    const lines = [
      gateLine("click_a", "2026-01-15T09:00:00.000Z"),
      gateLine("click_b", "2026-01-15T09:00:01.000Z", "blocked"),
      gateLine(null, "2026-01-15T09:00:02.000Z"),
      gateLine("session:sign_in", "2026-01-15T09:00:03.000Z"),
      { event: "run_start", seq: 5, at: "2026-01-15T09:00:04.000Z" },
      { no_event_field: true },
    ];
    expect(actionTimesFromRunLog(lines)).toEqual([
      { step: "click_a", at: "2026-01-15T09:00:00.000Z" },
      { step: "session:sign_in", at: "2026-01-15T09:00:03.000Z" },
    ]);
  });

  test("replay action lines are skipped, not parsed as discovery actions: a reviewer's and a handler's", () => {
    const lines = [
      gateLine("click_a", "2026-01-15T09:00:00.000Z"),
      { seq: 2, at: "2026-01-15T09:00:01.000Z", run_id: "r", step: "click_a", by: "reviewer", event: "action", data: { type: "type", ok: true, expected: "x" } },
      { seq: 3, at: "2026-01-15T09:00:02.000Z", run_id: "r", step: "click_a", by: "engine", event: "action", data: { type: "sign_in", ok: false } },
    ];
    expect(actionTimesFromRunLog(lines)).toEqual([{ step: "click_a", at: "2026-01-15T09:00:00.000Z" }]);
  });

  test("an empty log gives no actions", () => {
    expect(actionTimesFromRunLog([])).toEqual([]);
  });
});

describe("buildRouteMap", () => {
  test("each fault log entry belongs to the last action at or before its own time", () => {
    const actions = [
      { step: "type_member_id", at: "2026-01-15T09:00:00.000Z" },
      { step: "click_search", at: "2026-01-15T09:00:05.000Z" },
      { step: "click_confirm", at: "2026-01-15T09:00:10.000Z" },
    ];
    const log = [
      entry("2026-01-15T09:00:05.500Z", "POST /search", 1),
      entry("2026-01-15T09:00:10.200Z", "POST /confirm", 1),
    ];
    const map = buildRouteMap(actions, log);
    expect(map.get("click_search")).toEqual({ route: "POST /search", nth: 1 });
    expect(map.get("click_confirm")).toEqual({ route: "POST /confirm", nth: 1 });
    expect(map.has("type_member_id")).toBe(false);
  });

  test("only the first request of a step is kept (which: first)", () => {
    const actions = [{ step: "click_confirm", at: "2026-01-15T09:00:00.000Z" }];
    const log = [
      entry("2026-01-15T09:00:01.000Z", "POST /confirm", 1),
      entry("2026-01-15T09:00:02.000Z", "POST /confirm", 2),
    ];
    const map = buildRouteMap(actions, log);
    expect(map.get("click_confirm")).toEqual({ route: "POST /confirm", nth: 1 });
  });

  test("a request before any action is dropped", () => {
    const actions = [{ step: "click_confirm", at: "2026-01-15T09:00:10.000Z" }];
    const log = [entry("2026-01-15T09:00:00.000Z", "POST /early", 1)];
    const map = buildRouteMap(actions, log);
    expect(map.size).toBe(0);
  });

  test("a step with no requests, like a fill step, gets no entry", () => {
    const actions = [
      { step: "type_member_id", at: "2026-01-15T09:00:00.000Z" },
      { step: "click_search", at: "2026-01-15T09:00:05.000Z" },
    ];
    const log = [entry("2026-01-15T09:00:05.500Z", "POST /search", 1)];
    const map = buildRouteMap(actions, log);
    expect([...map.keys()]).toEqual(["click_search"]);
  });
});

describe("requestSteps", () => {
  test("lists the steps that sent a request, in the order they were first assigned", () => {
    const map = buildRouteMap(
      [
        { step: "type_member_id", at: "2026-01-15T09:00:00.000Z" },
        { step: "click_search", at: "2026-01-15T09:00:05.000Z" },
        { step: "click_confirm", at: "2026-01-15T09:00:10.000Z" },
      ],
      [entry("2026-01-15T09:00:05.500Z", "POST /search", 1), entry("2026-01-15T09:00:10.500Z", "POST /confirm", 1)],
    );
    expect(requestSteps(map)).toEqual(["click_search", "click_confirm"]);
  });
});
