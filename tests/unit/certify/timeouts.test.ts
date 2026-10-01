// Proves the pure parts of tuned timeouts (design section 8 §9.6; section 6 §14.11 the floors):
// `cleanSamples` keeps a step's first pass, with no ladder line, from `step_end` (`observed_ms`) or
// the commit step's passed checkpoint `check` (`waited_ms`), and skips prelude steps and failures;
// `stepDelays` gives each fault log entry to the last action at or before its time and keeps the
// longest delay per step; `batchWasScaled` is the 5 s cross-check; `proposeOne` takes the largest of
// the floor, 1.5 x the 95th percentile (nearest rank), and 1.2 x the longest sample, rounded up to
// 500 ms and capped at 60 s; `timeoutsReport` lists a step with too few samples, and proposes
// nothing for a scaled batch. No files, no clock. M10 task 11.
import { describe, expect, test } from "vitest";
import {
  FLOORS,
  MIN_SAMPLES,
  TIMEOUT_CAP_MS,
  batchWasScaled,
  cleanSamples,
  proposeOne,
  stepDelays,
  timeoutsReport,
  type TimedRun,
} from "../../../src/core/certify/timeouts.js";
import { BatchTimeouts } from "../../../src/core/model/batch-report.js";
import type { FaultLogEntry } from "../../../src/ports/harness.js";

const stepEnd = (step: string, observed_ms: number, result = "passed") => ({ event: "step_end", step, data: { result, observed_ms } });
const check = (step: string, waited_ms: number, over: { role?: string; passed?: boolean } = {}) => ({
  event: "check",
  step,
  data: { condition: "done_shown", role: over.role ?? "checkpoint", passed: over.passed ?? true, waited_ms },
});
const ladder = (step: string) => ({ event: "ladder", step, data: { rung: 1, next: "continue" } });

describe("cleanSamples", () => {
  test("a passed step_end with observed_ms is a sample", () => {
    expect(cleanSamples([stepEnd("click_search", 1200)])).toEqual([{ step: "click_search", ms: 1200 }]);
  });

  test("a passed commit checkpoint check with waited_ms is a sample", () => {
    expect(cleanSamples([check("click_confirm", 3400)])).toEqual([{ step: "click_confirm", ms: 3400 }]);
  });

  test("a step with any ladder line gives none, wherever the line sits", () => {
    expect(cleanSamples([stepEnd("a", 100), ladder("a"), stepEnd("b", 200)])).toEqual([{ step: "b", ms: 200 }]);
    expect(cleanSamples([ladder("a"), stepEnd("a", 100)])).toEqual([]);
  });

  test("only a step's first pass counts", () => {
    expect(cleanSamples([stepEnd("a", 100), stepEnd("a", 900)])).toEqual([{ step: "a", ms: 100 }]);
  });

  test("a prelude step (session:*) gives none", () => {
    expect(cleanSamples([stepEnd("session:click_login", 100), check("session:x", 5)])).toEqual([]);
  });

  test("a failed checkpoint, a sweep check, or a step that did not pass gives none", () => {
    expect(cleanSamples([check("a", 100, { passed: false })])).toEqual([]);
    expect(cleanSamples([check("a", 100, { role: "sweep" })])).toEqual([]);
    expect(cleanSamples([stepEnd("a", 100, "done_by_human")])).toEqual([]);
  });

  test("lines with no step, no number, or no event are skipped", () => {
    expect(cleanSamples([{ event: "step_end", step: null, data: { result: "passed", observed_ms: 5 } }, { event: "step_end", step: "a", data: { result: "passed" } }, "x", null, {}])).toEqual([]);
  });
});

describe("stepDelays", () => {
  const gate = (step: string, at: string) => ({ seq: 1, at, run_id: "run_x", step, by: "engine", event: "gate", data: { actor: "engine", action: "click", decision: "allowed" } });
  const entry = (time: string, delay_ms: number): FaultLogEntry => ({
    seq: 1, time, method: "POST", path: "/x", route_count: 1, decision: "pass", fault_kind: null, block_point: "none", style: null, named_id: null, delay_ms,
  });
  const lines = [gate("a", "2026-01-15T09:00:00.000Z"), gate("b", "2026-01-15T09:00:10.000Z")];

  test("each entry belongs to the last action at or before its time; the result is the longest delay per step", () => {
    const got = stepDelays(lines, [
      entry("2026-01-15T09:00:01.000Z", 300),
      entry("2026-01-15T09:00:02.000Z", 7000),
      entry("2026-01-15T09:00:10.000Z", 120),
      entry("2026-01-15T09:00:11.000Z", 90),
    ]);
    expect(Object.fromEntries(got)).toEqual({ a: 7000, b: 120 });
  });

  test("an entry before every action belongs to no step", () => {
    expect(stepDelays(lines, [entry("2026-01-15T08:59:59.000Z", 9000)]).size).toBe(0);
  });
});

describe("batchWasScaled", () => {
  const run = (delay: number, ms?: number): TimedRun => ({
    samples: ms === undefined ? [] : [{ step: "s", ms }],
    delays: new Map([["s", delay]]),
  });

  test("a 5 s delay with a 100 ms sample means the batch was scaled", () => {
    expect(batchWasScaled([run(5000, 100)])).toBe(true);
  });

  test("a delay under 5 s never counts", () => {
    expect(batchWasScaled([run(4900, 100)])).toBe(false);
  });

  test("a step with no sample cannot show scaling", () => {
    expect(batchWasScaled([run(9000)])).toBe(false);
  });

  test("a sample as long as the delay is normal", () => {
    expect(batchWasScaled([run(5000, 5200)])).toBe(false);
  });

  test("one scaled run among clean runs is enough", () => {
    expect(batchWasScaled([run(0, 100), run(6000, 6100), run(6000, 50)])).toBe(true);
  });

  test("a delay of one step is not checked against a sample of another", () => {
    expect(batchWasScaled([{ samples: [{ step: "t", ms: 100 }], delays: new Map([["s", 8000]]) }])).toBe(false);
  });
});

describe("proposeOne", () => {
  const ones = (n: number) => Array<number>(n).fill(1000);

  test("20 samples of 1 s give the floor of each kind", () => {
    expect(FLOORS).toEqual({ fill: 5000, request: 10000, commit: 15000 });
    expect(proposeOne("fill", ones(20))).toBe(5000);
    expect(proposeOne("request", ones(20))).toBe(10000);
    expect(proposeOne("commit", ones(20))).toBe(15000);
  });

  test("1.5 x the 95th percentile wins when it is the largest", () => {
    expect(proposeOne("request", [...ones(18), 12000, 12000])).toBe(18000);
  });

  test("1.2 x the longest sample wins when it is the largest", () => {
    expect(proposeOne("request", [...ones(18), 10000, 20000])).toBe(24000);
  });

  test("it rounds up to the next 500 ms, and leaves an exact multiple alone", () => {
    expect(proposeOne("fill", [...ones(18), 4934, 4934])).toBe(7500);
    expect(proposeOne("fill", [...ones(18), 6000, 6000])).toBe(9000);
  });

  test("a huge sample is capped at 60 s", () => {
    expect(TIMEOUT_CAP_MS).toBe(60000);
    expect(proposeOne("request", [...ones(19), 100000])).toBe(60000);
  });

  test("the 95th percentile is the nearest rank, not interpolated, whatever the order", () => {
    // 20 samples, 1 s to 20 s. Rank 19 is 19 s: 1.5 x 19000 = 28500 (an interpolated 19.05 s would give 29000).
    const ms = Array.from({ length: 20 }, (_, i) => (i + 1) * 1000);
    expect(proposeOne("fill", ms)).toBe(28500);
    expect(proposeOne("fill", [...ms].reverse())).toBe(28500);
  });
});

describe("timeoutsReport", () => {
  const samples = (step: string, n: number, ms = 1000) => Array.from({ length: n }, () => ({ step, ms }));
  const kinds = { type_member_id: "fill", click_search: "request", click_confirm: "commit" } as const;
  const none = { values: {}, from: null };

  test("a step with too few samples is listed with its count; the others are proposed", () => {
    const r = timeoutsReport([{ samples: [...samples("click_search", MIN_SAMPLES), ...samples("type_member_id", 14)], delays: new Map() }], kinds, none);
    expect(r.proposed).toEqual({ click_search: 10000 });
    expect(r.not_proposed).toEqual({ type_member_id: "14 samples", click_confirm: "0 samples" });
    expect(r.scaled).toBeUndefined();
    expect(BatchTimeouts.safeParse(r).success).toBe(true);
  });

  test("samples add up across runs", () => {
    const runs: TimedRun[] = Array.from({ length: 4 }, () => ({ samples: samples("click_confirm", 5), delays: new Map() }));
    expect(timeoutsReport(runs, kinds, none).proposed).toEqual({ click_confirm: 15000 });
  });

  test("a scaled batch proposes nothing and says so", () => {
    const run: TimedRun = { samples: [...samples("click_search", 30), { step: "click_search", ms: 100 }], delays: new Map([["click_search", 6000]]) };
    const r = timeoutsReport([run], kinds, none);
    expect(r).toMatchObject({ proposed: {}, scaled: true });
    expect(BatchTimeouts.safeParse(r).success).toBe(true);
  });

  test("ran_with and ran_with_from echo the input", () => {
    const r = timeoutsReport([], kinds, { values: { click_search: 12000 }, from: "batch_a" });
    expect(r.ran_with).toEqual({ click_search: 12000 });
    expect(r.ran_with_from).toBe("batch_a");
    expect(timeoutsReport([], kinds, none).ran_with_from).toBeNull();
  });
});
