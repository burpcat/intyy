// Proves the pure parts of the stability runs (design section 8 §7.2 the stability row, §8.4 the
// fault-aware judge and its explained-endings table, §9.3 the curve and twins): `firedFaults` counts
// every non-`pass` log entry and dedupes styles; `explains` reads the kvfcu §8.4 table (copied
// below as data) by status, style, fault count, commit state, and ending; `judgeStability` gives
// pass, assisted, explained, unexplained, or wrong; `ladderFacts` counts a rung's recovery only when
// the next move is `continue` or `resume_at`; `stabilityCurve` gives one row per level with rates
// over judged runs, and twin mismatch as the share of pairs whose traces differ; the schema takes
// `explained_endings` and the curve's whole-number `wrong`. No files, no clock. M10 task 10.
import { describe, expect, test } from "vitest";
import {
  explains,
  firedFaults,
  judgeStability,
  ladderFacts,
  stabilityCurve,
  type FiredFaults,
  type StabilityMeta,
  type StabilityRun,
} from "../../../src/core/certify/stability.js";
import { StabilityLevel, type Verdict } from "../../../src/core/model/batch-report.js";
import { ExplainedEnding, Faults } from "../../../src/core/model/faults.js";
import type { ResultClass } from "../../../src/core/certify/verdicts.js";

/** The kvfcu table of design section 8 §8.4, as data. */
const TABLE: ExplainedEnding[] = [
  { styles: ["maintenance"], status: "failed", endings: ["app_error"] },
  { styles: ["error_page", "blank", "unavailable"], status: "failed", endings: ["app_error"] },
  { styles: ["logout"], status: "failed", endings: ["app_error", "session_lost"] },
  { styles: ["hang"], status: "failed", endings: ["checkpoint_timeout", "action_failed"] },
  { styles: ["*"], min_faults: 3, status: "escalated", endings: ["takeover/stuck"] },
  { styles: ["*"], status: "failed", endings: ["outputs_unavailable"], commit: "found_by_check" },
].map((r) => ExplainedEnding.parse(r));

const failed = (detail: string): ResultClass => ({ status: "failed", detail });
const escalated = (detail: string): ResultClass => ({ status: "escalated", detail });
const fired = (count: number, ...styles: string[]): FiredFaults => ({ count, styles });

describe("firedFaults", () => {
  const entry = (decision: "pass" | "entropy" | "named", style: string | null) => ({ decision, style });

  test("firedFaults counts non-pass entries, dedupes styles, and skips pass styles", () => {
    // pass entries are not counted; entropy and named ones are
    {
      const got = firedFaults([entry("pass", null), entry("entropy", "hang"), entry("pass", null), entry("named", "logout")]);
      expect(got.count).toBe(2);
    }
    // styles are deduped, sorted, and a null style is skipped
    {
      const got = firedFaults([entry("entropy", "logout"), entry("entropy", "blank"), entry("named", null), entry("entropy", "logout")]);
      expect(got).toEqual({ count: 4, styles: ["blank", "logout"] });
    }
    // an empty log fired nothing
    {
      expect(firedFaults([])).toEqual({ count: 0, styles: [] });
    }
    // a style on a pass entry is not a fired style
    {
      expect(firedFaults([entry("pass", "hang")])).toEqual({ count: 0, styles: [] });
    }
  });
});

describe("explains (the kvfcu §8.4 table)", () => {
  test("explains reads the kvfcu table by style, fault count, commit state, and ending", () => {
    // maintenance explains a failed app_error
    {
      expect(explains(TABLE, fired(1, "maintenance"), failed("app_error"), null)).toBe(true);
    }
    // the same ending with a style that did not fire is not explained
    {
      expect(explains(TABLE, fired(1, "hang"), failed("app_error"), null)).toBe(false);
      expect(explains(TABLE, fired(0), failed("app_error"), null)).toBe(false);
    }
    // error_page, blank, and unavailable each explain app_error
    {
      for (const style of ["error_page", "blank", "unavailable"]) {
        expect(explains(TABLE, fired(1, style), failed("app_error"), null)).toBe(true);
      }
    }
    // logout explains session_lost, and hang explains checkpoint_timeout
    {
      expect(explains(TABLE, fired(1, "logout"), failed("session_lost"), null)).toBe(true);
      expect(explains(TABLE, fired(1, "hang"), failed("checkpoint_timeout"), null)).toBe(true);
    }
    // a style explains only its own endings
    {
      expect(explains(TABLE, fired(1, "hang"), failed("session_lost"), null)).toBe(false);
      expect(explains(TABLE, fired(1, "maintenance"), failed("checkpoint_timeout"), null)).toBe(false);
    }
    // `*` with min_faults 3 explains an escalated takeover/stuck with three faults, not two
    {
      const ending = escalated("takeover/stuck/click_search");
      expect(explains(TABLE, fired(3, "blank"), ending, null)).toBe(true);
      expect(explains(TABLE, fired(2, "blank"), ending, null)).toBe(false);
    }
    // an escalation of another kind or reason is not explained
    {
      expect(explains(TABLE, fired(5, "blank"), escalated("takeover/other/click_search"), null)).toBe(false);
      expect(explains(TABLE, fired(5, "blank"), escalated("reconciliation_decision/stuck/click_search"), null)).toBe(false);
    }
    // a rule with a commit state is not met when the commit state differs
    {
      const ending = failed("outputs_unavailable");
      expect(explains(TABLE, fired(1, "hang"), ending, "found_by_check")).toBe(true);
      expect(explains(TABLE, fired(1, "hang"), ending, "confirmed")).toBe(false);
      expect(explains(TABLE, fired(1, "hang"), ending, null)).toBe(false);
    }
    // a business outcome is never explained
    {
      const outcome: ResultClass = { status: "business_outcome", detail: "member_not_found" };
      expect(explains(TABLE, fired(9, "maintenance", "blank"), outcome, null)).toBe(false);
    }
    // a success is never explained
    {
      expect(explains(TABLE, fired(9, "maintenance"), { status: "success", detail: null }, null)).toBe(false);
    }
    // an empty table explains nothing
    {
      expect(explains([], fired(9, "maintenance"), failed("app_error"), null)).toBe(false);
    }
  });
});

describe("judgeStability", () => {
  const base = {
    classMatches: false,
    truth: {},
    helped: false,
    result: failed("app_error"),
    commit: null,
    fired: fired(1, "maintenance"),
    rules: TABLE,
  };

  test("judgeStability gives pass, assisted, explained, unexplained, or wrong", () => {
    // the class's own ending is a pass
    {
      expect(judgeStability({ ...base, classMatches: true, result: { status: "success", detail: null } })).toBe("pass");
    }
    // the class's ending with help is assisted
    {
      expect(judgeStability({ ...base, classMatches: true, helped: true })).toBe("assisted");
    }
    // a listed ending for a style that fired is explained
    {
      expect(judgeStability(base)).toBe("explained");
    }
    // an unlisted ending is unexplained
    {
      expect(judgeStability({ ...base, result: failed("action_failed") })).toBe("unexplained");
    }
    // a failed truth check is wrong, even for a listed ending
    {
      expect(judgeStability({ ...base, truth: { commit: false } })).toBe("wrong");
      expect(judgeStability({ ...base, classMatches: true, truth: { output: false } })).toBe("wrong");
    }
    // an unavailable truth check (null) does not make a run wrong
    {
      expect(judgeStability({ ...base, truth: { commit: null, output: null } })).toBe("explained");
    }
    // with no rules nothing is explained
    {
      expect(judgeStability({ ...base, rules: [] })).toBe("unexplained");
    }
  });
});

describe("ladderFacts", () => {
  const ladder = (rung: number, next: string) => ({ event: "ladder", data: { rung, next } });

  test("ladderFacts counts recovering rungs, lists escalations, and skips bad lines", () => {
    // a rung's recovery counts only when the next move is continue or resume_at
    {
      const got = ladderFacts([
        ladder(1, "continue"),
        ladder(1, "continue"),
        ladder(1, "next_rung"),
        ladder(2, "resume_at"),
        ladder(2, "escalate"),
        ladder(3, "continue"),
        ladder(3, "give_up"),
      ]);
      expect(got.rungs).toEqual([2, 1, 1]);
    }
    // escalations are listed by reason
    {
      const got = ladderFacts([
        { event: "escalation", data: { kind: "takeover", reason: "stuck" } },
        { event: "escalation", data: { kind: "takeover", reason: "stuck" } },
        { event: "escalation", data: { kind: "reconciliation_decision", reason: "reconciliation_waived" } },
      ]);
      expect(got.escalations).toEqual(["stuck", "stuck", "reconciliation_waived"]);
    }
    // other lines and malformed lines are skipped
    {
      const got = ladderFacts(["text", null, 3, { nothing: true }, { event: "gate", data: { rung: 1, next: "continue" } }]);
      expect(got).toEqual({ rungs: [0, 0, 0], escalations: [] });
    }
  });
});

describe("stabilityCurve", () => {
  const run = (verdict: Verdict, over: Partial<StabilityMeta> = {}): StabilityRun => ({
    verdict,
    meta: { entropy: 0.05, seed: 1, twin: false, faults: 0, rungs: [0, 0, 0], escalations: [], trace: ["a"], ...over },
  });

  test("stabilityCurve gives one row per level with rates, sums, and twin mismatch", () => {
    // levels come out ascending, whatever the run order
    {
      const curve = stabilityCurve([run("pass", { entropy: 0.3 }), run("pass", { entropy: 0.05 }), run("pass", { entropy: 0.15 })]);
      expect(curve.map((l) => l.entropy)).toEqual([0.05, 0.15, 0.3]);
    }
    // rates are shares of the level's judged runs, and wrong is a count
    {
      const [level] = stabilityCurve([run("pass"), run("pass"), run("explained"), run("unexplained"), run("assisted"), run("wrong"), run("pass")]);
      expect(level).toMatchObject({ runs: 7, pass: 0.429, explained: 0.143, assisted: 0.143, unexplained: 0.143, wrong: 1 });
      expect(StabilityLevel.safeParse(level).success).toBe(true);
    }
    // a void run is left out of every column
    {
      const [level] = stabilityCurve([
        run("pass", { faults: 2 }),
        run("void", { faults: 40, rungs: [9, 9, 9], escalations: ["stuck"] }),
        run("explained", { faults: 4 }),
      ]);
      expect(level).toMatchObject({ runs: 2, pass: 0.5, explained: 0.5, faults: 3, rungs: { "1": 0, "2": 0, "3": 0 }, escalations: {} });
    }
    // a level whose runs are all void has zeros
    {
      const [level] = stabilityCurve([run("void")]);
      expect(level).toMatchObject({ runs: 0, pass: 0, faults: 0, twin_mismatch: 0, wrong: 0 });
    }
    // faults are the mean; rungs and escalations are summed
    {
      const [level] = stabilityCurve([
        run("pass", { faults: 1, rungs: [2, 0, 0] }),
        run("explained", { faults: 2, rungs: [1, 1, 0], escalations: ["stuck"] }),
        run("explained", { faults: 3, rungs: [0, 0, 1], escalations: ["stuck", "other"] }),
      ]);
      expect(level?.faults).toBe(2);
      expect(level?.rungs).toEqual({ "1": 3, "2": 1, "3": 1 });
      expect(level?.escalations).toEqual({ stuck: 2, other: 1 });
    }
    // twin_mismatch is the share of pairs whose traces differ
    {
      const pair = (seed: number, same: boolean): StabilityRun[] => [
        run("pass", { seed, trace: ["x"] }),
        run("pass", { seed, twin: true, trace: same ? ["x"] : ["y"] }),
      ];
      const [level] = stabilityCurve([...pair(1, true), ...pair(2, false), ...pair(3, true), ...pair(4, true), ...pair(5, true)]);
      expect(level?.twin_mismatch).toBe(0.2);
    }
    // with no pairs twin_mismatch is 0
    {
      expect(stabilityCurve([run("pass", { seed: 1 }), run("pass", { seed: 2 })])[0]?.twin_mismatch).toBe(0);
    }
    // a pair with a void run is ignored
    {
      const [level] = stabilityCurve([
        run("pass", { seed: 1, trace: ["x"] }),
        run("void", { seed: 1, twin: true, trace: ["y"] }),
        run("pass", { seed: 2, trace: ["x"] }),
        run("pass", { seed: 2, twin: true, trace: ["x"] }),
      ]);
      expect(level?.twin_mismatch).toBe(0);
    }
    // twins pair only within their own level
    {
      const curve = stabilityCurve([
        run("pass", { entropy: 0.05, seed: 1, trace: ["x"] }),
        run("pass", { entropy: 0.3, seed: 1, twin: true, trace: ["y"] }),
      ]);
      expect(curve.map((l) => l.twin_mismatch)).toEqual([0, 0]);
    }
    // no runs, no rows
    {
      expect(stabilityCurve([])).toEqual([]);
    }
  });
});

describe("the schemas", () => {
  const doc = { schema: "intyy.faults/1.0", app: "kvfcu", revision: 1, profiles: [] };

  test("the schemas accept explained_endings and a whole-number wrong", () => {
    // Faults accepts explained_endings, with min_faults and commit
    {
      const r = Faults.safeParse({ ...doc, explained_endings: TABLE });
      expect(r.success).toBe(true);
    }
    // Faults still parses with no explained_endings
    {
      expect(Faults.safeParse(doc).success).toBe(true);
    }
    // an explained ending rejects an unknown field, an empty list, and a bad status
    {
      const one = { styles: ["hang"], status: "failed", endings: ["action_failed"] };
      expect(Faults.safeParse({ ...doc, explained_endings: [{ ...one, extra: 1 }] }).success).toBe(false);
      expect(Faults.safeParse({ ...doc, explained_endings: [{ ...one, styles: [] }] }).success).toBe(false);
      expect(Faults.safeParse({ ...doc, explained_endings: [{ ...one, status: "success" }] }).success).toBe(false);
    }
    // StabilityLevel rejects a fractional wrong count
    {
      const [level] = stabilityCurve([{ verdict: "pass", meta: { entropy: 0.05, seed: 1, twin: false, faults: 0, rungs: [0, 0, 0], escalations: [], trace: [] } }]);
      expect(StabilityLevel.safeParse(level).success).toBe(true);
      expect(StabilityLevel.safeParse({ ...level, wrong: 0.5 }).success).toBe(false);
    }
  });
});
