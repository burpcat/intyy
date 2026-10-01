// Proves the two demotion rules and the exclude and restore decisions (design section 8 §12.3 the
// window rule and the streak rule, §12.5 excluding runs, §10.8 restore after excluded runs, §5.2
// the record is a pure function of both logs, §5.4 `degraded` and `restored` lines, §5.6 writes
// under the score lock): at least 20 counted runs and a score below 0.90 degrade (19 runs do not,
// 18 of 20 do not, 17 of 20 do) and the window slides at 50; three recipe failures in a row at one
// step and one code degrade, while two, a different step, a different code, or a clean run between
// do not, and an app failure between does not break the streak; only an approved key degrades;
// lines at or before the last approval or restore are ignored; `recordLive` appends the live line,
// rebuilds the record, and degrades by `live_score` with the rule and the runs; `excludeRuns`
// needs an approver and known runs; `restoreAfterExclusion` refuses with no exclusion, with a rule
// that still fires, and after a human demotion, and otherwise restores with `batch: null` and the
// exclusion's time; a later clean run does not degrade again. The record's `live` blocks come from
// both logs and rebuild to the same bytes. Fake store, fake clock, in-memory locks. M11 task 2.
import { describe, expect, test } from "vitest";
import { canonicalJson } from "../../../src/core/model/canonical.js";
import type { HistoryLine } from "../../../src/core/model/score-history.js";
import type { ScoreRecord } from "../../../src/core/model/score.js";
import { demoteKey, excludeRuns, restoreAfterExclusion, type Decider } from "../../../src/core/trust/decisions.js";
import { keyPath } from "../../../src/core/trust/keys.js";
import { evaluateRules, excludedRuns, windowStart } from "../../../src/core/trust/live-rules.js";
import { rebuild } from "../../../src/core/trust/rebuild.js";
import { appendHistory, recordLive } from "../../../src/core/trust/scores.js";
import { approved, batch, degraded, h, HASHES, KEY, restored } from "./kit.js";
import { at, live, lives, runId, WHO, world } from "./live-kit.js";
import type { LiveLine } from "../../../src/core/model/live-line.js";

const PATH = keyPath(KEY);
const APPROVED: HistoryLine[] = [batch(1, "batch_a"), approved(2)];

/** Lines 1 to `n` where every `period`th line from `from` is `cls`, and the rest are clean. */
function spaced(n: number, bad: number[], cls: LiveLine["class"] = "assisted"): LiveLine[] {
  return Array.from({ length: n }, (_, i) => live(i + 1, bad.includes(i + 1) ? cls : "clean"));
}

/** Failures with the given step and code, run IDs from `from`. */
const fails = (from: number, count: number, step = "click_search", code = "target_not_found"): LiveLine[] =>
  Array.from({ length: count }, (_, i) => live(from + i, "recipe_failure", { step, code }));

const fire = (l: LiveLine[], history: HistoryLine[] = APPROVED) => evaluateRules("approved", history, l);

describe("window rule: at least 20 counted runs and a score below 0.90 (section 8 §12.3)", () => {
  test("19 counted runs never degrade, however bad", () => {
    expect(fire(spaced(19, [2, 4, 6, 8, 10, 12, 14, 16, 18]))).toBeNull();
  });
  test("20 runs with 2 not clean is exactly 0.90 and does not degrade", () => {
    expect(fire(spaced(20, [5, 15]))).toBeNull();
  });
  test("20 runs with 3 not clean (0.85) degrade, naming the rule and the three runs", () => {
    const hit = fire(spaced(20, [3, 9, 17]));
    expect(hit).toMatchObject({ rule: "window", runs: [runId(3), runId(9), runId(17)] });
    expect(hit?.reason).toContain("0.85");
  });
  test("recipe failures spread apart count the same as assisted runs", () => {
    expect(fire(spaced(20, [3, 9, 17], "recipe_failure"))).toMatchObject({ rule: "window" });
  });
  test("the window is the last 50 counted runs: old trouble slides out", () => {
    const early = [1, 2, 3, 4, 5, 6];
    expect(fire(spaced(50, early))).toMatchObject({ rule: "window", runs: early.map(runId) });
    // Three more clean runs push three of the six out of the window: 47 of 50 is 0.94.
    expect(fire(spaced(53, early))).toBeNull();
  });
  test("50 counted runs with exactly 5 not clean is 0.90 and does not degrade", () => {
    expect(fire(spaced(50, [1, 2, 3, 4, 5]))).toBeNull();
  });
});

describe("streak rule: three recipe failures in a row, one step, one code (section 8 §12.3)", () => {
  test("two failures do not degrade", () => {
    expect(fire([...lives(1, 5), ...fails(6, 2)])).toBeNull();
  });
  test("three at one step and code degrade, naming the three runs", () => {
    const hit = fire([...lives(1, 5), ...fails(6, 3)]);
    expect(hit).toMatchObject({ rule: "streak", runs: [runId(6), runId(7), runId(8)] });
    expect(hit?.reason).toContain("click_search");
    expect(hit?.reason).toContain("target_not_found");
  });
  test("a fourth failure still names the last three", () => {
    expect(fire(fails(1, 4))).toMatchObject({ rule: "streak", runs: [runId(2), runId(3), runId(4)] });
  });
  test("a different step in the chain breaks it", () => {
    expect(fire([...fails(1, 2), ...fails(3, 1, "other_step")])).toBeNull();
  });
  test("a different code in the chain breaks it", () => {
    expect(fire([...fails(1, 2), ...fails(3, 1, "click_search", "action_failed")])).toBeNull();
  });
  test("a clean run between breaks it", () => {
    expect(fire([...fails(1, 2), live(3, "clean"), ...fails(4, 1)])).toBeNull();
  });
  test("an assisted run between breaks it", () => {
    expect(fire([...fails(1, 2), live(3, "assisted"), ...fails(4, 1)])).toBeNull();
  });
  test("an app failure between does not break it", () => {
    const hit = fire([...fails(1, 2), live(3, "app_failure", { code: "app_error" }), ...fails(4, 1)]);
    expect(hit).toMatchObject({ rule: "streak", runs: [runId(1), runId(2), runId(4)] });
  });
  test("a not_counted run between does not break it", () => {
    expect(fire([...fails(1, 2), live(3, "not_counted", { code: "internal_error" }), ...fails(4, 1)])).toMatchObject({ rule: "streak" });
  });
  test("a clean run after the failures ends the streak", () => {
    expect(fire([...fails(1, 3), live(4, "clean")])).toBeNull();
  });
  test("an excluded run is dropped, and the chain closes up or falls short", () => {
    const history: HistoryLine[] = [...APPROVED, { event: "excluded", at: at(0), by: "op_022", reason: "Outage.", runs: [runId(2)] }];
    expect(fire(fails(1, 3), history)).toBeNull();
    expect(fire(fails(1, 4), history)).toMatchObject({ rule: "streak", runs: [runId(1), runId(3), runId(4)] });
  });
});

describe("scope: who can degrade and which lines count", () => {
  test.each(["draft", "degraded", "retired"] as const)("a %s key never degrades", (state) => {
    expect(evaluateRules(state, [], fails(1, 5))).toBeNull();
    expect(evaluateRules(state, [], spaced(20, [3, 9, 17]))).toBeNull();
  });
  test("lines at or before the last approval are ignored", () => {
    const history = [batch(1, "batch_a"), { ...approved(2), at: at(5) }];
    expect(windowStart(history)).toBe(at(5));
    // Runs 3 to 5 sit at or before the approval; only runs 6 and 7 count.
    expect(fire(fails(3, 5), history)).toBeNull();
    expect(fire(fails(3, 6), history)).toMatchObject({ rule: "streak", runs: [runId(6), runId(7), runId(8)] });
  });
  test("lines at or before the last restore are ignored", () => {
    const history = [...APPROVED, degraded(3), { ...restored(4), at: at(5) }];
    expect(windowStart(history)).toBe(at(5));
    expect(fire(fails(1, 6), history)).toBeNull();
  });
  test("a key with no approval line reads every line", () => {
    expect(windowStart([])).toBeNull();
    expect(fire(fails(1, 3), [])).toMatchObject({ rule: "streak" });
  });
  test("excludedRuns gathers the runs of every excluded line", () => {
    const history: HistoryLine[] = [
      { event: "excluded", at: at(0), by: "op_022", reason: "a", runs: [runId(1)] },
      { event: "excluded", at: at(1), by: "op_022", reason: "b", runs: [runId(2), runId(3)] },
    ];
    expect([...excludedRuns(history)].sort()).toEqual([runId(1), runId(2), runId(3)]);
  });
});

describe("recordLive: append, rebuild, and degrade under the lock (section 8 §5.6, §12.3)", () => {
  /** An approved key in a fresh world. */
  async function approvedWorld() {
    const w = world();
    for (const line of APPROVED) {
      const r = await appendHistory(w.deps, KEY, line, WHO);
      if (!r.ok) throw new Error(`test setup: ${r.detail ?? r.failure}`);
    }
    return w;
  }
  const record = async (w: ReturnType<typeof world>): Promise<ScoreRecord> => {
    const r = await w.scores.getRecord(PATH);
    if (!r.ok) throw new Error("no record");
    return r.value;
  };
  const historyOf = async (w: ReturnType<typeof world>): Promise<HistoryLine[]> => {
    const r = await w.scores.history(PATH);
    return r.ok ? r.value : [];
  };

  test("three recipe failures at one step degrade the key by live_score, with the rule and the runs", async () => {
    const w = await approvedWorld();
    const now = new Date(at(100));
    for (const f of fails(1, 2)) {
      const r = await recordLive(w.deps, KEY, f, WHO, now);
      expect(r.ok && r.value.degraded).toBeNull();
      expect(r.ok && r.value.record.state).toBe("approved");
    }
    const third = await recordLive(w.deps, KEY, fails(3, 1)[0] as LiveLine, WHO, now);
    if (!third.ok) throw new Error(third.detail ?? third.failure);
    expect(third.value.degraded).toMatchObject({ rule: "streak" });
    expect(third.value.record).toMatchObject({ state: "degraded", state_by: "live_score", state_since: now.toISOString() });
    expect(await record(w)).toEqual(third.value.record);
    const line = (await historyOf(w)).at(-1);
    expect(line).toMatchObject({
      event: "degraded",
      at: now.toISOString(),
      by: "live_score",
      rule: "streak",
      runs: [runId(1), runId(2), runId(3)],
    });
    expect(line?.reason).toContain("target_not_found");
    const stored = await w.scores.liveLines(PATH);
    expect(stored.ok && stored.value.map((l) => l.run_id)).toEqual([runId(1), runId(2), runId(3)]);
  });

  test("the window rule degrades on the 20th counted run, listing the runs that were not clean", async () => {
    const w = await approvedWorld();
    const all = spaced(20, [3, 9, 17]);
    for (const l of all.slice(0, 19)) {
      const r = await recordLive(w.deps, KEY, l, WHO, new Date(at(100)));
      expect(r.ok && r.value.degraded).toBeNull();
    }
    const last = await recordLive(w.deps, KEY, all[19] as LiveLine, WHO, new Date(at(100)));
    if (!last.ok) throw new Error("recordLive failed");
    expect(last.value.record.state).toBe("degraded");
    expect((await historyOf(w)).at(-1)).toMatchObject({ event: "degraded", by: "live_score", rule: "window", runs: [runId(3), runId(9), runId(17)] });
  });

  test("a draft key keeps its live lines and live block but is never degraded", async () => {
    const w = world();
    for (const f of fails(1, 3)) await recordLive(w.deps, KEY, f, WHO, new Date(at(100)));
    const rec = await record(w);
    expect(rec.state).toBe("draft");
    expect(rec.live?.current).toMatchObject({ counted: 3, recipe_failures: 3, clean: 0, score: 0, streak: 3 });
    expect((await historyOf(w)).filter((l) => l.event === "degraded")).toEqual([]);
  });

  test("an already degraded key takes live lines without a second degraded line", async () => {
    const w = await approvedWorld();
    for (const f of fails(1, 4)) await recordLive(w.deps, KEY, f, WHO, new Date(at(100)));
    expect((await historyOf(w)).filter((l) => l.event === "degraded")).toHaveLength(1);
    expect((await record(w)).live?.current.counted).toBe(4);
  });

  test("a failed write gives write_failed, writes no line and no record, and frees the lock", async () => {
    const w = await approvedWorld();
    const before = await record(w);
    w.scores.failWrites = true;
    const r = await recordLive(w.deps, KEY, live(1), WHO, new Date(at(100)));
    expect(r).toMatchObject({ ok: false, failure: "write_failed" });
    w.scores.failWrites = false;
    expect(await w.scores.liveLines(PATH)).toEqual({ ok: true, value: [] });
    expect(await record(w)).toEqual(before);
    expect(await recordLive(w.deps, KEY, live(1), WHO, new Date(at(100)))).toMatchObject({ ok: true });
  });

  test("a held score lock gives busy and writes nothing", async () => {
    const w = await approvedWorld();
    const other = await w.other.acquire("score", KEY.tenant, { ...WHO, waitMs: 0 });
    expect(other.ok).toBe(true);
    const r = await recordLive(w.deps, KEY, live(1), WHO, new Date(at(100)));
    expect(r).toMatchObject({ ok: false, failure: "busy" });
    expect(await w.scores.liveLines(PATH)).toEqual({ ok: true, value: [] });
  });
});

describe("the record's live blocks come from both logs (section 8 §5.3, §15.3)", () => {
  const A = h("set-a");
  const B = h("set-b");
  const under = (hs: string | null) => ({ engine: "0.4.0", handler_set: hs, jev: null });
  const built = (history: HistoryLine[], lines: LiveLine[]): ScoreRecord => {
    const r = rebuild(KEY, HASHES, history, lines);
    if (!r.ok) throw new Error("rebuild failed");
    return r.value;
  };

  test("no live lines give live: null", () => {
    expect(built(APPROVED, []).live).toBeNull();
  });
  test("current is the handler set of the latest line, previous the set before it", () => {
    const lines = [
      live(1, "clean", { under: under(A) }),
      live(2, "clean", { under: under(A) }),
      live(3, "assisted", { under: under(A) }),
      live(4, "clean", { under: under(B) }),
      live(5, "clean", { under: under(B) }),
      live(6, "recipe_failure", { under: under(B) }),
      live(7, "app_failure", { code: "app_error", under: under(B) }),
    ];
    expect(built(APPROVED, lines).live).toEqual({
      current: { handler_set: B, window: 50, counted: 3, clean: 2, assisted: 0, recipe_failures: 1, app_failures: 1, score: 2 / 3, streak: 1 },
      previous: { handler_set: A, window: 50, counted: 3, clean: 2, assisted: 1, recipe_failures: 0, app_failures: 0, score: 2 / 3, streak: null },
    });
  });
  test("one handler set gives no previous block", () => {
    expect(built(APPROVED, lives(1, 3)).live).toMatchObject({ current: { counted: 3, score: 1 }, previous: null });
  });
  test("an excluded run is not counted", () => {
    const history: HistoryLine[] = [...APPROVED, { event: "excluded", at: at(0), by: "op_022", reason: "Outage.", runs: [runId(2)] }];
    const lines = [live(1), live(2, "recipe_failure"), live(3)];
    expect(built(history, lines).live?.current).toMatchObject({ counted: 2, clean: 2, recipe_failures: 0, score: 1 });
  });
  test("the block holds only the last 50 counted runs", () => {
    const rec = built(APPROVED, spaced(53, [1, 2, 3]));
    expect(rec.live?.current).toMatchObject({ counted: 50, clean: 50, assisted: 0, score: 1 });
  });
  test("live lines never move the state", () => {
    expect(built(APPROVED, fails(1, 5)).state).toBe("approved");
  });
  test("rebuilding the same logs twice gives equal bytes", () => {
    const lines = [live(1, "clean", { under: under(A) }), live(2, "recipe_failure", { under: under(B) })];
    expect(canonicalJson(built(APPROVED, lines))).toBe(canonicalJson(built(structuredClone(APPROVED), structuredClone(lines))));
  });
});

describe("exclude and restore (section 8 §10.8, §12.5)", () => {
  const OP: Decider["roles"] = ["operator"];
  const APR: Decider["roles"] = ["approver"];
  const decider = (minute: number, roles: Decider["roles"] = APR, staff = "op_022"): Decider => ({ at: new Date(at(minute)), staff, roles, who: WHO });

  /** An approved key that three failures (runs 1 to 3) degraded at minute 100. */
  async function degradedWorld(extra: LiveLine[] = []) {
    const w = world();
    for (const line of APPROVED) await appendHistory(w.deps, KEY, line, WHO);
    for (const f of [...fails(1, 3), ...extra]) await recordLive(w.deps, KEY, f, WHO, new Date(at(100)));
    return w;
  }
  const record = async (w: ReturnType<typeof world>): Promise<ScoreRecord> => {
    const r = await w.scores.getRecord(PATH);
    if (!r.ok) throw new Error("no record");
    return r.value;
  };
  const history = async (w: ReturnType<typeof world>): Promise<HistoryLine[]> => {
    const r = await w.scores.history(PATH);
    return r.ok ? r.value : [];
  };

  test("excludeRuns needs the approver role and writes nothing without it", async () => {
    const w = await degradedWorld();
    const before = (await history(w)).length;
    const r = await excludeRuns(w.deps, await record(w), decider(110, OP), { runs: [runId(1)], reason: "Outage." });
    expect(r).toMatchObject({ ok: false, failure: "role" });
    expect(await history(w)).toHaveLength(before);
  });

  test("a run that is not a live line of the key gives unknown_run and writes nothing", async () => {
    const w = await degradedWorld();
    const before = (await history(w)).length;
    const r = await excludeRuns(w.deps, await record(w), decider(110), { runs: [runId(1), runId(77)], reason: "Outage." });
    expect(r).toMatchObject({ ok: false, failure: "unknown_run" });
    expect(r.ok ? "" : r.detail).toContain(runId(77));
    expect(await history(w)).toHaveLength(before);
  });

  test("excludeRuns appends one excluded line with the runs, the reason, and the staff ID", async () => {
    const w = await degradedWorld();
    const r = await excludeRuns(w.deps, await record(w), decider(110), { runs: [runId(1), runId(1), runId(2)], reason: "Known bank outage." });
    expect(r.ok).toBe(true);
    expect((await history(w)).at(-1)).toEqual({
      event: "excluded",
      at: at(110),
      by: "op_022",
      reason: "Known bank outage.",
      runs: [runId(1), runId(2)],
    });
    expect((await record(w)).live?.current).toMatchObject({ counted: 1, recipe_failures: 1 });
  });

  test("restoreAfterExclusion with nothing excluded gives no_exclusion", async () => {
    const w = await degradedWorld();
    const r = await restoreAfterExclusion(w.deps, await record(w), decider(120), { note: null });
    expect(r).toMatchObject({ ok: false, failure: "no_exclusion" });
    expect((await record(w)).state).toBe("degraded");
  });

  test("it needs the approver role", async () => {
    const w = await degradedWorld();
    await excludeRuns(w.deps, await record(w), decider(110), { runs: [runId(1), runId(2)], reason: "Outage." });
    const r = await restoreAfterExclusion(w.deps, await record(w), decider(120, OP), { note: null });
    expect(r).toMatchObject({ ok: false, failure: "role" });
  });

  test("a rule that still fires after the exclusion gives rule_still_fires, until enough runs are excluded", async () => {
    // Run 4 fails too, after the key degraded: runs 2, 3, and 4 are still a streak once run 1 is out.
    const w = await degradedWorld(fails(4, 1));
    await excludeRuns(w.deps, await record(w), decider(110), { runs: [runId(1)], reason: "Outage." });
    const still = await restoreAfterExclusion(w.deps, await record(w), decider(120), { note: null });
    expect(still).toMatchObject({ ok: false, failure: "rule_still_fires" });
    expect((await record(w)).state).toBe("degraded");
    expect((await history(w)).filter((l) => l.event === "restored")).toEqual([]);

    await excludeRuns(w.deps, await record(w), decider(111), { runs: [runId(2)], reason: "Outage, more runs." });
    const done = await restoreAfterExclusion(w.deps, await record(w), decider(121), { note: null });
    expect(done.ok).toBe(true);
  });

  test("success restores to approved with batch null and the exclusion's time", async () => {
    const w = await degradedWorld();
    await excludeRuns(w.deps, await record(w), decider(110), { runs: [runId(1), runId(2), runId(3)], reason: "Outage." });
    const r = await restoreAfterExclusion(w.deps, await record(w), decider(120), { note: "Bank confirmed the outage." });
    if (!r.ok) throw new Error(r.detail ?? r.failure);
    expect(r.value).toMatchObject({ state: "approved", state_by: "op_022", state_since: at(120) });
    expect((await history(w)).at(-1)).toEqual({
      event: "restored",
      at: at(120),
      by: "op_022",
      reason: "Bank confirmed the outage.",
      batch: null,
      exclusion: at(110),
    });
  });

  test("with two exclusion lines, the restore names the one that cleared the rule", async () => {
    const w = await degradedWorld();
    await excludeRuns(w.deps, await record(w), decider(110), { runs: [runId(1)], reason: "First." });
    await excludeRuns(w.deps, await record(w), decider(111), { runs: [runId(2)], reason: "Second." });
    await restoreAfterExclusion(w.deps, await record(w), decider(120), { note: null });
    expect((await history(w)).at(-1)).toMatchObject({ event: "restored", batch: null, exclusion: at(111) });
  });

  test("after the restore, a clean run does not degrade the key again", async () => {
    const w = await degradedWorld();
    await excludeRuns(w.deps, await record(w), decider(110), { runs: [runId(1), runId(2), runId(3)], reason: "Outage." });
    await restoreAfterExclusion(w.deps, await record(w), decider(120), { note: null });
    const next = await recordLive(w.deps, KEY, live(130, "clean"), WHO, new Date(at(131)));
    expect(next.ok && next.value.degraded).toBeNull();
    expect((await record(w)).state).toBe("approved");
    // The old failures sit before the restore: one new failure is not a streak.
    const bad = await recordLive(w.deps, KEY, live(132, "recipe_failure"), WHO, new Date(at(133)));
    expect(bad.ok && bad.value.degraded).toBeNull();
    expect((await record(w)).state).toBe("approved");
  });

  test("a human demotion makes restore --after-exclusion refuse", async () => {
    const w = world();
    for (const line of APPROVED) await appendHistory(w.deps, KEY, line, WHO);
    for (const l of lives(1, 3)) await recordLive(w.deps, KEY, l, WHO, new Date(at(100)));
    const demoted = await demoteKey(w.deps, await record(w), decider(105), "Looks wrong.");
    expect(demoted.ok).toBe(true);
    await excludeRuns(w.deps, await record(w), decider(110), { runs: [runId(1)], reason: "Outage." });
    const r = await restoreAfterExclusion(w.deps, await record(w), decider(120), { note: null });
    expect(r).toMatchObject({ ok: false, failure: "no_exclusion" });
    expect((await record(w)).state).toBe("degraded");
  });

  test("a key degraded in certify rules (not live) is refused too", async () => {
    const w = world();
    for (const line of [...APPROVED, degraded(3, "certify")]) await appendHistory(w.deps, KEY, line, WHO);
    await recordLive(w.deps, KEY, live(1), WHO, new Date(at(100)));
    await excludeRuns(w.deps, await record(w), decider(110), { runs: [runId(1)], reason: "Outage." });
    expect(await restoreAfterExclusion(w.deps, await record(w), decider(120), { note: null })).toMatchObject({ ok: false, failure: "no_exclusion" });
  });

  test("an approved key cannot be restored (illegal move)", async () => {
    const w = world();
    for (const line of APPROVED) await appendHistory(w.deps, KEY, line, WHO);
    const r = await restoreAfterExclusion(w.deps, await record(w), decider(120), { note: null });
    expect(r).toMatchObject({ ok: false, failure: "illegal_move" });
  });
});
