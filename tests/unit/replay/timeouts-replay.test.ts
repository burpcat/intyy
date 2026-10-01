// Proves tuned timeouts in the replay executor (design section 8 §9.6 samples, candidate then
// approved; §11.8 what a run freezes; section 3 §6.4 `step_end`): a passed task step writes
// `step_end {result: passed, observed_ms}` and the commit step's passed checkpoint `check` carries
// `waited_ms`, while prelude steps give neither a sample line; `ReplayInput.timeouts` changes how
// long a step waits, shows in the frozen timeouts, and leaves the sealed artifact's frozen
// reference unchanged; a live run applies the record's approved timeouts for an approved key, not
// for a draft; a certify run (batch ID set) with no timeouts uses the artifact's own values. Fake
// site, fake clock, in-memory score store. M10 task 11.
import { describe, expect, test } from "vitest";
import { runReplay, type ReplayDeps, type ReplayInput } from "../../../src/core/replay/executor.js";
import { HistoryLine as HistoryLineSchema, type HistoryLine } from "../../../src/core/model/score-history.js";
import { ScoreRecord, type ScoreKey } from "../../../src/core/model/score.js";
import { keyPath } from "../../../src/core/trust/keys.js";
import { rebuild } from "../../../src/core/trust/rebuild.js";
import { FakeScoreStore } from "../../../src/fakes/score-store.js";
import type { FakeSite } from "../../../src/fakes/snapshot-surface/index.js";
import { approved, batch, HASHES } from "../trust/kit.js";
import { OPEN_SUB, TENANT, authorizationFor, buildHarness, fixtureSite, replayInputOf, requestOf } from "./executor-harness.js";

const KEY: ScoreKey = { capability: "kvfcu/open_sub@1.0.0", tenant: TENANT, app_version: "8.4", patch_revision: null };
const AUTH = authorizationFor("kvfcu/open_sub@1");
const stepTimeout = (id: string): number => OPEN_SUB.steps.find((s) => s.id === id)?.timeout_ms ?? 0;

/** Search does not move the page, so `click_search`'s checkpoint never passes: the run waits out the timeout. */
function stuckSearchSite(): FakeSite {
  const base = fixtureSite();
  const home = base.screens["/home"];
  if (home === undefined) throw new Error("test setup: no /home");
  const elements = home.elements.map((e) => (e.id === "search_button" ? { ...e, onClick: { go: "/home" as const } } : e));
  return { ...base, screens: { ...base.screens, "/home": { ...home, elements } } };
}

/** A score store holding the record the history lines rebuild to, for `KEY`. */
async function storeWith(lines: HistoryLine[]): Promise<FakeScoreStore<HistoryLine, ScoreRecord>> {
  const record = rebuild(KEY, HASHES, lines);
  if (!record.ok) throw new Error("test setup: rebuild failed");
  const store = new FakeScoreStore<HistoryLine, ScoreRecord>({ line: HistoryLineSchema, record: ScoreRecord });
  await store.putRecord(keyPath(KEY), record.value);
  return store;
}

const TUNED: HistoryLine = { event: "timeouts", at: "2026-01-15T09:03:00.000Z", by: "op_022", reason: "Installed.", batch: "batch_a", values: { click_search: 12000 } };
const APPROVED_LINES = [batch(1, "batch_a"), approved(2, "op_022", "batch_a"), TUNED];
const DRAFT_LINES = [batch(1, "batch_a"), TUNED];

type Run = { events: Record<string, unknown>[]; elapsed: number; frozen: Record<string, unknown>; status: string };

/** One replay on the stuck-search site. `over` changes the input; `scores` is the store, if any. */
async function stuckRun(over: Partial<ReplayInput>, scores?: FakeScoreStore<HistoryLine, ScoreRecord>): Promise<Run> {
  const h = await buildHarness(stuckSearchSite(), scores === undefined ? {} : ({ scores } satisfies Partial<ReplayDeps>));
  const start = h.deps.clock.now().getTime();
  const { runId, result } = await runReplay(replayInputOf(h, requestOf({ authorization: AUTH }), over), h.deps);
  const elapsed = h.deps.clock.now().getTime() - start;
  const events = await h.deps.evidence.events(TENANT, runId);
  if (!events.ok) throw new Error("events failed");
  const lines = events.value as Record<string, unknown>[];
  const startLine = lines.find((e) => e.event === "run_start") as { data: { frozen: Record<string, unknown> } };
  return { events: lines, elapsed, frozen: startLine.data.frozen, status: result.status };
}

describe("step_end and the commit checkpoint wait (section 8 §9.6 samples)", () => {
  test("a passed task step writes step_end passed with observed_ms; the commit step's checkpoint carries waited_ms", async () => {
    const h = await buildHarness(fixtureSite());
    const { runId, result } = await runReplay(replayInputOf(h, requestOf({ authorization: AUTH })), h.deps);
    expect(result.status).toBe("success");
    const events = await h.deps.evidence.events(TENANT, runId);
    if (!events.ok) throw new Error("events failed");
    const lines = events.value as { event: string; step: string | null; data: Record<string, unknown> }[];
    const ends = lines.filter((l) => l.event === "step_end");
    expect(ends.map((l) => l.step)).toEqual(["type_member_id", "click_search", "read_account_number"]);
    for (const l of ends) {
      expect(l.data.result).toBe("passed");
      expect(typeof l.data.observed_ms).toBe("number");
      expect(l.data.observed_ms as number).toBeGreaterThanOrEqual(0);
    }
    const commit = lines.find((l) => l.event === "check" && l.step === "click_confirm" && l.data.role === "checkpoint");
    expect(commit?.data).toMatchObject({ passed: true });
    expect(typeof commit?.data.waited_ms).toBe("number");
    expect(lines.some((l) => typeof l.step === "string" && l.step.startsWith("session:") && l.event === "step_end")).toBe(false);
  });
});

describe("ReplayInput.timeouts (section 8 §9.6)", () => {
  test("a tuned value changes how long the step waits, and shows in the frozen timeouts", async () => {
    expect(stepTimeout("click_search")).toBe(8000);
    const plain = await stuckRun({});
    const longer = await stuckRun({ timeouts: { values: { click_search: 12000 }, from: "batch_a" } });
    const shorter = await stuckRun({ timeouts: { values: { click_search: 3000 }, from: "batch_a" } });
    expect(longer.elapsed).toBeGreaterThan(plain.elapsed);
    expect(shorter.elapsed).toBeLessThan(plain.elapsed);
    expect(longer.frozen.timeouts).toEqual({ click_search: 12000 });
    expect(JSON.stringify(longer.frozen.timeouts_from)).toContain("batch_a");
    expect(plain.frozen.timeouts).toEqual({});
  });

  test("the frozen artifact reference is the sealed one: tuning leaves it unchanged", async () => {
    const plain = await stuckRun({});
    const tuned = await stuckRun({ timeouts: { values: { click_search: 12000 }, from: "batch_a" } });
    expect(tuned.frozen.artifact).toEqual(plain.frozen.artifact);
  });
});

describe("approved and candidate values by key state (section 8 §9.6 table)", () => {
  test("a live run of an approved key applies the record's approved timeouts", async () => {
    const plain = await stuckRun({});
    const live = await stuckRun({}, await storeWith(APPROVED_LINES));
    expect(live.frozen.timeouts).toEqual({ click_search: 12000 });
    expect(live.elapsed).toBeGreaterThan(plain.elapsed);
  });

  test("the same values on a draft key are not applied", async () => {
    const plain = await stuckRun({});
    const live = await stuckRun({}, await storeWith(DRAFT_LINES));
    expect(live.frozen.timeouts).toEqual({});
    expect(live.elapsed).toBe(plain.elapsed);
  });

  test("a certify run (batch ID set) with no timeouts uses the artifact's values, not the record's", async () => {
    const plain = await stuckRun({});
    const run = await stuckRun({ batchId: "batch_2026-01-15_bbbbbbbbbb", caseId: "baseline", pin: "kvfcu/open_sub@1.0.0" }, await storeWith(APPROVED_LINES));
    expect(run.frozen.timeouts).toEqual({});
    expect(run.elapsed).toBe(plain.elapsed);
  });

  test("a certify run's own timeouts win over the record's", async () => {
    const run = await stuckRun(
      { batchId: "batch_2026-01-15_bbbbbbbbbb", caseId: "baseline", pin: "kvfcu/open_sub@1.0.0", timeouts: { values: { click_search: 3000 }, from: "batch_a" } },
      await storeWith(APPROVED_LINES),
    );
    expect(run.frozen.timeouts).toEqual({ click_search: 3000 });
  });
});
