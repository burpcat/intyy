// Proves `intyy certify <key>` (a full batch, the default kind; design section 9 §9.1; section 8
// §7.1, §7.2, §9.5, §5.4, §4.2): a full batch writes a `batch` history line of kind full whose
// scores fill the record's `certify` block, the exit code follows the gate (0 or 5), a failed gate
// on an approved key appends a `degraded` line by `certify` while a passed gate leaves it approved,
// a drill (`--models off`) cannot pass rule 1, `--plan-only` writes and contacts nothing, and the
// refusals of the quick kind still hold. The harness is the route-mapping double, which cannot
// fire a fault. A key whose record holds candidate timeouts runs the batch with them (frozen in run.json,
// shown as `ran_with` in the report; section 8 §9.6, M10 task 11). Temporary data roots only. M10 tasks 3 and 4.
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
import { rebuild } from "../../../src/core/trust/rebuild.js";
import { approved, batch as batchLine, HASHES } from "../trust/kit.js";
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
  test("plan-only and a missing operator role touch nothing; a passing full batch exits 0, writes a full batch line, and fills the record's certify block; --kind full prints a summary; --models off makes a drill", LONG, async () => {
    const env = await readyEnv();
    // --plan-only prints the plan, contacts nothing, and writes no file
    const plan = await certifyCall(env, "op_017", ["certify", CAP, "--plan-only"]);
    expect(plan.code).toBe(EXIT.ok);
    expect(plan.stdout).toContain("full");
    expect(plan.stdout).toContain("plan only");
    expect(plan.harnesses.flatMap((h) => [...h.calls])).toEqual([]);
    expect(existsSync(join(env.root, "state", "evidence", "keystone", "batches"))).toBe(false);
    expect(existsSync(join(env.root, "state", "trust"))).toBe(false);

    // --plan-only with --models off says drill
    const planDrill = await certifyCall(env, "op_017", ["certify", CAP, "--plan-only", "--models", "off"]);
    expect(planDrill.code).toBe(EXIT.ok);
    expect(planDrill.stdout).toContain("drill: yes");

    // an operator role is needed
    const denied = await certifyCall(env, "op_031", ["certify", CAP]);
    expect(denied.code).toBe(EXIT.refused);
    expect(denied.harnesses.flatMap((h) => [...h.calls])).toEqual([]);

    // an unapproved suite is refused and nothing runs
    const bare = await replayRoot();
    await sealQuickInputs(bare, "suite");
    const noSuite = await certifyCall(bare, "op_017", ["certify", CAP]);
    expect(noSuite.code).toBe(EXIT.usage);
    expect(noSuite.stderr).toContain("suite");
    expect(noSuite.harnesses.flatMap((h) => [...h.calls])).toEqual([]);

    const r = await full(env);
    expect(r.code).toBe(EXIT.ok);
    expect(r.body.plan.kind).toBe("full");
    expect(r.body.report).toMatchObject({ kind: "full", gate: { passed: true } });
    // The full shape: baseline repeats, a twin, the matrix on every request step, then the kit's one stability run.
    expect(r.body.plan.cases.map((c) => c.case_id)).toEqual([
      "baseline", "baseline_valid_2", "baseline_valid_3", "twin", "server_error.click_search", "server_error.click_confirm", "stab_0.05_1",
    ]);
    expect(r.body.report.stability).toMatchObject([{ entropy: 0.05, runs: 1, pass: 1 }]);
    // a key with no candidate runs with the artifact's values
    expect(r.body.report.timeouts).toMatchObject({ ran_with: {}, ran_with_from: null });

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

    // --kind full prints a summary that names the gate
    const summary = await certifyCall(env, "op_017", ["certify", CAP, "--kind", "full"]);
    expect(summary.code).toBe(EXIT.ok);
    expect(summary.stdout).toContain("gate: passed");
    expect(summary.stdout).toContain("(full");

    // --models off makes a drill: it cannot pass rule 1, so it exits 5
    const drill = await full(env, "--models", "off");
    expect(drill.code).toBe(EXIT.failed);
    expect(drill.body.plan).toMatchObject({ drill: true, models_off: true });
    expect(drill.body.report.gate.rules).toMatchObject({ complete: false, matrix: true, baseline: true });
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
    // a passed gate leaves an approved key approved
    expect(history(env).map((l) => l.event)).toEqual(["approved", "batch"]);
    expect(before).toMatchObject({ state: "approved", state_by: "op_022" });

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

describe("certify (full): candidate timeouts (section 8 §9.6)", () => {
  test("a key whose record has a candidate runs the batch with it, and the report says so", LONG, async () => {
    const env = await readyEnv();
    const lines: HistoryLine[] = [
      batchLine(1, "batch_prior"),
      approved(2, "op_022", "batch_prior"),
      { event: "timeouts", at: "2026-01-15T09:03:00.000Z", by: "op_022", reason: "Installed.", batch: "batch_prior", values: {}, candidate: { click_search: 12000 } },
    ];
    const scores = realWiringOf(env).scores;
    for (const l of lines) {
      const r = await scores.append(keyPath(KEY), l);
      if (!r.ok) throw new Error("test setup: append failed");
    }
    const rebuilt = rebuild(KEY, HASHES, lines);
    if (!rebuilt.ok) throw new Error("test setup: rebuild failed");
    const put = await scores.putRecord(keyPath(KEY), rebuilt.value);
    if (!put.ok) throw new Error("test setup: putRecord failed");

    const r = await full(env);
    expect(r.code).toBe(EXIT.ok);
    expect(r.body.report.timeouts).toMatchObject({ ran_with: { click_search: 12000 }, ran_with_from: "batch_prior" });
    const first = r.body.plan.cases[0];
    const runJson = await realWiringOf(env).evidence.readRunJson("keystone", first?.run_id ?? "");
    if (!runJson.ok) throw new Error("no run.json");
    const frozen = (runJson.value as { frozen: { frozen: { timeouts: unknown; timeouts_from: unknown } } }).frozen.frozen;
    expect(frozen.timeouts).toEqual({ click_search: 12000 });
    expect(JSON.stringify(frozen.timeouts_from)).toContain("batch_prior");
  });
});
