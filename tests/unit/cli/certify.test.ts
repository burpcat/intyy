// Proves `intyy certify case | rerun | report` (design section 9 §9.1; section 8 §7.1, §7.4 to
// §7.8; updates file §11.1, "--profile also accepts a suite extra case ID"): exit codes 0/5,
// operator-role refusal, a missing approved suite/testdata/faults refused, and `--profile` as a
// suite extra case ID. Builds on the M05 replay CLI harness (sealed artifacts, policy, settings)
// plus a route-mapping harness double standing in for the bank app's test-mode controls
// (tests/unit/certify/route-mapping-harness.ts). Also the `pin`: an exact key, `@<major>` as the
// newest sealed, an unsealed pin refused, the pin in plan.json and run_start, and rerun keeping
// the plan's pin (section 3 §4.9; section 9 §9.1). M06 tasks 8 and 12.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { wire as realWire } from "../../../src/cli/wiring.js";
import { commands } from "../../../src/cli/commands/index.js";
import { EXIT } from "../../../src/cli/exit-codes.js";
import { run } from "../../../src/cli/program.js";
import type { Io } from "../../../src/cli/output.js";
import type { BatchReport } from "../../../src/core/model/batch-report.js";
import { FakeHarness } from "../../../src/fakes/harness.js";
import { snapshotFactory } from "../../../src/fakes/snapshot-surface/index.js";
import { fixtureSite, MEMBER_FOUND, OPEN_SUB } from "../replay/executor-harness.js";
import {
  idsNotifying,
  OPEN_SUB_ROUTE_FOR,
  RouteMappingHarness,
} from "../certify/route-mapping-harness.js";
import { cleanRoots } from "./helpers.js";
import { REQUEST_INDEX_ENV, type ReplayEnv, realWiringOf, replayRoot } from "./replay-harness.js";

/** The request index's one signing key, bound the same way `replay-harness.ts`'s own settings
 * doc expects it (section 4 §8.11): every certify call needs it too, since `runReplay` records
 * every dispatched request through the same index. */
const REQUEST_INDEX_KEY_VALUE = "test-request-index-key";

afterAll(cleanRoots);

const CAP = "kvfcu/open_sub@1";

/** Runs one `intyy` call against `env`, its policy/settings swapped in, its discovery surface
 * the fake site, and its harness the route-mapping double (tests/unit/certify/route-mapping-harness.ts). */
async function certifyCall(
  env: ReplayEnv,
  staff: string,
  argv: readonly string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const io: Io = {
    stdout: { write: (t) => (stdout += t), isTTY: false },
    stderr: { write: (t) => (stderr += t), isTTY: false },
    stdin: {
      isTTY: false,
      readAll: () => Promise.resolve(""),
      question: () => Promise.resolve(""),
    },
    env: { [REQUEST_INDEX_ENV]: REQUEST_INDEX_KEY_VALUE, INTYY_STAFF: staff },
    cwd: env.root,
  };
  const code = await run(argv, io, {
    commands,
    wire: (root, config, wireEnv) => {
      const real = realWire(root, config, wireEnv);
      const base = new FakeHarness();
      const routeHarness = new RouteMappingHarness(
        base,
        real.evidence,
        "keystone",
        OPEN_SUB_ROUTE_FOR,
      );
      return {
        ...real,
        policy: env.policy,
        settings: env.settings,
        ids: idsNotifying(real.ids, routeHarness),
        discovery: {
          surface: () => snapshotFactory(fixtureSite()),
          marker: real.discovery.marker,
          planner: () => {
            throw new Error("certify never opens a model");
          },
          operator: () => {
            throw new Error("certify never asks the CLI's own operator port");
          },
        },
        // Why a plain cast, not a Masked one (unrestricted here): `Wiring.harness` is typed to
        // return the concrete `KvfcuHarness`; every certify caller only ever uses it through
        // the `Harness` port, so the fake fits at call sites even though it fails the literal
        // return type.
        harness: (() => routeHarness) as unknown as typeof real.harness,
      };
    },
  });
  return { code, stdout, stderr };
}

/** Reads and edits a fixture JSON file at a given path, through the `EDITOR: cp` trick. */
async function editWith(
  env: ReplayEnv,
  staff: string,
  argv: readonly string[],
  body: Record<string, unknown>,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const editedPath = join(env.root, `edited-${String(Math.random()).slice(2)}.json`);
  writeFileSync(editedPath, JSON.stringify(body));
  let stdout = "";
  let stderr = "";
  const io: Io = {
    stdout: { write: (t) => (stdout += t), isTTY: false },
    stderr: { write: (t) => (stderr += t), isTTY: false },
    stdin: {
      isTTY: false,
      readAll: () => Promise.resolve(""),
      question: () => Promise.resolve(""),
    },
    env: {
      [REQUEST_INDEX_ENV]: REQUEST_INDEX_KEY_VALUE,
      INTYY_STAFF: staff,
      EDITOR: `cp "${editedPath}"`,
    },
    cwd: env.root,
  };
  const code = await run(argv, io, { commands });
  return { code, stdout, stderr };
}

/** Seals and approves the certify inputs (suite, testdata, faults) for `kvfcu/open_sub@1`,
 * through the real CLI, on top of an already-sealed-and-approved `replayRoot()`. `skip` leaves
 * one of them un-approved, to prove `certify case` refuses. */
async function sealCertifyInputs(
  env: ReplayEnv,
  skip?: "suite" | "testdata" | "faults",
): Promise<void> {
  if (skip !== "suite") {
    await editWith(env, "op_017", ["suite", "edit", CAP], {
      schema: "intyy.suite/1.0",
      capability: CAP,
      revision: 1,
      reason: "Test suite.",
      classes: [
        { id: "valid", inputs: { member_id: "@members.valid" }, expect: { status: "success" } },
      ],
      matrix: { class: "valid", profiles: "standard" },
      stability: { class: "valid", levels: [0.05], seeds: 1, twins: false },
      drills: { count: 0 },
      extra: [
        {
          id: "extra_search_fault",
          class: "valid",
          faults: [{ kind: "server_error", at: "@step:click_search" }],
          expect: { status: "success" },
        },
      ],
      setup: [],
      provenance: { runs: [], decisions: [], sealed: null },
    });
    await certifyCall(env, "op_017", ["suite", "seal", CAP]);
    await certifyCall(env, "op_031", ["suite", "approve", CAP, "--rev", "1"]);
  }
  if (skip !== "testdata") {
    await editWith(env, "op_017", ["testdata", "edit", "kvfcu"], {
      schema: "intyy.testdata/1.0",
      tenant: "keystone",
      app: "kvfcu",
      revision: 1,
      pools: { "members.valid": [MEMBER_FOUND] },
      instance: { variant: "keystone", strip_semantics: false, drop_labels: 0, label_seed: "0" },
      business_date: "2026-01-15",
    });
    await certifyCall(env, "op_017", ["testdata", "seal", "kvfcu"]);
    await certifyCall(env, "op_022", ["testdata", "approve", "kvfcu", "--rev", "1"]);
  }
  if (skip !== "faults") {
    await editWith(env, "op_017", ["faults", "edit", "kvfcu"], {
      schema: "intyy.faults/1.0",
      app: "kvfcu",
      revision: 1,
      profiles: [
        {
          id: "server_error_on_search",
          kind: "server_error",
          at: "@step:click_search",
          expect_commit: "recovers",
          expect_window: "recovers",
        },
      ],
    });
    await certifyCall(env, "op_017", ["faults", "seal", "kvfcu"]);
    await certifyCall(env, "op_031", ["faults", "approve", "kvfcu", "--rev", "1"]);
  }
}

describe("certify case: missing approved inputs refused", () => {
  test("no approved suite: usage error naming it", async () => {
    const env = await replayRoot();
    await sealCertifyInputs(env, "suite");
    const r = await certifyCall(env, "op_017", [
      "certify",
      "case",
      CAP,
      "--class",
      "valid",
      "--profile",
      "server_error_on_search",
    ]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("suite");
  });

  test("no approved testdata: usage error naming it", async () => {
    const env = await replayRoot();
    await sealCertifyInputs(env, "testdata");
    const r = await certifyCall(env, "op_017", [
      "certify",
      "case",
      CAP,
      "--class",
      "valid",
      "--profile",
      "server_error_on_search",
    ]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("testdata");
  });

  test("no approved faults: usage error naming it", async () => {
    const env = await replayRoot();
    await sealCertifyInputs(env, "faults");
    const r = await certifyCall(env, "op_017", [
      "certify",
      "case",
      CAP,
      "--class",
      "valid",
      "--profile",
      "server_error_on_search",
    ]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("faults");
  });
});

describe("certify case: role", () => {
  test("op_031 holds no operator role anywhere: refused", async () => {
    const env = await replayRoot();
    await sealCertifyInputs(env);
    const r = await certifyCall(env, "op_031", [
      "certify",
      "case",
      CAP,
      "--class",
      "valid",
      "--profile",
      "server_error_on_search",
    ]);
    expect(r.code).toBe(6);
    expect(r.stderr).toContain("role:");
  });
});

describe("certify case: exit codes", () => {
  test("a passing case exits 0, writes plan.json and report.json, batch_id and case_id match", async () => {
    const env = await replayRoot();
    await sealCertifyInputs(env);
    const r = await certifyCall(env, "op_017", [
      "certify",
      "case",
      CAP,
      "--class",
      "valid",
      "--profile",
      "server_error_on_search",
      "--json",
    ]);
    expect(r.code).toBe(0);
    const body = JSON.parse(r.stdout) as { batch_id: string; report: BatchReport };
    expect(body.report.gate.passed).toBe(true);
    const planPath = join(
      env.root,
      "state",
      "evidence",
      "keystone",
      "batches",
      body.batch_id,
      "plan.json",
    );
    const reportPath = join(
      env.root,
      "state",
      "evidence",
      "keystone",
      "batches",
      body.batch_id,
      "report.json",
    );
    const plan = JSON.parse(readFileSync(planPath, "utf8")) as {
      batch_id: string;
      cases: { case_id: string }[];
    };
    const report = JSON.parse(readFileSync(reportPath, "utf8")) as { batch_id: string };
    expect(plan.batch_id).toBe(body.batch_id);
    expect(report.batch_id).toBe(body.batch_id);
    expect(plan.cases.map((c) => c.case_id)).toEqual(["baseline", "case"]);

    const reported = await certifyCall(env, "op_017", [
      "certify",
      "report",
      body.batch_id,
      "--json",
    ]);
    expect(reported.code).toBe(0);
    expect((JSON.parse(reported.stdout) as { batch_id: string }).batch_id).toBe(body.batch_id);
  });

  test("--profile also accepts a suite extra case ID, taking its own class", async () => {
    const env = await replayRoot();
    await sealCertifyInputs(env);
    const r = await certifyCall(env, "op_017", [
      "certify",
      "case",
      CAP,
      "--profile",
      "extra_search_fault",
      "--json",
    ]);
    expect(r.code).toBe(0);
    const body = JSON.parse(r.stdout) as { report: BatchReport };
    expect(body.report.cases[0]?.result.status).toBe("success");
  });

  test("--operator bogus exits usage and names the choices; nothing runs", async () => {
    const env = await replayRoot();
    await sealCertifyInputs(env);
    const r = await certifyCall(env, "op_017", [
      "certify", "case", CAP, "--class", "valid", "--profile", "server_error_on_search", "--operator", "bogus", "--json",
    ]);
    expect(r.code).toBe(EXIT.usage);
    expect(r.stderr).toContain("scripted");
    expect(r.stderr).toContain("mailbox");
    expect(r.stdout).not.toContain("batch_id");
  });

  test("--operator scripted runs like the default and the plan records it (M07 task 9)", async () => {
    const env = await replayRoot();
    await sealCertifyInputs(env);
    const r = await certifyCall(env, "op_017", [
      "certify", "case", CAP, "--class", "valid", "--profile", "server_error_on_search", "--operator", "scripted", "--json",
    ]);
    expect(r.code).toBe(0);
    const body = JSON.parse(r.stdout) as { batch_id: string };
    const plan = JSON.parse(
      readFileSync(join(env.root, "state", "evidence", "keystone", "batches", body.batch_id, "plan.json"), "utf8"),
    ) as { operator?: string; started_by: string };
    expect(plan).toMatchObject({ operator: "scripted", started_by: "op_017" });
  });

  test("a mismatched class exits 5 (the gate failed)", async () => {
    const env = await replayRoot();
    await sealCertifyInputs(env);
    // The site's default member is found, but this class expects a business outcome: a
    // deliberate mismatch, exactly like tests/unit/certify/runner.test.ts's own "mismatch" case.
    await editWith(env, "op_017", ["suite", "edit", CAP], {
      schema: "intyy.suite/1.0",
      capability: CAP,
      revision: 2,
      reason: "Add a class that never matches, for the gate-failure test.",
      classes: [
        { id: "valid", inputs: { member_id: "@members.valid" }, expect: { status: "success" } },
        {
          id: "wrong",
          inputs: { member_id: "@members.valid" },
          expect: { status: "business_outcome", outcome: "member_not_found" },
        },
      ],
      matrix: { class: "valid", profiles: "standard" },
      stability: { class: "valid", levels: [0.05], seeds: 1, twins: false },
      drills: { count: 0 },
      extra: [],
      setup: [],
      provenance: { runs: [], decisions: [], sealed: null },
    });
    await certifyCall(env, "op_017", ["suite", "seal", CAP]);
    await certifyCall(env, "op_031", ["suite", "approve", CAP, "--rev", "2"]);

    const r = await certifyCall(env, "op_017", [
      "certify",
      "case",
      CAP,
      "--class",
      "wrong",
      "--profile",
      "server_error_on_search",
      "--json",
    ]);
    expect(r.code).toBe(5);
    const body = JSON.parse(r.stdout) as { report: BatchReport };
    expect(body.report.gate.passed).toBe(false);
  });
});

describe("certify rerun", () => {
  test("repeats one case with a fresh run ID", { timeout: 20000 }, async () => {
    const env = await replayRoot();
    await sealCertifyInputs(env);
    const first = await certifyCall(env, "op_017", [
      "certify",
      "case",
      CAP,
      "--class",
      "valid",
      "--profile",
      "server_error_on_search",
      "--json",
    ]);
    expect(first.code).toBe(0);
    const firstBody = JSON.parse(first.stdout) as { batch_id: string };

    const second = await certifyCall(env, "op_017", [
      "certify",
      "rerun",
      firstBody.batch_id,
      "case",
      "--json",
    ]);
    expect(second.code).toBe(0);
    const secondBody = JSON.parse(second.stdout) as { batch_id: string; report: BatchReport };
    expect(secondBody.batch_id).not.toBe(firstBody.batch_id);
    expect(secondBody.report.cases[0]?.result.status).toBe("success");
  });
});

/** Seals a newer `open_sub` version, `1.1.0`, next to the `1.0.0` that `replayRoot()` sealed. */
async function sealNewerOpenSub(env: ReplayEnv): Promise<void> {
  const sealed = await realWiringOf(env).candidates.seal(
    "kvfcu/open_sub/cand_2026-01-15_1000000005",
    "1.1.0",
    "op_017",
    // Why the new `identity.version`: the pin reads the artifact's own version.
    { ...OPEN_SUB, identity: { ...OPEN_SUB.identity, version: "1.1.0" } },
    {},
  );
  if (!sealed.ok) throw new Error("test setup: open_sub 1.1.0 seal failed");
}

type Batch = {
  batch_id: string;
  plan: { pin: string; cases: { run_id: string }[] };
  report: BatchReport;
};

/** The `pin` on one run's `run_start` line, or undefined. */
async function runStartPin(env: ReplayEnv, runId: string): Promise<unknown> {
  const events = await realWiringOf(env).evidence.events("keystone", runId);
  if (!events.ok) throw new Error("test setup: the run log cannot be read");
  const start = events.value.find((e) => (e as { event?: unknown }).event === "run_start") as
    { data?: { pin?: unknown } } | undefined;
  return start?.data?.pin;
}

async function certifyWith(
  env: ReplayEnv,
  key: string,
): Promise<{ code: number; stderr: string; body?: Batch }> {
  const r = await certifyCall(env, "op_017", [
    "certify",
    "case",
    key,
    "--class",
    "valid",
    "--profile",
    "server_error_on_search",
    "--json",
  ]);
  return r.stdout.trim() === "" || r.code === 7 || r.code === 1
    ? { code: r.code, stderr: r.stderr }
    : { code: r.code, stderr: r.stderr, body: JSON.parse(r.stdout) as Batch };
}

describe("certify case: the pin (section 3 §4.9)", () => {
  test(
    "an exact pin runs that version, even when a newer one is sealed",
    { timeout: 20000 },
    async () => {
      const env = await replayRoot();
      await sealCertifyInputs(env);
      await sealNewerOpenSub(env);
      const r = await certifyWith(env, "kvfcu/open_sub@1.0.0");
      expect(r.code).toBe(0);
      expect(r.body?.plan.pin).toBe("kvfcu/open_sub@1.0.0");
    },
  );

  test("@<major> resolves the newest sealed version", { timeout: 20000 }, async () => {
    const env = await replayRoot();
    await sealCertifyInputs(env);
    await sealNewerOpenSub(env);
    const r = await certifyWith(env, CAP);
    expect(r.code).toBe(0);
    expect(r.body?.plan.pin).toBe("kvfcu/open_sub@1.1.0");
  });

  test("an exact version that is not sealed ends version_not_sealed", async () => {
    const env = await replayRoot();
    await sealCertifyInputs(env);
    const r = await certifyWith(env, "kvfcu/open_sub@1.2.0");
    expect(r.code).toBe(7);
    expect(r.stderr).toContain("version_not_sealed");
  });

  test("plan.json and both run_start lines carry the pin", { timeout: 20000 }, async () => {
    const env = await replayRoot();
    await sealCertifyInputs(env);
    const r = await certifyWith(env, "kvfcu/open_sub@1.0.0");
    expect(r.code).toBe(0);
    const body = r.body;
    if (body === undefined) throw new Error("expected a batch");
    const planPath = join(
      env.root,
      "state",
      "evidence",
      "keystone",
      "batches",
      body.batch_id,
      "plan.json",
    );
    expect((JSON.parse(readFileSync(planPath, "utf8")) as { pin: string }).pin).toBe(
      "kvfcu/open_sub@1.0.0",
    );
    expect(body.plan.cases).toHaveLength(2);
    for (const c of body.plan.cases)
      expect(await runStartPin(env, c.run_id)).toBe("kvfcu/open_sub@1.0.0");
  });

  test(
    "rerun keeps the plan's pin when a newer version is sealed later",
    { timeout: 30000 },
    async () => {
      const env = await replayRoot();
      await sealCertifyInputs(env);
      const first = await certifyWith(env, CAP);
      expect(first.body?.plan.pin).toBe("kvfcu/open_sub@1.0.0");
      await sealNewerOpenSub(env);

      const second = await certifyCall(env, "op_017", [
        "certify",
        "rerun",
        first.body?.batch_id ?? "",
        "case",
        "--json",
      ]);
      expect(second.code).toBe(0);
      const body = JSON.parse(second.stdout) as Batch;
      expect(body.plan.pin).toBe("kvfcu/open_sub@1.0.0");
      const caseRun = body.plan.cases[1];
      expect(await runStartPin(env, caseRun?.run_id ?? "")).toBe("kvfcu/open_sub@1.0.0");
    },
  );
});
