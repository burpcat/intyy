// Proves `intyy certify <key>` (a full batch, the default kind; design section 9 §9.1; section 8
// §7.1, §7.2, §9.5, §5.4, §4.2): a full batch writes a `batch` history line of kind full whose
// scores fill the record's `certify` block, the exit code follows the gate (0 or 5), a failed gate
// on an approved key appends a `degraded` line by `certify` while a passed gate leaves it approved,
// a drill (`--models off`) cannot pass rule 1, `--plan-only` writes and contacts nothing, and the
// refusals of the quick kind still hold. The harness is the route-mapping double, which cannot
// fire a fault. Temporary data roots only. M10 tasks 3 and 4.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { EXIT } from "../../../src/cli/exit-codes.js";
import { hashJson } from "../../../src/core/model/canonical.js";
import type { BatchPlan } from "../../../src/core/model/batch-plan.js";
import type { BatchReport } from "../../../src/core/model/batch-report.js";
import { HistoryLine } from "../../../src/core/model/score-history.js";
import { ScoreRecord, type ScoreKey } from "../../../src/core/model/score.js";
import { keyPath } from "../../../src/core/trust/keys.js";
import { approved } from "../trust/kit.js";
import { CAP, certifyCall, editWith, sealQuickInputs } from "./certify-kit.js";
import { cleanRoots } from "./helpers.js";
import { realWiringOf, replayRoot, type ReplayEnv } from "./replay-harness.js";

afterAll(cleanRoots);

const LONG = { timeout: 120_000 };
const KEY: ScoreKey = { capability: "kvfcu/open_sub@1.0.0", tenant: "keystone", app_version: "8.4", patch_revision: null };

type Batch = { batch_id: string; plan: BatchPlan; report: BatchReport };

/** A root with the quick kit's suite and test data, and a fault set whose faults all recover. */
async function readyEnv(faults: "recovering" | "kit" = "recovering"): Promise<ReplayEnv> {
  const env = await replayRoot();
  await sealQuickInputs(env, faults === "recovering" ? "faults" : undefined);
  if (faults === "recovering") {
    await editWith(env, "op_017", ["faults", "edit", "kvfcu"], {
      schema: "intyy.faults/1.0",
      app: "kvfcu",
      revision: 1,
      profiles: [{ id: "server_error", kind: "server_error", at: "@each_request_step", expect_commit: "recovers", expect_window: "recovers" }],
    });
    await certifyCall(env, "op_017", ["faults", "seal", "kvfcu"]);
    await certifyCall(env, "op_031", ["faults", "approve", "kvfcu", "--rev", "1"]);
  }
  return env;
}

const scoreFolder = (env: ReplayEnv): string => join(env.root, "state", "trust", "scores", keyPath(KEY));
const history = (env: ReplayEnv): HistoryLine[] =>
  readFileSync(join(scoreFolder(env), "history.jsonl"), "utf8").trim().split("\n").map((l) => HistoryLine.parse(JSON.parse(l)));
const record = (env: ReplayEnv): ScoreRecord => ScoreRecord.parse(JSON.parse(readFileSync(join(scoreFolder(env), "record.json"), "utf8")));
const reportOf = (env: ReplayEnv, id: string): unknown =>
  JSON.parse(readFileSync(join(env.root, "state", "evidence", "keystone", "batches", id, "report.json"), "utf8"));

/** Runs `certify CAP --json` with `extra` arguments. */
async function full(env: ReplayEnv, ...extra: string[]) {
  const r = await certifyCall(env, "op_017", ["certify", CAP, ...extra, "--json"]);
  return { ...r, body: JSON.parse(r.stdout || "{}") as Batch };
}

describe("certify (full): the batch and its score line", () => {
  test("a passing full batch exits 0, writes a full batch line, and fills the record's certify block", LONG, async () => {
    const env = await readyEnv();
    const r = await full(env);
    expect(r.code).toBe(EXIT.ok);
    expect(r.body.plan.kind).toBe("full");
    expect(r.body.report).toMatchObject({ kind: "full", gate: { passed: true } });
    // The full shape: baseline repeats, a twin, then the matrix on every request step.
    expect(r.body.plan.cases.map((c) => c.case_id)).toEqual([
      "baseline", "baseline_valid_2", "baseline_valid_3", "twin", "server_error.click_search", "server_error.click_confirm",
    ]);
    expect(r.body.report.stability).toBeNull();

    const [line] = history(env);
    if (line?.event !== "batch") throw new Error("expected a batch line");
    expect(history(env)).toHaveLength(1);
    expect(line).toMatchObject({ by: "certify", kind: "full", batch: r.body.batch_id, gate: "passed" });
    expect(line.report_hash).toBe(hashJson(reportOf(env, r.body.batch_id)));
    expect(line.scores).toEqual({
      outcome_score: r.body.report.outcome_score,
      verdicts: r.body.report.verdicts,
      margin: { lowest: r.body.report.margin?.lowest, step: r.body.report.margin?.step },
      fragile: r.body.report.fragile,
    });
    expect(line.under.session).toBe("kvfcu/sign_in@1.0.0");

    const rec = record(env);
    expect(rec.certify).toMatchObject({ batch: r.body.batch_id, gate: "passed", scores: line.scores });
    expect(rec.regression).toBeNull();
    // A passed batch is not an approval: the key stays a draft until a person approves.
    expect(rec).toMatchObject({ state: "draft", approval: null });
  });

  test("a failed gate exits 5 and the batch line says failed", LONG, async () => {
    const env = await readyEnv("kit");
    const r = await full(env);
    // Why failed: the double cannot fire `reply_lost`, so its commit-step case ends unexplained.
    expect(r.code).toBe(EXIT.failed);
    expect(r.body.report.gate.passed).toBe(false);
    expect(r.body.report.gate.rules?.matrix).toBe(false);
    const [line] = history(env);
    expect(line).toMatchObject({ event: "batch", kind: "full", gate: "failed" });
    expect(record(env).certify).toMatchObject({ gate: "failed" });
    // A failed gate on a draft key degrades nothing: there is no trust to take away.
    expect(history(env).map((l) => l.event)).toEqual(["batch"]);
    expect(record(env).state).toBe("draft");
  });

  test("--kind full prints a summary that names the gate", LONG, async () => {
    const env = await readyEnv();
    const r = await certifyCall(env, "op_017", ["certify", CAP, "--kind", "full"]);
    expect(r.code).toBe(EXIT.ok);
    expect(r.stdout).toContain("gate: passed");
    expect(r.stdout).toContain("(full");
  });
});

describe("certify (full): approved keys", () => {
  /** Approves the key the way a person would have, with a line in its history. */
  async function approve(env: ReplayEnv): Promise<void> {
    const r = await realWiringOf(env).scores.append(keyPath(KEY), approved(1));
    if (!r.ok) throw new Error("test setup: append failed");
  }

  test("a failed gate on an approved key appends a degraded line by certify, naming the failing runs", LONG, async () => {
    const env = await readyEnv("kit");
    await approve(env);
    const r = await full(env);
    expect(r.code).toBe(EXIT.failed);
    const lines = history(env);
    expect(lines.map((l) => l.event)).toEqual(["approved", "batch", "degraded"]);
    const degraded = lines[2];
    if (degraded?.event !== "degraded") throw new Error("expected degraded");
    expect(degraded).toMatchObject({ by: "certify", rule: "certify" });
    expect(degraded.runs.length).toBeGreaterThan(0);
    const notPassing = r.body.report.cases.filter((c) => c.verdict !== "pass").map((c) => c.run_id);
    expect([...degraded.runs].sort()).toEqual([...notPassing].sort());
    expect(record(env)).toMatchObject({ state: "degraded", state_by: "certify" });
  });

  test("a passed gate leaves an approved key approved", LONG, async () => {
    const env = await readyEnv();
    await approve(env);
    const r = await full(env);
    expect(r.code).toBe(EXIT.ok);
    expect(history(env).map((l) => l.event)).toEqual(["approved", "batch"]);
    expect(record(env)).toMatchObject({ state: "approved", state_by: "op_022" });
  });
});

describe("certify (full): a drill never changes the record", () => {
  test("on an approved key a failed drill adds a drill batch line, no degraded line, and leaves certify as it was", LONG, async () => {
    const env = await readyEnv();
    const appended = await realWiringOf(env).scores.append(keyPath(KEY), approved(1));
    if (!appended.ok) throw new Error("test setup: append failed");
    const normal = await full(env);
    expect(normal.code).toBe(EXIT.ok);
    const before = record(env);
    expect(before).toMatchObject({ state: "approved" });
    expect(before.certify?.batch).toBe(normal.body.batch_id);

    // Why both fail: `--models off` and a declared instance each fail rule 1 (the batch is a drill).
    for (const extra of [["--models", "off"], ["--instance", "strip_semantics=1"]]) {
      const drill = await full(env, ...extra);
      expect(drill.code).toBe(EXIT.failed);
      expect(drill.body.plan.drill).toBe(true);
      const last = history(env).at(-1);
      expect(last).toMatchObject({ event: "batch", kind: "full", drill: true, gate: "failed", batch: drill.body.batch_id });
      expect(history(env).some((l) => l.event === "degraded")).toBe(false);
      expect(record(env)).toEqual(before);
    }
    expect(history(env).map((l) => l.event)).toEqual(["approved", "batch", "batch", "batch"]);
  });
});

describe("certify (full): drills and plan-only", () => {
  test("--models off makes a drill: it cannot pass rule 1, so it exits 5", LONG, async () => {
    const env = await readyEnv();
    const r = await full(env, "--models", "off");
    expect(r.code).toBe(EXIT.failed);
    expect(r.body.plan).toMatchObject({ drill: true, models_off: true });
    expect(r.body.report.gate.rules).toMatchObject({ complete: false, matrix: true, baseline: true });
  });

  test("--plan-only prints the plan, contacts nothing, and writes no file", async () => {
    const env = await readyEnv();
    const r = await certifyCall(env, "op_017", ["certify", CAP, "--plan-only"]);
    expect(r.code).toBe(EXIT.ok);
    expect(r.stdout).toContain("full");
    expect(r.stdout).toContain("plan only");
    expect(r.harnesses.flatMap((h) => [...h.calls])).toEqual([]);
    expect(existsSync(join(env.root, "state", "evidence", "keystone", "batches"))).toBe(false);
    expect(existsSync(join(env.root, "state", "trust"))).toBe(false);
  });

  test("--plan-only with --models off says drill", async () => {
    const env = await readyEnv();
    const r = await certifyCall(env, "op_017", ["certify", CAP, "--plan-only", "--models", "off"]);
    expect(r.code).toBe(EXIT.ok);
    expect(r.stdout).toContain("drill: yes");
  });
});

describe("certify (full): refusals", () => {
  test("an operator role is needed", async () => {
    const env = await readyEnv();
    const r = await certifyCall(env, "op_031", ["certify", CAP]);
    expect(r.code).toBe(EXIT.refused);
    expect(r.harnesses.flatMap((h) => [...h.calls])).toEqual([]);
  });

  test("an unapproved suite is refused and nothing runs", async () => {
    const env = await replayRoot();
    await sealQuickInputs(env, "suite");
    const r = await certifyCall(env, "op_017", ["certify", CAP]);
    expect(r.code).toBe(EXIT.usage);
    expect(r.stderr).toContain("suite");
    expect(r.harnesses.flatMap((h) => [...h.calls])).toEqual([]);
  });
});
