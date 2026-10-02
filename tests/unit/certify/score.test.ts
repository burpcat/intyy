// Proves the scorer (design section 8 §9.1 outcome score, §9.2 locator margin and fragile steps,
// §8.3 verdicts; section 3 §6.8 step trace): the outcome score leaves `void` out and counts
// `wrong` as not passing; margins are per target (lowest, median, lowest winner score) with the
// batch's lowest named by step; a step is fragile under margin 0.30 or score 0.85, and exactly
// those values are not fragile; votes and traces are read from log lines; a trace ignores times
// and scores. M10 task 3.
import { describe, expect, test } from "vitest";
import {
  batchScores,
  fragileSteps,
  marginSummary,
  outcomeScore,
  stepTrace,
  tracesMatch,
  verdictCounts,
  votesOf,
  type VoteSample,
} from "../../../src/core/certify/score.js";
import type { CaseGroup } from "../../../src/core/model/batch-plan.js";
import type { Verdict } from "../../../src/core/model/batch-report.js";

const c = (group: CaseGroup, verdict: Verdict) => ({ group, verdict });
const vote = (step: string, target: string, margin: number | null, score: number | null): VoteSample => ({
  step,
  target,
  margin,
  score,
});

describe("verdictCounts and outcomeScore", () => {
  test("verdictCounts and outcomeScore count verdicts and score judged runs", () => {
    // verdictCounts counts each verdict, zero when absent
    {
      expect(verdictCounts(["pass", "pass", "wrong", "void", "explained"])).toEqual({
        pass: 2,
        explained: 1,
        assisted: 0,
        unexplained: 0,
        wrong: 1,
        void: 1,
      });
      expect(verdictCounts([])).toEqual({ pass: 0, explained: 0, assisted: 0, unexplained: 0, wrong: 0, void: 0 });
    }
    // pass over judged runs: void is left out, wrong counts as not passing
    {
      const cases = [c("baseline", "pass"), c("matrix", "pass"), c("matrix", "pass"), c("extra", "wrong"), c("drill", "void")];
      expect(outcomeScore(cases)).toBe(3 / 4);
    }
    // baseline, twin, matrix, extra, and drill runs all count
    {
      expect(outcomeScore([c("baseline", "pass"), c("twin", "pass"), c("matrix", "pass"), c("extra", "pass"), c("drill", "wrong")])).toBe(0.8);
    }
    // null when nothing was judged
    {
      expect(outcomeScore([])).toBeNull();
      expect(outcomeScore([c("matrix", "void"), c("baseline", "void")])).toBeNull();
    }
    // all pass is 1
    {
      expect(outcomeScore([c("baseline", "pass"), c("matrix", "pass")])).toBe(1);
    }
  });

  test.each(["explained", "assisted", "unexplained", "wrong"] as const)("a %s run is judged and not passing", (verdict) => {
    expect(outcomeScore([c("matrix", "pass"), c("matrix", verdict)])).toBe(0.5);
  });
});

describe("marginSummary", () => {
  test("marginSummary gives the lowest, median, and winner score per target", () => {
    // per target: lowest margin, median, and lowest winner score; the batch's lowest names its step
    {
      const m = marginSummary([
        vote("open_member", "member_row", 0.24, 0.91),
        vote("open_member", "member_row", 0.6, 0.95),
        vote("open_member", "member_row", 0.52, 0.99),
        vote("click_search", "search_button", 0.61, 0.94),
      ]);
      expect(m.targets).toEqual({
        member_row: { step: "open_member", lowest: 0.24, median: 0.52, score_low: 0.91 },
        search_button: { step: "click_search", lowest: 0.61, median: 0.61, score_low: 0.94 },
      });
      expect(m.lowest).toBe(0.24);
      expect(m.step).toBe("open_member");
    }
    // an even count takes the mean of the two middle margins
    {
      const m = marginSummary([vote("s", "t", 0.2, 0.9), vote("s", "t", 0.4, 0.9), vote("s", "t", 0.6, 0.9), vote("s", "t", 0.8, 0.9)]);
      expect(m.targets.t?.median).toBeCloseTo(0.5, 10);
    }
    // the lowest, not the median, names the batch margin
    {
      const m = marginSummary([vote("a", "ta", 0.9, 0.99), vote("a", "ta", 0.9, 0.99), vote("a", "ta", 0.05, 0.99)]);
      expect(m.lowest).toBe(0.05);
      expect(m.targets.ta?.median).toBe(0.9);
    }
    // no samples: lowest and step are null
    {
      expect(marginSummary([])).toEqual({ lowest: null, step: null, targets: {} });
    }
    // a vote with no margin or no score adds nothing to its column
    {
      const m = marginSummary([vote("s", "t", null, 0.5), vote("s", "t", 0.4, null), vote("s", "t", 0.7, 0.9)]);
      expect(m.targets.t).toMatchObject({ lowest: 0.4, score_low: 0.5 });
    }
  });
});

describe("fragileSteps", () => {
  const target = (step: string, lowest: number, score_low: number) => ({ [step]: { step, lowest, median: 0.5, score_low } });

  test("fragileSteps marks low margins and winner scores, once each, sorted", () => {
    // a lowest margin under 0.30 is fragile
    {
      expect(fragileSteps(target("a", 0.29, 0.99))).toEqual(["a"]);
    }
    // a lowest winner score under 0.85 is fragile
    {
      expect(fragileSteps(target("a", 0.9, 0.84))).toEqual(["a"]);
    }
    // exactly 0.30 and exactly 0.85 are not fragile
    {
      expect(fragileSteps(target("a", 0.3, 0.85))).toEqual([]);
      expect(fragileSteps(target("a", 0.3, 0.99))).toEqual([]);
      expect(fragileSteps(target("a", 0.9, 0.85))).toEqual([]);
    }
    // steps are listed once each, sorted
    {
      const targets = {
        t1: { step: "zeta", lowest: 0.1, median: 0.5, score_low: 0.99 },
        t2: { step: "alpha", lowest: 0.1, median: 0.5, score_low: 0.99 },
        t3: { step: "alpha", lowest: 0.2, median: 0.5, score_low: 0.99 },
        t4: { step: "fine", lowest: 0.9, median: 0.9, score_low: 0.99 },
      };
      expect(fragileSteps(targets)).toEqual(["alpha", "zeta"]);
    }
  });
});

describe("batchScores", () => {
  test("gathers the outcome score, verdict counts, batch margin, and fragile steps", () => {
    const margin = marginSummary([vote("open_member", "member_row", 0.24, 0.91)]);
    expect(batchScores([c("baseline", "pass"), c("matrix", "void")], margin, ["open_member"])).toEqual({
      outcome_score: 1,
      verdicts: { pass: 1, explained: 0, assisted: 0, unexplained: 0, wrong: 0, void: 1 },
      margin: { lowest: 0.24, step: "open_member" },
      fragile: ["open_member"],
    });
  });
});

/** A run-log line in the shape of design section 3 §7.1 examples. */
const line = (event: string, step: string | null, data: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  seq: 1,
  at: "2026-01-15T09:00:00.000Z",
  run_id: "run_2026-01-15_aaaaaaaaaa",
  event,
  step,
  by: "engine",
  data,
  ...extra,
});

describe("votesOf", () => {
  test("reads target_vote lines and skips every other line and malformed ones", () => {
    const lines = [
      line("step_start", "click_search", {}),
      line("target_vote", "click_search", { target: "search_button", margin: 0.61, score: 0.94 }),
      line("target_vote", null, { target: "x", margin: 0.1, score: 0.9 }),
      line("target_vote", "click_confirm", { margin: 0.1, score: 0.9 }),
      line("target_vote", "click_confirm", { target: "confirm_button", margin: null, score: "high" }),
      "not an object",
      null,
      { nothing: true },
    ];
    expect(votesOf(lines)).toEqual([
      { step: "click_search", target: "search_button", margin: 0.61, score: 0.94 },
      { step: "click_confirm", target: "confirm_button", margin: null, score: null },
    ]);
  });
});

describe("stepTrace and tracesMatch", () => {
  const run = (over: { at?: string; score?: number; winner?: number; waitedMs?: number } = {}) => [
    line("run_start", null, {}),
    line("target_vote", "click_search", { target: "search_button", winner: over.winner ?? 1, score: over.score ?? 0.94, margin: 0.6 }, { at: over.at ?? "2026-01-15T09:00:01.000Z" }),
    line("action", "click_search", { type: "click", waited_ms: over.waitedMs ?? 120 }),
    line("step_end", "click_search", { status: "ok" }),
    line("run_end", null, { status: "success" }),
  ];

  test("stepTrace and tracesMatch keep decision lines and compare traces", () => {
    // keeps decision lines and ignores others
    {
      const trace = stepTrace(run());
      expect(trace).toHaveLength(4);
      expect(trace.join("\n")).not.toContain("run_start");
    }
    // times, waits, and scores do not change the trace
    {
      expect(tracesMatch(stepTrace(run()), stepTrace(run({ at: "2030-01-01T00:00:00.000Z", score: 0.5, waitedMs: 9000 })))).toBe(true);
    }
    // a different winner, step, or ending changes the trace
    {
      expect(tracesMatch(stepTrace(run()), stepTrace(run({ winner: 2 })))).toBe(false);
      const other = run();
      other[3] = line("step_end", "click_search", { status: "failed" });
      expect(tracesMatch(stepTrace(run()), stepTrace(other))).toBe(false);
    }
    // tracesMatch: equal traces match; a different length does not; empty traces match
    {
      expect(tracesMatch(["a", "b"], ["a", "b"])).toBe(true);
      expect(tracesMatch(["a", "b"], ["a"])).toBe(false);
      expect(tracesMatch([], [])).toBe(true);
    }
    // trace lines carry no key outside the allowed list
    {
      const trace = stepTrace([line("action", "s", { type: "click", secret_like: "x", value: "raw" })]);
      expect(trace[0]).not.toContain("secret_like");
      expect(trace[0]).not.toContain("raw");
    }
  });
});
