// Proves `intyy trust rebuild [<key> | --all]` and the score writes of every certify path
// (design section 9 §9.8 score rebuild, §7.5 exit codes; section 8 §5.2 record rebuilt from the
// history, §5.4 `batch` line, §5.6 a failed score write never changes a result): rebuild --all and
// one key, equal bytes on a second run, a tampered record repaired, a key with no files stays
// draft, `--from-evidence` rebuilds (M11; its own file is trust-live.test.ts) and a missing or doubled target exit 1, a non-operator exits 6, a bad
// history names its line, the artifact hash is the seal hash, and `certify` quick, case, and rerun
// each write a `batch` line (a failing score store prints a warning and leaves the exit code).
// Temporary data roots only. M10 task 1.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { EXIT } from "../../../src/cli/exit-codes.js";
import { hashJson } from "../../../src/core/model/canonical.js";
import { HistoryLine } from "../../../src/core/model/score-history.js";
import { ScoreRecord, type ScoreKey } from "../../../src/core/model/score.js";
import { sealHash } from "../../../src/core/model/sealing.js";
import { keyPath } from "../../../src/core/trust/keys.js";
import { rebuild } from "../../../src/core/trust/rebuild.js";
import { FakeScoreStore } from "../../../src/fakes/score-store.js";
import { OPEN_SUB } from "../replay/executor-harness.js";
import { approved, batch, KEY as BASE_KEY, retired } from "../trust/kit.js";
import { certifyCall, CAP, sealQuickInputs } from "./certify-kit.js";
import { cleanRoots } from "./helpers.js";
import { realWiringOf, replayCall, replayRoot, type ReplayEnv } from "./replay-harness.js";
import { OPEN_SUB_ROUTE_FOR } from "../certify/route-mapping-harness.js";

afterAll(cleanRoots);

const LONG = { timeout: 120_000 };

/** The key the CLI tests use: `replayRoot`'s settings give kvfcu app version 8.4; open_sub 1.0.0 is sealed. */
const KEY: ScoreKey = { ...BASE_KEY, capability: "kvfcu/open_sub@1.0.0", app_version: "8.4" };
const PATCHED: ScoreKey = { ...KEY, patch_revision: 2 };
const ARTIFACT_HASH = sealHash(OPEN_SUB);

const rebuildCall = (env: ReplayEnv, staff: string, ...argv: string[]) =>
  replayCall(env, ["trust", "rebuild", ...argv], { env: { INTYY_STAFF: staff } });

/** The score folder of a key on disk. */
const folder = (env: ReplayEnv, key: ScoreKey): string => join(env.root, "state", "trust", "scores", keyPath(key));

/** Appends history lines through the real store, as a certify run would have. */
async function seed(env: ReplayEnv, key: ScoreKey, lines: HistoryLine[]): Promise<void> {
  for (const l of lines) {
    const r = await realWiringOf(env).scores.append(keyPath(key), l);
    if (!r.ok) throw new Error("test setup: append failed");
  }
}

/** The record the lines must give, rebuilt by plain code. */
function expectedRecord(key: ScoreKey, lines: HistoryLine[]): ScoreRecord {
  const r = rebuild(key, { artifact: ARTIFACT_HASH, patch: null }, lines);
  if (!r.ok) throw new Error("test setup: rebuild failed");
  return r.value;
}

const recordFile = (env: ReplayEnv, key: ScoreKey): string => join(folder(env, key), "record.json");
const readRecord = (env: ReplayEnv, key: ScoreKey): unknown => JSON.parse(readFileSync(recordFile(env, key), "utf8"));

const LINES: HistoryLine[] = [batch(1, "batch_a"), approved(2)];

describe("trust rebuild", () => {
  test("--all rebuilds every key with files and skips folders that are not keys", async () => {
    const env = await replayRoot();
    await seed(env, KEY, LINES);
    await seed(env, PATCHED, [...LINES, retired(3)]);
    mkdirSync(join(env.root, "state", "trust", "scores", "keystone", "junk"), { recursive: true });
    writeFileSync(join(env.root, "state", "trust", "scores", "keystone", "junk", "record.json"), "{}");

    const r = await rebuildCall(env, "op_017", "--all");
    expect(r.code).toBe(EXIT.ok);
    expect(readRecord(env, KEY)).toEqual(expectedRecord(KEY, LINES));
    expect(readRecord(env, PATCHED)).toEqual(expectedRecord(PATCHED, [...LINES, retired(3)]));
    expect(r.stdout).toContain("kvfcu/open_sub@1.0.0 (app 8.4, no patch): approved");
    expect(r.stdout).toContain("patch 2): retired");
    expect(r.stdout).toContain("skipped keystone/junk: not a key folder");
  });

  test("--json quotes the record hash of the canonical record, not of the file text; a second run changes nothing, byte for byte; a tampered record is repaired and named", async () => {
    const env = await replayRoot();
    await seed(env, KEY, LINES);
    const r = await rebuildCall(env, "op_017", "--all", "--json");
    const body = JSON.parse(r.stdout) as { rebuilt: { key: ScoreKey; state: string; written: boolean; changed: string[]; record: string }[] };
    expect(body.rebuilt).toHaveLength(1);
    expect(body.rebuilt[0]).toMatchObject({ key: KEY, state: "approved", written: true });
    expect(body.rebuilt[0]?.record).toBe(hashJson(expectedRecord(KEY, LINES)));
    expect(body.rebuilt[0]?.record).toBe(hashJson(readRecord(env, KEY)));
    const bytes = readFileSync(recordFile(env, KEY), "utf8");

    const again = JSON.parse((await rebuildCall(env, "op_017", "--all", "--json")).stdout) as { rebuilt: { changed: string[] }[] };
    expect(again.rebuilt[0]?.changed).toEqual([]);
    expect(readFileSync(recordFile(env, KEY), "utf8")).toBe(bytes);

    const tampered = { ...(JSON.parse(bytes) as object), state: "retired", alerts: ["alert_x"] };
    writeFileSync(recordFile(env, KEY), JSON.stringify(tampered));
    const fixed = await rebuildCall(env, "op_017", "--all", "--json");
    expect(fixed.code).toBe(EXIT.ok);
    const changed = (JSON.parse(fixed.stdout) as { rebuilt: { changed: string[] }[] }).rebuilt[0]?.changed ?? [];
    expect(changed.sort()).toEqual(["alerts", "state"]);
    expect(readFileSync(recordFile(env, KEY), "utf8")).toBe(bytes);
  });

  test("one key text rebuilds that key only; +p2 names the patch key", async () => {
    const env = await replayRoot();
    await seed(env, KEY, LINES);
    await seed(env, PATCHED, LINES);
    expect((await rebuildCall(env, "op_017", "kvfcu/open_sub@1.0.0+p2")).code).toBe(EXIT.ok);
    expect(existsSync(recordFile(env, PATCHED))).toBe(true);
    expect(existsSync(recordFile(env, KEY))).toBe(false);
    expect((await rebuildCall(env, "op_017", "kvfcu/open_sub@1.0.0")).code).toBe(EXIT.ok);
    expect(existsSync(recordFile(env, KEY))).toBe(true);
  });

  test("a key with no score files stays a draft; the record's artifact hash is the seal's; a bad history exits 7, names its line, and writes no record", async () => {
    const env = await replayRoot();
    const r = await rebuildCall(env, "op_017", "kvfcu/open_sub@1.0.0");
    expect(r.code).toBe(EXIT.ok);
    expect(r.stdout).toContain("no score files");
    expect(existsSync(join(env.root, "state", "trust", "scores"))).toBe(false);
    const none = await rebuildCall(env, "op_017", "--all");
    expect(none.code).toBe(EXIT.ok);
    expect(existsSync(join(env.root, "state", "trust", "scores"))).toBe(false);

    // the record's artifact hash is the hash the seal returned
    const sealed = await realWiringOf(env).candidates.seal(
      "kvfcu/open_sub/cand_2026-01-15_1000000009",
      "2.0.0",
      "op_017",
      { ...OPEN_SUB, identity: { ...OPEN_SUB.identity, version: "2.0.0" } },
      {},
    );
    if (!sealed.ok) throw new Error("test setup: seal failed");
    const key: ScoreKey = { ...KEY, capability: "kvfcu/open_sub@2.0.0" };
    await seed(env, key, LINES);
    await rebuildCall(env, "op_017", "kvfcu/open_sub@2.0.0");
    expect(ScoreRecord.parse(readRecord(env, key)).hashes).toEqual({ artifact: sealed.value.hash, patch: null });

    // a bad history exits 7, names its line, and writes no record
    await seed(env, KEY, [approved(1), retired(2), approved(3)]);
    const bad = await rebuildCall(env, "op_017", "--all");
    expect(bad.code).toBe(EXIT.invalid);
    expect(bad.stderr).toContain("line 3");
    expect(existsSync(recordFile(env, KEY))).toBe(false);
  });
});

describe("trust rebuild: refusals", () => {
  test("a missing or doubled target exits 1, a bad key text exits 1, a non-operator exits 6, and nothing is written; then --from-evidence rebuilds the record (M11)", async () => {
    const env = await replayRoot();
    await seed(env, KEY, LINES);
    // neither a key nor --all exits 1; both exit 1
    expect((await rebuildCall(env, "op_017")).code).toBe(EXIT.usage);
    expect((await rebuildCall(env, "op_017", "kvfcu/open_sub@1.0.0", "--all")).code).toBe(EXIT.usage);
    expect(existsSync(recordFile(env, KEY))).toBe(false);

    // a key that is not key text exits 1
    expect((await rebuildCall(env, "op_017", "kvfcu/open_sub")).code).toBe(EXIT.usage);
    expect((await rebuildCall(env, "op_017", "kvfcu/open_sub@1")).code).toBe(EXIT.usage);

    // an approver without the operator role exits 6 and writes nothing
    const denied = await rebuildCall(env, "op_031", "--all");
    expect(denied.code).toBe(EXIT.refused);
    expect(denied.stderr).toContain("operator");
    expect(existsSync(recordFile(env, KEY))).toBe(false);

    // an unknown staff ID exits 6
    expect((await rebuildCall(env, "op_999", "--all")).code).toBe(EXIT.refused);

    // --from-evidence rebuilds the record (M11): exit 0, and with no runs the record is the plain rebuild
    const r = await rebuildCall(env, "op_017", "--all", "--from-evidence");
    expect(r.code).toBe(EXIT.ok);
    expect(r.stderr).toBe("");
    expect(readRecord(env, KEY)).toEqual(expectedRecord(KEY, LINES));
  });
});

describe("certify writes a batch line on every path", () => {
  const SCORE_DIR = (env: ReplayEnv): string => join(folder(env, { ...KEY, capability: "kvfcu/open_sub@1.0.0" }));
  const history = (env: ReplayEnv): HistoryLine[] =>
    readFileSync(join(SCORE_DIR(env), "history.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => HistoryLine.parse(JSON.parse(l)));
  const reportOf = (env: ReplayEnv, id: string): unknown =>
    JSON.parse(readFileSync(join(env.root, "state", "evidence", "keystone", "batches", id, "report.json"), "utf8"));

  test("quick, case, and rerun each append one quick batch line, and the record stays a draft", LONG, async () => {
    const env = await replayRoot();
    await sealQuickInputs(env);
    const run = (argv: string[]) => certifyCall(env, "op_017", [...argv, "--json"]);
    const quick = await run(["certify", CAP, "--kind", "quick"]);
    const qId = (JSON.parse(quick.stdout) as { batch_id: string }).batch_id;
    const kase = await run(["certify", "case", CAP, "--class", "valid", "--profile", "server_error_on_search"]);
    const cId = (JSON.parse(kase.stdout) as { batch_id: string }).batch_id;
    const rerun = await run(["certify", "rerun", cId, "case"]);
    const rId = (JSON.parse(rerun.stdout) as { batch_id: string }).batch_id;

    const lines = history(env);
    expect(lines.map((l) => (l.event === "batch" ? l.batch : l.event))).toEqual([qId, cId, rId]);
    for (const [i, id] of [qId, cId, rId].entries()) {
      const line = lines[i];
      if (line?.event !== "batch") throw new Error("not a batch line");
      expect(line).toMatchObject({ by: "certify", kind: "quick", scores: null });
      expect(line.report_hash).toBe(hashJson(reportOf(env, id)));
      expect(line.under).toMatchObject({ jev: null, session: null, check: null });
      expect(line.under.engine).toMatch(/^\d+\.\d+\.\d+/);
      expect(line.under.handler_set).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(Number.isNaN(Date.parse(line.at))).toBe(false);
    }
    const gates = [quick, kase, rerun].map((c) => (c.code === EXIT.ok ? "passed" : "failed"));
    expect(lines.map((l) => (l.event === "batch" ? l.gate : ""))).toEqual(gates);

    // A quick batch is never approval-grade: the record stays a draft with no certify block.
    const record = ScoreRecord.parse(JSON.parse(readFileSync(join(SCORE_DIR(env), "record.json"), "utf8")));
    expect(record).toMatchObject({ state: "draft", certify: null, regression: null, approval: null });
    expect(record.key).toEqual({ capability: "kvfcu/open_sub@1.0.0", tenant: "keystone", app_version: "8.4", patch_revision: null });
    expect(record.hashes).toEqual({ artifact: ARTIFACT_HASH, patch: null });
  });

  test("a failing score store prints a warning and leaves the batch result and exit code", LONG, async () => {
    const env = await replayRoot();
    await sealQuickInputs(env);
    const argv = ["certify", CAP, "--kind", "quick", "--json"];
    const store = new FakeScoreStore<HistoryLine, ScoreRecord>({ line: HistoryLine, record: ScoreRecord });
    store.failWrites = true;
    const failing = await certifyCall(env, "op_017", argv, OPEN_SUB_ROUTE_FOR, { scores: store });
    const normal = await certifyCall(env, "op_017", argv);

    expect(failing.code).toBe(normal.code);
    expect([EXIT.ok, EXIT.failed]).toContain(failing.code);
    expect(failing.stderr).toContain("warning");
    expect(failing.stderr).toContain("trust rebuild");
    expect(normal.stderr).not.toContain("warning: the batch result was not saved");
    const body = JSON.parse(failing.stdout) as { batch_id: string; report: { gate: { passed: boolean } } };
    expect(body.batch_id).toMatch(/^batch_/);
    expect(body.report.gate.passed).toBe(failing.code === EXIT.ok);
    expect(await store.paths("keystone")).toEqual([]);
  });
});
