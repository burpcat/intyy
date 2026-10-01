// Proves the live-trust commands end to end (design section 9 §9.4 `trust exclude` and `trust
// restore --after-exclusion`, §9.8 `trust rebuild --from-evidence`; section 8 §10.8 restore after
// excluded runs, §12.5 excluding runs, §5.2 live lines are an index of evidence, §5.6 a failed
// score write never changes a result): `trust exclude` reads its reason from standard input and
// takes run IDs as positional words, needs an approver, a reason, and known runs; `trust restore
// --after-exclusion` needs `--expect-record` (a changed record exits 6), the approver role, an
// exclusion, and no rule that still fires, and writes a `restored` line with `batch: null`;
// `trust rebuild --from-evidence` recreates `live.jsonl` from run files after a replay whose live
// write failed, keeps a line whose run file is gone, and a second run changes no bytes. Temporary
// data roots only. M11 tasks 1 and 2.
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { EXIT } from "../../../src/cli/exit-codes.js";
import type { LiveLine } from "../../../src/core/model/live-line.js";
import { HistoryLine } from "../../../src/core/model/score-history.js";
import type { ScoreKey, ScoreRecord } from "../../../src/core/model/score.js";
import { keyPath } from "../../../src/core/trust/keys.js";
import { appendHistory, recordLive } from "../../../src/core/trust/scores.js";
import { approved, batch, KEY as BASE_KEY } from "../trust/kit.js";
import { at, live, lives, runId } from "../trust/live-kit.js";
import { cleanRoots } from "./helpers.js";
import {
  MEMBER_FOUND,
  realWiringOf,
  replayRoot,
  runSupervisedToEnd,
  writeAuthorization,
  writeInputs,
  replayCall,
  type ReplayEnv,
} from "./replay-harness.js";

afterAll(cleanRoots);

const LONG = { timeout: 120_000 };

/** `replayRoot`'s settings give kvfcu app version 8.4; open_sub 1.0.0 and sign_in 1.0.0 are sealed. */
const KEY: ScoreKey = { ...BASE_KEY, capability: "kvfcu/open_sub@1.0.0", app_version: "8.4" };
const SESSION_KEY: ScoreKey = { ...KEY, capability: "kvfcu/sign_in@1.0.0" };
const TEXT = "kvfcu/open_sub@1.0.0";
const WHO = { owner: "test", command: "test", staff: null };

const trust = (env: ReplayEnv, staff: string, argv: string[], stdin = "") =>
  replayCall(env, ["trust", ...argv], { env: { INTYY_STAFF: staff }, stdin });

/** The score ports of the real wiring at `env.root`. */
function depsOf(env: ReplayEnv) {
  const w = realWiringOf(env);
  return { scores: w.scores, locks: w.locks, artifacts: w.candidates };
}

/** A failure line for open_sub at one step and code. */
const failure = (n: number): LiveLine => live(n, "recipe_failure", { step: "click_search", code: "target_not_found" });

/** An approved key that the given live lines were written for, through the real writers (so the rules run). */
async function seeded(lines: LiveLine[]): Promise<ReplayEnv> {
  const env = await replayRoot();
  const deps = depsOf(env);
  for (const line of [batch(1, "batch_a"), approved(2)]) {
    const r = await appendHistory(deps, KEY, line, WHO);
    if (!r.ok) throw new Error(`test setup: ${r.detail ?? r.failure}`);
  }
  for (const l of lines) {
    const r = await recordLive(deps, KEY, l, WHO, new Date(at(100)));
    if (!r.ok) throw new Error(`test setup: ${r.detail ?? r.failure}`);
  }
  return env;
}

/** Three failures degrade the key (runs 1 to 3). */
const degradedEnv = (extra: LiveLine[] = []) => seeded([failure(1), failure(2), failure(3), ...extra]);

const shown = async (env: ReplayEnv): Promise<{ hash: string; record: ScoreRecord }> => {
  const r = await trust(env, "op_031", ["show", TEXT, "--json"]);
  return JSON.parse(r.stdout) as { hash: string; record: ScoreRecord };
};

const historyOf = async (env: ReplayEnv, key = KEY): Promise<HistoryLine[]> => {
  const r = await realWiringOf(env).scores.history(keyPath(key));
  if (!r.ok) throw new Error("test setup: no history");
  return r.value;
};

const exclude = (env: ReplayEnv, staff: string, runs: string[], stdin = "Known bank outage.") =>
  trust(env, staff, ["exclude", TEXT, ...runs], stdin);

const restore = (env: ReplayEnv, staff: string, hash: string, stdin = "Outage over.", extra: string[] = []) =>
  trust(env, staff, ["restore", TEXT, "--after-exclusion", "--expect-record", hash, ...extra], stdin);

describe("trust exclude", () => {
  test("an approver excludes runs named as words, with the reason from standard input", LONG, async () => {
    const env = await degradedEnv();
    const r = await trust(env, "op_022", ["exclude", TEXT, runId(1), runId(2), "--json"], "Known bank outage.\n");
    expect(r.stderr).toBe("");
    expect(r.code).toBe(EXIT.ok);
    const body = JSON.parse(r.stdout) as { key: string; excluded: string[]; record: string };
    expect(body).toMatchObject({ key: TEXT, excluded: [runId(1), runId(2)] });
    expect(body.record).toBe((await shown(env)).hash);
    expect((await historyOf(env)).at(-1)).toMatchObject({ event: "excluded", by: "op_022", reason: "Known bank outage.", runs: [runId(1), runId(2)] });
    // The runs stay in live.jsonl; only the record stops counting them.
    const lines = await realWiringOf(env).scores.liveLines(keyPath(KEY));
    expect(lines.ok && lines.value).toHaveLength(3);
    expect((await shown(env)).record.live?.current).toMatchObject({ counted: 1, recipe_failures: 1 });
  });

  test("a person without the approver role exits 6 and writes nothing", LONG, async () => {
    const env = await degradedEnv();
    const before = (await historyOf(env)).length;
    const r = await exclude(env, "op_017", [runId(1)]);
    expect(r.code).toBe(EXIT.refused);
    expect(r.stderr).toContain("approver");
    expect(await historyOf(env)).toHaveLength(before);
  });

  test("an unknown run exits 1 and writes nothing", LONG, async () => {
    const env = await degradedEnv();
    const before = (await historyOf(env)).length;
    const r = await exclude(env, "op_022", [runId(1), runId(77)]);
    expect(r.code).toBe(EXIT.usage);
    expect(r.stderr).toContain(runId(77));
    expect(await historyOf(env)).toHaveLength(before);
  });

  test("no run IDs, or no reason, exits 1", LONG, async () => {
    const env = await degradedEnv();
    expect((await exclude(env, "op_022", [])).code).toBe(EXIT.usage);
    expect((await exclude(env, "op_022", [runId(1)], "")).code).toBe(EXIT.usage);
    expect((await historyOf(env)).filter((l) => l.event === "excluded")).toEqual([]);
  });

  test("a run ID is never taken from a flag", LONG, async () => {
    const env = await degradedEnv();
    const r = await trust(env, "op_022", ["exclude", TEXT, "--runs", runId(1)], "Outage.");
    expect(r.code).toBe(EXIT.usage);
    expect((await historyOf(env)).filter((l) => l.event === "excluded")).toEqual([]);
  });
});

describe("trust restore --after-exclusion", () => {
  test("restores a key whose triggering runs were excluded, with batch null and the exclusion's time", LONG, async () => {
    const env = await degradedEnv();
    expect((await shown(env)).record.state).toBe("degraded");
    expect((await exclude(env, "op_022", [runId(1), runId(2), runId(3)])).code).toBe(EXIT.ok);
    const r = await restore(env, "op_022", (await shown(env)).hash, "Bank confirmed the outage.");
    expect(r.stderr).toBe("");
    expect(r.code).toBe(EXIT.ok);
    const lines = await historyOf(env);
    const excluded = lines.findLast((l) => l.event === "excluded");
    expect(lines.at(-1)).toMatchObject({ event: "restored", by: "op_022", reason: "Bank confirmed the outage.", batch: null, exclusion: excluded?.at });
    expect((await shown(env)).record.state).toBe("approved");
    expect(r.stdout).toContain("RECORD");
  });

  test("a changed record exits 6 with record_changed and writes nothing", LONG, async () => {
    const env = await degradedEnv();
    const stale = (await shown(env)).hash;
    await exclude(env, "op_022", [runId(1), runId(2), runId(3)]);
    expect((await shown(env)).hash).not.toBe(stale);
    const before = (await historyOf(env)).length;
    const r = await restore(env, "op_022", stale);
    expect(r.code).toBe(EXIT.refused);
    expect(r.stderr).toContain("record_changed");
    expect(await historyOf(env)).toHaveLength(before);
  });

  test("without --expect-record it exits 1; with --batch as well it exits 1", LONG, async () => {
    const env = await degradedEnv();
    await exclude(env, "op_022", [runId(1), runId(2), runId(3)]);
    expect((await trust(env, "op_022", ["restore", TEXT, "--after-exclusion"], "x")).code).toBe(EXIT.usage);
    const both = await restore(env, "op_022", (await shown(env)).hash, "x", ["--batch", "batch_b"]);
    expect(both.code).toBe(EXIT.usage);
    expect((await shown(env)).record.state).toBe("degraded");
  });

  test("a person without the approver role exits 6", LONG, async () => {
    const env = await degradedEnv();
    await exclude(env, "op_022", [runId(1), runId(2), runId(3)]);
    const r = await restore(env, "op_017", (await shown(env)).hash);
    expect(r.code).toBe(EXIT.refused);
    expect((await shown(env)).record.state).toBe("degraded");
  });

  test("no exclusion exits 6 and says to exclude runs first", LONG, async () => {
    const env = await degradedEnv();
    const r = await restore(env, "op_022", (await shown(env)).hash);
    expect(r.code).toBe(EXIT.refused);
    expect(r.stderr).toContain("trust exclude");
  });

  test("a rule that still fires exits 6 naming the rule, and the key stays degraded", LONG, async () => {
    // Run 4 failed too: with run 1 out, runs 2, 3, and 4 are still a streak.
    const env = await degradedEnv([failure(4)]);
    await exclude(env, "op_022", [runId(1)]);
    const r = await restore(env, "op_022", (await shown(env)).hash);
    expect(r.code).toBe(EXIT.refused);
    expect(r.stderr).toContain("Streak rule");
    expect(r.stderr).toContain("Exclude more runs");
    expect((await shown(env)).record.state).toBe("degraded");
  });

  test("a key that is not degraded exits 6", LONG, async () => {
    const env = await seeded(lives(1, 2));
    const r = await restore(env, "op_022", (await shown(env)).hash);
    expect(r.code).toBe(EXIT.refused);
  });
});

/** One supervised replay of open_sub on the fixture site, to its end. */
async function replayOnce(env: ReplayEnv) {
  const inputs = writeInputs(env, { member_id: MEMBER_FOUND });
  const auth = writeAuthorization(env, "kvfcu/open_sub@1");
  return runSupervisedToEnd(env, ["replay", "kvfcu/open_sub@1", "--mode", "supervised", "--inputs", inputs, "--authorization", auth, "--json"]);
}

const liveFile = (env: ReplayEnv, key: ScoreKey): string => join(env.root, "state", "trust", "scores", keyPath(key), "live.jsonl");
const liveOf = (env: ReplayEnv, key: ScoreKey): LiveLine[] =>
  readFileSync(liveFile(env, key), "utf8").trim().split("\n").map((l) => JSON.parse(l) as LiveLine);

describe("a replay writes live lines through the real wiring", () => {
  test("one run leaves one line in the task key's file and one in the session key's", LONG, async () => {
    const env = await replayRoot();
    const got = await replayOnce(env);
    expect(got.code).toBe(EXIT.ok);
    expect(liveOf(env, KEY)).toMatchObject([{ run_id: got.runId, as: "task", class: "clean" }]);
    expect(liveOf(env, SESSION_KEY)).toMatchObject([{ run_id: got.runId, as: "prelude", class: "clean" }]);
    expect((await shown(env)).record.live?.current).toMatchObject({ counted: 1, clean: 1, score: 1 });
  });
});

describe("trust rebuild --from-evidence", () => {
  /** A replay whose live write failed: `live.jsonl` is a folder, so no line can be appended. */
  async function replayWithFailedWrite() {
    const env = await replayRoot();
    for (const key of [KEY, SESSION_KEY]) mkdirSync(liveFile(env, key), { recursive: true });
    const got = await replayOnce(env);
    for (const key of [KEY, SESSION_KEY]) rmSync(liveFile(env, key), { recursive: true });
    return { env, got };
  }
  const rebuild = (env: ReplayEnv, ...argv: string[]) => trust(env, "op_017", ["rebuild", ...argv]);

  test("the failed write leaves the run's result alone and names the repair", LONG, async () => {
    const { got } = await replayWithFailedWrite();
    expect(got.code).toBe(EXIT.ok);
    expect((JSON.parse(got.stdout) as { status: string }).status).toBe("success");
    expect(got.stderr).toContain("trust rebuild");
    expect(got.stderr).toContain("--from-evidence");
  });

  test("--all recreates live.jsonl for the task and session keys from the run files", LONG, async () => {
    const { env, got } = await replayWithFailedWrite();
    expect(existsSync(liveFile(env, KEY))).toBe(false);
    const r = await rebuild(env, "--all", "--from-evidence");
    expect(r.stderr).toBe("");
    expect(r.code).toBe(EXIT.ok);
    expect(liveOf(env, KEY)).toMatchObject([{ run_id: got.runId, as: "task", class: "clean", mode: "supervised" }]);
    expect(liveOf(env, SESSION_KEY)).toMatchObject([{ run_id: got.runId, as: "prelude", class: "clean" }]);
    expect(liveOf(env, KEY)[0]?.under.handler_set).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect((await shown(env)).record.live?.current).toMatchObject({ counted: 1, clean: 1 });
    expect(r.stdout).toContain("1 new from evidence");
  });

  test("a second run changes no bytes and adds nothing", LONG, async () => {
    const { env } = await replayWithFailedWrite();
    await rebuild(env, "--all", "--from-evidence");
    const before = readFileSync(liveFile(env, KEY), "utf8");
    const record = readFileSync(join(env.root, "state", "trust", "scores", keyPath(KEY), "record.json"), "utf8");
    const again = await rebuild(env, "--all", "--from-evidence");
    expect(again.code).toBe(EXIT.ok);
    expect(again.stdout).toContain("0 new from evidence");
    expect(readFileSync(liveFile(env, KEY), "utf8")).toBe(before);
    expect(readFileSync(join(env.root, "state", "trust", "scores", keyPath(KEY), "record.json"), "utf8")).toBe(record);
  });

  test("one key repairs that key only", LONG, async () => {
    const { env } = await replayWithFailedWrite();
    const r = await rebuild(env, TEXT, "--from-evidence");
    expect(r.code).toBe(EXIT.ok);
    expect(existsSync(liveFile(env, KEY))).toBe(true);
    expect(existsSync(liveFile(env, SESSION_KEY))).toBe(false);
  });

  test("a line whose run file is gone is kept", LONG, async () => {
    const { env, got } = await replayWithFailedWrite();
    const old = live(5, "assisted");
    await realWiringOf(env).scores.appendLive(keyPath(KEY), old);
    const r = await rebuild(env, TEXT, "--from-evidence");
    expect(r.code).toBe(EXIT.ok);
    expect(liveOf(env, KEY).map((l) => l.run_id).sort()).toEqual([old.run_id, got.runId].sort());
  });

  test("it does not run the degrade rules", LONG, async () => {
    const env = await replayRoot();
    for (const line of [batch(1, "batch_a"), approved(2)]) await appendHistory(depsOf(env), KEY, line, WHO);
    for (const l of [failure(1), failure(2), failure(3)]) await realWiringOf(env).scores.appendLive(keyPath(KEY), l);
    const r = await rebuild(env, TEXT, "--from-evidence");
    expect(r.code).toBe(EXIT.ok);
    expect((await shown(env)).record.state).toBe("approved");
  });
});
