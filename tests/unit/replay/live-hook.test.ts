// Proves the replay writes live lines after `run_end` (design section 8 §5.5 live lines, §5.6
// writers and locks: "replay, after run_end, writes live lines for the task, session, and check
// keys" and "a failed score write never changes a run's result", §12.1 certify runs never count,
// §12.3 the streak rule): one run writes one line for the task key and one for the session key;
// a recipe failure writes a `recipe_failure` line with the code and step the result names; a
// failure inside the prelude blames the session key and the task line is not counted; a failing
// score store leaves the result as it is and calls `onLiveFailure` once per key; a run with a batch
// ID, a commit-retry run, and a deps bundle with no score store or no locks write nothing; three
// failures at one step degrade an approved key through `runReplay` itself. Fakes only. M11 task 1.
import { describe, expect, test } from "vitest";
import type { LiveLine } from "../../../src/core/model/live-line.js";
import type { HistoryLine } from "../../../src/core/model/score-history.js";
import type { ScoreKey, ScoreRecord } from "../../../src/core/model/score.js";
import { runReplay } from "../../../src/core/replay/executor.js";
import { keyPath } from "../../../src/core/trust/keys.js";
import { classOfCode } from "../../../src/core/trust/live-class.js";
import { liveFromEvidence } from "../../../src/core/trust/live-evidence.js";
import { appendHistory } from "../../../src/core/trust/scores.js";
import type { FakeScoreStore } from "../../../src/fakes/score-store.js";
import { approved, batch, h as hashOf } from "../trust/kit.js";
import { world } from "../trust/live-kit.js";
import { TENANT, authorizationFor, buildHarness, fixtureSite, replayInputOf, requestOf } from "./executor-harness.js";

const TASK: ScoreKey = { capability: "kvfcu/open_sub@1.0.0", tenant: TENANT, app_version: "8.4", patch_revision: null };
const SESSION: ScoreKey = { ...TASK, capability: "kvfcu/sign_in@1.0.0" };
const AUTH = authorizationFor("kvfcu/open_sub@1");

/** A harness whose deps hold the fake score store and locks, and a list of what `onLiveFailure` heard. */
async function setup(site = fixtureSite(), without: ("scores" | "locks" | "onLiveFailure")[] = []) {
  const w = world();
  const heard: { key: string; runId: string; reason: string }[] = [];
  const h = await buildHarness(site, {
    ...(without.includes("scores") ? {} : { scores: w.scores }),
    ...(without.includes("locks") ? {} : { locks: w.locks }),
    ...(without.includes("onLiveFailure") ? {} : { onLiveFailure: (f: { key: string; runId: string; reason: string }) => heard.push(f) }),
  });
  return { w, h, heard };
}

type Harness = Awaited<ReturnType<typeof setup>>["h"];

const run = (h: Harness, input: Parameters<typeof replayInputOf>[2] = {}) => runReplay(replayInputOf(h, requestOf({ authorization: AUTH }), input), h.deps);

async function liveOf(store: FakeScoreStore<HistoryLine, ScoreRecord>, key: ScoreKey): Promise<LiveLine[]> {
  const r = await store.liveLines(keyPath(key));
  if (!r.ok) throw new Error("live lines unreadable");
  return r.value;
}

describe("live lines after a run (section 8 §5.5, §5.6)", () => {
  test("a successful run writes one line for the task key and one for the session key", async () => {
    const { w, h, heard } = await setup();
    const { runId, result } = await run(h);
    expect(result.status).toBe("success");
    expect((await w.scores.paths(TENANT)).sort()).toEqual([keyPath(SESSION), keyPath(TASK)].sort());
    const [task] = await liveOf(w.scores, TASK);
    const [session] = await liveOf(w.scores, SESSION);
    expect(await liveOf(w.scores, TASK)).toHaveLength(1);
    expect(await liveOf(w.scores, SESSION)).toHaveLength(1);
    expect(task).toMatchObject({ run_id: runId, as: "task", class: "clean", code: null, mode: "supervised" });
    expect(session).toMatchObject({ run_id: runId, as: "prelude", class: "clean", code: null });
    expect(task?.under).toMatchObject({ engine: "0.1.0", jev: null });
    expect(task?.under.handler_set).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(session?.under).toEqual(task?.under);
    expect(Number.isNaN(Date.parse(task?.at ?? ""))).toBe(false);
    // Margins come from the task's votes: one per target the task found.
    expect(Object.keys(task?.margins ?? {}).sort()).toEqual(["account_number_display", "confirm_button", "member_id_box", "search_button"]);
    expect(Object.keys(task?.step_ms ?? {}).length).toBeGreaterThan(0);
    expect(heard).toEqual([]);
  });

  test("two runs write two lines per key, in order", async () => {
    const { w, h } = await setup();
    const a = await run(h);
    const b = await run(h);
    expect((await liveOf(w.scores, TASK)).map((l) => l.run_id)).toEqual([a.runId, b.runId]);
    expect((await liveOf(w.scores, SESSION)).map((l) => l.run_id)).toEqual([a.runId, b.runId]);
  });

  test("a recipe failure writes the code and step the result names, and the session line stays clean", async () => {
    const { w, h } = await setup(fixtureSite({ homeMissingSearchButton: true }));
    const { runId, result } = await run(h);
    if (result.status !== "failed") throw new Error(`expected failed, got ${result.status}`);
    const [task] = await liveOf(w.scores, TASK);
    expect(classOfCode(result.failure.code)).toBe("recipe_failure");
    expect(task).toMatchObject({ run_id: runId, as: "task", class: "recipe_failure", code: result.failure.code, step: result.failure.step });
    expect((await liveOf(w.scores, SESSION))[0]).toMatchObject({ as: "prelude", class: "clean" });
  });

  test("a failure inside the prelude blames the session key; the task line is not counted", async () => {
    const site = fixtureSite();
    const noLogin = { ...site, screens: { ...site.screens, "/": { elements: [] } } };
    const { w, h } = await setup(noLogin);
    const { result } = await run(h);
    if (result.status !== "failed") throw new Error(`expected failed, got ${result.status}`);
    const [session] = await liveOf(w.scores, SESSION);
    const [task] = await liveOf(w.scores, TASK);
    expect(session).toMatchObject({ as: "prelude", class: classOfCode(result.failure.code), code: result.failure.code });
    expect(task).toMatchObject({ as: "task", class: "not_counted" });
  });
});

describe("a failed score write never changes the result (section 8 §5.6)", () => {
  test("a failing store leaves the result as it is and calls onLiveFailure for each key", async () => {
    const good = await setup();
    const expected = await run(good.h);

    const { w, h, heard } = await setup();
    w.scores.failWrites = true;
    const { runId, result } = await run(h);
    expect(result.status).toBe(expected.result.status);
    if (result.status !== "success" || expected.result.status !== "success") throw new Error("expected success");
    expect(result.outputs).toEqual(expected.result.outputs);
    expect(result.effect).toEqual(expected.result.effect);
    expect(heard).toHaveLength(2);
    for (const f of heard) {
      expect(f.runId).toBe(runId);
      expect(f.reason.length).toBeGreaterThan(0);
    }
    expect(heard.map((f) => f.key).join(" ")).toContain("kvfcu/open_sub@1.0.0");
    expect(heard.map((f) => f.key).join(" ")).toContain("kvfcu/sign_in@1.0.0");
    expect(await w.scores.paths(TENANT)).toEqual([]);
  });

  test("a run with no onLiveFailure and a failing store still returns its result", async () => {
    const { w, h } = await setup(fixtureSite(), ["onLiveFailure"]);
    w.scores.failWrites = true;
    expect((await run(h)).result.status).toBe("success");
  });
});

describe("runs that write nothing", () => {
  test("a run with a batch ID (a certify run) writes no live line", async () => {
    const { w, h, heard } = await setup();
    const { result } = await run(h, { batchId: "batch_2026-01-15_0000000001" });
    expect(result.status).toBe("success");
    expect(await w.scores.paths(TENANT)).toEqual([]);
    expect(heard).toEqual([]);
  });

  test("a commit-retry run writes no live line", async () => {
    const { w, h } = await setup();
    await run(h, { purpose: "commit_retry" });
    expect(await w.scores.paths(TENANT)).toEqual([]);
  });

  test("with no score store, nothing is written and the run succeeds", async () => {
    const { w, h } = await setup(fixtureSite(), ["scores"]);
    expect((await run(h)).result.status).toBe("success");
    expect(await w.scores.paths(TENANT)).toEqual([]);
  });

  test("with no locks, nothing is written and the run succeeds", async () => {
    const { w, h, heard } = await setup(fixtureSite(), ["locks"]);
    expect((await run(h)).result.status).toBe("success");
    expect(await w.scores.paths(TENANT)).toEqual([]);
    expect(heard).toEqual([]);
  });
});

describe("the rules run after a live write (section 8 §12.3)", () => {
  test("three failures at one step degrade an approved key by live_score, naming the three runs", async () => {
    const { w, h } = await setup(fixtureSite({ homeMissingSearchButton: true }));
    // Approved long before the runs, so every live line counts.
    for (const line of [batch(1, "batch_a"), { ...approved(2), at: "2026-01-15T08:00:00.000Z" }]) {
      const r = await appendHistory(w.deps, TASK, line, { owner: "test", command: "test", staff: "op_022" });
      if (!r.ok) throw new Error(`test setup: ${r.detail ?? r.failure}`);
    }
    const ids: string[] = [];
    const states: string[] = [];
    for (let i = 0; i < 3; i++) {
      // Why a fresh authorization: the fake clock steps minutes per run, so one fixed grant would expire.
      const now = h.deps.clock.now().getTime();
      const auth = { ...AUTH, granted_at: new Date(now - 60_000).toISOString(), expires_at: new Date(now + 25 * 60_000).toISOString() };
      ids.push((await runReplay(replayInputOf(h, requestOf({ authorization: auth })), h.deps)).runId);
      const rec = await w.scores.getRecord(keyPath(TASK));
      states.push(rec.ok ? rec.value.state : "none");
    }
    expect(states).toEqual(["approved", "approved", "degraded"]);
    const history = await w.scores.history(keyPath(TASK));
    expect(history.ok && history.value.at(-1)).toMatchObject({ event: "degraded", by: "live_score", rule: "streak", runs: ids });
    // The session key took three clean lines and stays a draft.
    const session = await w.scores.getRecord(keyPath(SESSION));
    expect(session.ok && session.value.state).toBe("draft");
    expect(session.ok && session.value.live?.current).toMatchObject({ counted: 3, clean: 3, score: 1 });
  });
});

describe("pack revisions on the line (section 8 §13.3)", () => {
  const frozenSet = {
    targets: [],
    conditions: [],
    handlers: [],
    handlerScope: new Map(),
    runStart: { ids: [], packs: { "app:kvfcu": 5 }, from: {}, hash: hashOf("set-5") },
    warnings: [],
  };

  test("a run's lines carry the handler set hash and the pack revisions it froze, and a rebuild from evidence restores them", async () => {
    const { w, h } = await setup();
    const { runId } = await run(h, { frozenSet });
    const [task] = await liveOf(w.scores, TASK);
    const [session] = await liveOf(w.scores, SESSION);
    expect(task?.under).toMatchObject({ handler_set: hashOf("set-5"), packs: { "app:kvfcu": 5 } });
    expect(session?.under).toEqual(task?.under);

    const fromEvidence = await liveFromEvidence(h.deps.evidence, TENANT);
    const lines = fromEvidence.byKey.get(keyPath(TASK))?.lines ?? [];
    expect(lines.map((l) => l.run_id)).toEqual([runId]);
    expect(lines[0]?.under).toEqual(task?.under);
    expect(fromEvidence.byKey.get(keyPath(SESSION))?.lines[0]?.under).toEqual(task?.under);
  });

  test("a run with no pack revisions leaves packs off the line", async () => {
    const { w, h } = await setup();
    await run(h);
    const [task] = await liveOf(w.scores, TASK);
    expect(task?.under).not.toHaveProperty("packs");
  });
});

describe("the reader hook and the failure hook never change the result (section 8 §5.6, §13.1)", () => {
  test("afterScoreWrite runs once per live write, with the key", async () => {
    const heard: string[] = [];
    const w = world();
    const h = await buildHarness(fixtureSite(), {
      scores: w.scores,
      locks: w.locks,
      afterScoreWrite: (k) => {
        heard.push(k.capability);
        return Promise.resolve();
      },
    });
    expect((await run(h)).result.status).toBe("success");
    expect(heard.sort()).toEqual(["kvfcu/open_sub@1.0.0", "kvfcu/sign_in@1.0.0"]);
  });

  test("a throwing afterScoreWrite leaves the result and the lines alone", async () => {
    const w = world();
    const h = await buildHarness(fixtureSite(), { scores: w.scores, locks: w.locks, afterScoreWrite: () => Promise.reject(new Error("reader broke")) });
    expect((await run(h)).result.status).toBe("success");
    expect(await liveOf(w.scores, TASK)).toHaveLength(1);
  });

  test("a throwing or rejecting onLiveFailure leaves the result alone", async () => {
    const w = world();
    w.scores.failWrites = true;
    const h = await buildHarness(fixtureSite(), { scores: w.scores, locks: w.locks, onLiveFailure: () => Promise.reject(new Error("alert broke")) });
    expect((await run(h)).result.status).toBe("success");
    const h2 = await buildHarness(fixtureSite(), {
      scores: w.scores,
      locks: w.locks,
      onLiveFailure: () => {
        throw new Error("alert broke");
      },
    });
    expect((await run(h2)).result.status).toBe("success");
  });
});
