// Proves `intyy certify <key> --kind quick` (design section 9 §9.1, §9.2; section 8 §6.4, §7.1,
// §7.8): a baseline plus one case per commit-step profile, with seeds `<batch>:<profile>`; a
// declared instance that differs makes a drill; `--plan-only` contacts nothing and writes no file;
// refusals (kind, instance, role, unapproved inputs); a missing commit-step route is a gate note;
// and two batches on equal roots give the same plan, report, and run-log traces. The harness is
// a route-mapping double that cannot fire a fault, so a commit-step fault ends unexplained and
// the batch exits 5 (the gate failed). Never touches the bank app. M08 task 1.
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { EXIT } from "../../../src/cli/exit-codes.js";
import type { BatchPlan } from "../../../src/core/model/batch-plan.js";
import type { BatchReport } from "../../../src/core/model/batch-report.js";
import { cleanRoots } from "./helpers.js";
import { certifyCall, sealQuickInputs, CAP } from "./certify-kit.js";
import { realWiringOf, replayRoot, type ReplayEnv } from "./replay-harness.js";

afterAll(cleanRoots);

const LONG = { timeout: 120_000 };

type Batch = { batch_id: string; plan: BatchPlan; report: BatchReport };

async function readyEnv(skip?: "suite" | "testdata" | "faults"): Promise<ReplayEnv> {
  const env = await replayRoot();
  await sealQuickInputs(env, skip);
  return env;
}

const batchFiles = (env: ReplayEnv, id: string): { plan: BatchPlan; report: BatchReport } => {
  const dir = join(env.root, "state", "evidence", "keystone", "batches", id);
  return {
    plan: JSON.parse(readFileSync(join(dir, "plan.json"), "utf8")) as BatchPlan,
    report: JSON.parse(readFileSync(join(dir, "report.json"), "utf8")) as BatchReport,
  };
};

async function quick(env: ReplayEnv, ...extra: string[]): Promise<{ code: number; body: Batch; stderr: string }> {
  const r = await certifyCall(env, "op_017", ["certify", CAP, "--kind", "quick", ...extra, "--json"]);
  return { code: r.code, stderr: r.stderr, body: JSON.parse(r.stdout || "{}") as Batch };
}

describe("certify --kind quick: the batch", () => {
  test("a baseline and one case per commit-step profile, with seeds and files", LONG, async () => {
    const env = await readyEnv();
    const { code, body } = await quick(env);
    // Why 0 or 5: the double cannot fire a fault, so `reply_lost` ends unexplained (exit 5).
    expect([0, EXIT.failed]).toContain(code);
    const { plan, report } = batchFiles(env, body.batch_id);
    expect(plan.kind).toBe("quick");
    expect(plan.batch_id).toBe(body.batch_id);
    expect(Object.keys(plan.route_map)).toEqual(expect.arrayContaining(["click_search", "click_confirm"]));
    // The fixed @step:click_search profile is not on the commit step: not run.
    expect(plan.cases.map((c) => c.case_id)).toEqual(["baseline", "server_error", "reply_lost"]);
    expect(plan.cases.map((c) => c.seed)).toEqual([
      expect.any(String),
      `${body.batch_id}:server_error`,
      `${body.batch_id}:reply_lost`,
    ]);
    expect(plan.cases[1]?.faults[0]?.route).toBe("POST /confirm");
    expect(plan.cases[2]?.faults[0]?.route).toBe("POST /confirm");
    expect(report.cases.map((c) => c.case_id)).toEqual(["baseline", "server_error", "reply_lost"]);
    expect(report.gate.passed).toBe(report.cases.every((c) => c.verdict === "pass" || c.verdict === "explained"));
    expect(code).toBe(report.gate.passed ? EXIT.ok : EXIT.failed);
    expect(plan.drill).toBeUndefined();
    expect(plan.declaration).toBeUndefined();
    expect(report.drill).toBeUndefined();
  });

  test("a baseline with no commit-step route is a gate note, and the gate fails", LONG, async () => {
    const env = await readyEnv();
    const r = await certifyCall(env, "op_017", ["certify", CAP, "--kind", "quick", "--json"], {
      click_search: "POST /search",
    });
    expect(r.code).toBe(EXIT.failed);
    const body = JSON.parse(r.stdout) as Batch;
    const { plan, report } = batchFiles(env, body.batch_id);
    expect(report.gate.passed).toBe(false);
    expect(report.gate.notes).toHaveLength(2);
    expect(report.gate.notes?.join("\n")).toContain("server_error");
    expect(report.gate.notes?.join("\n")).toContain("reply_lost");
    expect(plan.cases.map((c) => c.case_id)).toEqual(["baseline"]);
  });
});

describe("certify --kind quick: drills (section 9 §9.2)", () => {
  test("a differing --instance fact makes plan and report drills, with the declaration", LONG, async () => {
    const env = await readyEnv();
    const { body } = await quick(env, "--instance", "strip_semantics=1");
    const { plan, report } = batchFiles(env, body.batch_id);
    expect(plan.drill).toBe(true);
    expect(report.drill).toBe(true);
    expect(plan.declaration).toEqual({ by: "op_017", differs: ["strip_semantics"] });
    expect(plan.instance.strip_semantics).toBe(true);
  });

  test("a declared fact equal to the default records the declaration but is no drill", LONG, async () => {
    const env = await readyEnv();
    const { body } = await quick(env, "--instance", "strip_semantics=0");
    const { plan, report } = batchFiles(env, body.batch_id);
    expect(plan.declaration).toEqual({ by: "op_017", differs: [] });
    expect(plan.drill).toBeUndefined();
    expect(report.drill).toBeUndefined();
  });
});

describe("certify --kind quick: --plan-only", () => {
  test("prints the case count, instance, declaration, and drill; no file; no harness call", async () => {
    const env = await readyEnv();
    const r = await certifyCall(env, "op_017", [
      "certify", CAP, "--kind", "quick", "--plan-only", "--instance", "strip_semantics=1",
    ]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("3 runs");
    expect(r.stdout).toContain("strip_semantics=true");
    expect(r.stdout).toContain("declared by op_017");
    expect(r.stdout).toContain("strip_semantics");
    expect(r.stdout).toContain("drill: yes");
    const batches = join(env.root, "state", "evidence", "keystone", "batches");
    expect(existsSync(batches) ? readdirSync(batches) : []).toEqual([]);
    expect(r.harnesses.flatMap((h) => [...h.calls])).toEqual([]);
  });

  test("without --instance: no declaration, no drill", async () => {
    const env = await readyEnv();
    const r = await certifyCall(env, "op_017", ["certify", CAP, "--kind", "quick", "--plan-only"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("drill: no");
    expect(r.stdout).toContain("declared: no");
  });
});

describe("certify --kind quick: refusals", () => {
  test("--kind regression with no --pack and --kind bogus are usage errors; nothing runs", async () => {
    const env = await readyEnv();
    const regression = await certifyCall(env, "op_017", ["certify", CAP, "--kind", "regression"]);
    expect(regression.code).toBe(EXIT.usage);
    expect(regression.stderr).toContain("--pack");
    const bogus = await certifyCall(env, "op_017", ["certify", CAP, "--kind", "bogus"]);
    expect(bogus.code).toBe(EXIT.usage);
    expect(bogus.stderr).toContain("bogus");
    for (const r of [regression, bogus]) expect(r.harnesses.flatMap((h) => [...h.calls])).toEqual([]);
    const batches = join(env.root, "state", "evidence", "keystone", "batches");
    expect(existsSync(batches) ? readdirSync(batches) : []).toEqual([]);
  });

  test.each([
    ["--kind full", ["certify", CAP, "--kind", "full", "--json"]],
    ["no --kind", ["certify", CAP, "--json"]],
  ])("%s runs a full batch", LONG, async (_name, argv) => {
    const env = await readyEnv();
    const r = await certifyCall(env, "op_017", argv);
    // Why 0 or 5: the double cannot fire a fault, so the gate may fail (exit 5).
    expect([0, EXIT.failed]).toContain(r.code);
    const body = JSON.parse(r.stdout) as Batch;
    expect(batchFiles(env, body.batch_id).plan.kind).toBe("full");
    expect(body.report.kind).toBe("full");
  });

  test("a bad --instance is a usage error", async () => {
    const env = await readyEnv();
    for (const bad of ["drop_labels=2", "colour=blue", "strip_semantics", "delay_scale=0"]) {
      const r = await certifyCall(env, "op_017", ["certify", CAP, "--kind", "quick", "--instance", bad]);
      expect(r.code).toBe(EXIT.usage);
      expect(r.stderr).toContain("--instance");
    }
  });

  test("op_031 holds no operator role: refused", async () => {
    const env = await readyEnv();
    const r = await certifyCall(env, "op_031", ["certify", CAP, "--kind", "quick"]);
    expect(r.code).toBe(6);
    expect(r.stderr).toContain("role:");
  });

  for (const missing of ["suite", "testdata", "faults"] as const) {
    test(`no approved ${missing}: refused, naming it`, async () => {
      const env = await readyEnv(missing);
      const r = await certifyCall(env, "op_017", ["certify", CAP, "--kind", "quick"]);
      expect(r.code).toBe(EXIT.usage);
      expect(r.stderr).toContain(missing);
    });
  }
});

/** The plan and report with batch ID, run IDs, and times replaced, for a same-inputs compare. */
function normalized(plan: BatchPlan, report: BatchReport): string {
  let text = JSON.stringify({ plan, report });
  for (const c of plan.cases) text = text.replaceAll(c.run_id, "RUN");
  text = text.replaceAll(plan.batch_id, "BATCH");
  return text.replace(/"(started_at|ended_at)":"[^"]*"/g, '"$1":"T"');
}

describe("certify --kind quick: determinism", () => {
  test("two batches on equal roots give the same plan, report, and run traces", LONG, async () => {
    const results: { text: string; traces: string[][] }[] = [];
    for (let i = 0; i < 2; i++) {
      const env = await readyEnv();
      const { body } = await quick(env);
      const { plan, report } = batchFiles(env, body.batch_id);
      const traces: string[][] = [];
      for (const c of plan.cases) {
        const events = await realWiringOf(env).evidence.events("keystone", c.run_id);
        if (!events.ok) throw new Error("run log unreadable");
        traces.push(events.value.map((e) => String((e as { event?: unknown }).event)));
      }
      results.push({ text: normalized(plan, report), traces });
    }
    expect(results[1]?.text).toBe(results[0]?.text);
    expect(results[1]?.traces).toEqual(results[0]?.traces);
  });
});
