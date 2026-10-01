// Shared harness for the M06 live certify tests (tests/live/fault-table.test.ts,
// tests/live/demo-step6.test.ts): the prerequisite check, and one in-process `intyy certify case`
// call per fault case. Not a test file: no `describe`/`test` here. Follows design section 5 §14
// (the bank's faults, rung by rung), section 8 §6.3 (standard fault profiles) and §7.4 (a case),
// and section 9 §9.1 (`certify case`). M06 task 12.
//
// How it stays safe: the CLI runs against a temp data root whose `library/` is a symlink to the
// real one (read-only use), so evidence and lock files never land in the real `state/`. The
// caller holds the real bank-app instance lock. Secrets come from `.env` into an env copy and
// are never printed. Only 127.0.0.1 is contacted (the settings origin).
import { copyFileSync, mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { FileDocumentStore } from "../../src/adapters/files/document-store.js";
import { FileCandidateStore, FileEvidenceStore } from "../../src/adapters/files/other-stores.js";
import { loadDotEnv } from "../../src/cli/env.js";
import { wire, type Wiring } from "../../src/cli/wiring.js";
import { requestStepsFor, resolveAnchor } from "../../src/core/certify/anchors.js";
import type { RouteMap } from "../../src/core/certify/route-map.js";
import { Artifact } from "../../src/core/model/artifact.js";
import { BatchPlan } from "../../src/core/model/batch-plan.js";
import { BatchReport } from "../../src/core/model/batch-report.js";
import { CandidateDecision } from "../../src/core/model/candidate-decision.js";
import { CandidateIssues } from "../../src/core/model/candidate-issues.js";
import { CandidateRuns } from "../../src/core/model/candidate-runs.js";
import { faultsKind, packKind, suiteKind, testdataKind } from "../../src/core/model/kinds.js";
import type { CandidateFiles } from "../../src/core/recorder/candidates.js";
import { tempRoot } from "../unit/safety/canary-kit.js";
import { call } from "../unit/cli/helpers.js";
import { ROOT, clock, config } from "./replay-demo-kit.js";

/** The capability under test, as `certify case` names it (the exact pin, as section 9 §13.2 row 6 writes it). */
const KEY = "kvfcu/open_share_subaccount@1.0.0";
/** The suite's own ID: the suite is found by major. */
const SUITE_ID = "kvfcu/open_share_subaccount@1";
const TASK = "kvfcu/open_share_subaccount";
/** The sealed version the owner's discoveries produce (M06 spec, "Owner checks"). */
const VERSION = "1.0.0";
/** An operator in the real `library/staff.json`. */
const STAFF = "op_017";
/** One fixed batch ID. A case's seed is `<batch_id>:case`, so every run uses the same seed
 * (M06 spec, Live rows: "Named faults, fixed seed"). Shaped like `Ids.batchId()`. */
const FIXED_BATCH = "batch_2026-09-30_0000000000";
/** A certify case runs a baseline and then the case: two replays, so give it room. */
export const CASE_TIMEOUT_MS = 180_000;

const lib = join(ROOT, config.library);
const tmpDir = join(ROOT, config.state, "var", "tmp");

function candidateStore(): FileCandidateStore<
  CandidateFiles,
  ReturnType<typeof CandidateDecision.parse>
> {
  return new FileCandidateStore<CandidateFiles, ReturnType<typeof CandidateDecision.parse>>(
    {
      files: {
        "runs.json": CandidateRuns,
        "candidate.json": Artifact,
        "issues.json": CandidateIssues,
      },
      decision: CandidateDecision,
    },
    { dir: join(lib, "candidates"), artifactsDir: join(lib, "artifacts"), tmpDir },
    clock,
  );
}

/** True when `id` has an approved revision. A missing store folder counts as "none". */
async function hasApproved(
  store: { list(filter: { id: string }): Promise<{ state: string }[]> },
  id: string,
): Promise<boolean> {
  try {
    return (await store.list({ id })).some((s) => s.state === "approved");
  } catch {
    return false;
  }
}

/**
 * Fails with ONE message that names every missing owner step. Never skips, and never treats the
 * missing state as a pass. The steps: the task artifact sealed, then suite, test data, faults, and
 * both packs approved (M06 spec, "Owner checks").
 */
export async function requireCertifyPrereqs(): Promise<void> {
  const missing: string[] = [];
  const artifacts = candidateStore();
  // Why one artifact: the owner chose a reconciliation waiver for open_share_subaccount, so no
  // find_account_by_reference exists (docs/decisions.md, 2026-09-30, M05).
  if (!(await artifacts.listSealedVersions(TASK)).includes(VERSION))
    missing.push(`sealed ${TASK}@${VERSION}`);
  const dirs = (dir: string): { dir: string; tmpDir: string } => ({ dir: join(lib, dir), tmpDir });
  const packs = new FileDocumentStore(packKind, dirs("packs"), clock);
  const wanted = [
    [
      `approved suite ${SUITE_ID}`,
      new FileDocumentStore(suiteKind, dirs("suites"), clock),
      SUITE_ID,
    ],
    [
      `approved testdata ${config.default_tenant}/kvfcu`,
      new FileDocumentStore(testdataKind, dirs("testdata"), clock),
      `${config.default_tenant}/kvfcu`,
    ],
    ["approved faults kvfcu", new FileDocumentStore(faultsKind, dirs("faults"), clock), "kvfcu"],
    ["approved pack global", packs, "global"],
    ["approved pack app/kvfcu", packs, "app/kvfcu"],
  ] as const;
  for (const [label, store, id] of wanted) if (!(await hasApproved(store, id))) missing.push(label);
  if (missing.length > 0) {
    throw new Error(
      `M06 live certify tests cannot run yet. Missing owner steps: ${missing.join("; ")}. ` +
        "Seal the discoveries, then approve the suite, test data, faults, and packs.",
    );
  }
}

/** The real wiring, with one fixed batch ID so the case seed is fixed. */
function fixedWire(
  root: string,
  cfg: Parameters<typeof wire>[1],
  env: Record<string, string | undefined>,
): Wiring {
  const w = wire(root, cfg, env);
  return {
    ...w,
    ids: {
      runId: () => w.ids.runId(),
      batchId: () => FIXED_BATCH,
      leaseToken: () => w.ids.leaseToken(),
      alertId: () => w.ids.alertId(),
      candidateId: () => w.ids.candidateId(),
    },
  };
}

/** What a finished case leaves to assert on. */
export type CaseRun = {
  code: number;
  report: BatchReport;
  plan: BatchPlan;
  /** The case run's own `result.effect.commit`, or null. */
  commit: string | null;
  /** The case run's `result.recoveries`, as `{ via, ref }`. */
  recoveries: { via: string; ref: string }[];
  remove: () => Promise<void>;
};

const CaseFacts = z
  .object({
    result: z
      .object({
        effect: z.object({ commit: z.string() }).loose().nullish(),
        recoveries: z.array(z.object({ via: z.string(), ref: z.string() }).loose()).optional(),
      })
      .loose(),
  })
  .loose();

/** One in-process `intyy certify …` call in a fresh temp data root. `tail` is everything after
 * the global flags, like `["certify", "case", KEY, "--class", "valid", …]`. */
async function invoke(tail: string[]): Promise<{
  code: number;
  stdout: string;
  stderr: string;
  root: string;
  remove: () => Promise<void>;
}> {
  const tmp = await tempRoot("intyy-certify-live-");
  copyFileSync(join(ROOT, "intyy.json"), join(tmp.root, "intyy.json"));
  mkdirSync(join(tmp.root, config.state), { recursive: true });
  symlinkSync(lib, join(tmp.root, config.library));
  const env: Record<string, string | undefined> = { ...process.env };
  loadDotEnv(ROOT, env);
  const done = await call(
    [
      "--root",
      tmp.root,
      "--staff",
      STAFF,
      "--json",
      "--models",
      "off",
      ...tail,
    ],
    { cwd: tmp.root, env, deps: { wire: fixedWire } },
  );
  return {
    code: done.code,
    stdout: done.stdout,
    stderr: done.stderr,
    root: tmp.root,
    remove: tmp.remove,
  };
}

/**
 * Runs `certify case kvfcu/open_share_subaccount@1.0.0 --class valid --profile <profile>` (with
 * `--at @step:<at>` when given) and reads back the case run's own facts. Throws with the CLI's
 * stderr text when the command printed no batch (a usage or environment problem, not a verdict).
 */
export async function certifyCase(profile: string, at?: string): Promise<CaseRun> {
  const r = await invoke([
    "certify",
    "case",
    KEY,
    "--class",
    "valid",
    "--profile",
    profile,
    ...(at === undefined ? [] : ["--at", `@step:${at}`]),
  ]);
  let parsed: { plan: BatchPlan; report: BatchReport };
  try {
    const raw: unknown = JSON.parse(r.stdout);
    parsed = z.object({ plan: BatchPlan, report: BatchReport }).parse(raw);
  } catch {
    await r.remove();
    throw new Error(
      `certify case --profile ${profile} printed no batch (exit ${String(r.code)}): ${r.stderr.trim()}`,
    );
  }
  const caseRunId = parsed.report.cases[0]?.run_id ?? "";
  const evidence = new FileEvidenceStore({
    root: join(r.root, config.state, "evidence"),
    tmpDir: join(r.root, config.state, "var", "tmp"),
  });
  const runJson = await evidence.readRunJson(config.default_tenant, caseRunId);
  if (!runJson.ok) {
    await r.remove();
    throw new Error(`the case run ${caseRunId} left no readable run.json`);
  }
  const facts = CaseFacts.parse(runJson.value);
  return {
    code: r.code,
    report: parsed.report,
    plan: parsed.plan,
    commit: facts.result.effect?.commit ?? null,
    recoveries: facts.result.recoveries ?? [],
    remove: r.remove,
  };
}

type Steps = { windowStep: string; commitStep: string; replyLost: CaseRun };
let stepsMemo: Promise<Steps> | undefined;

/**
 * Two task steps that send a request: one `idempotent` step (window open) and the commit step
 * (window closed). Found once per file from a real baseline's route map (plan.json's
 * `route_map`, section 8 §6.4), through the core anchor code: the `reply_lost` case resolves
 * `@commit_point`, so the fault it armed names the commit step's route and count; the other
 * request steps come from `requestStepsFor`, and `resolveAnchor` must accept the pick. The
 * `reply_lost` case itself is returned, so a caller need not run it twice.
 */
export function faultSteps(): Promise<Steps> {
  stepsMemo ??= (async () => {
    const replyLost = await certifyCase("reply_lost");
    const routeMap: RouteMap = new Map(Object.entries(replyLost.plan.route_map));
    const armed = replyLost.plan.cases.find((c) => c.case_id === "case")?.faults[0];
    const commitStep =
      armed === undefined
        ? undefined
        : requestStepsFor(routeMap).find((s) => {
            const e = routeMap.get(s);
            return e?.route === armed.route && e.nth === armed.nth;
          });
    if (commitStep === undefined)
      throw new Error("the reply_lost fault matches no request step in the route map");
    const windowStep = requestStepsFor(routeMap).find((s) => s !== commitStep);
    if (windowStep === undefined)
      throw new Error("the baseline sent no request before the commit step");
    const placed = resolveAnchor("@each_request_step", routeMap, commitStep, `@step:${windowStep}`);
    if (!placed.ok)
      throw new Error(`the anchor code refused step ${windowStep}: ${placed.failure}`);
    return { windowStep, commitStep, replyLost };
  })();
  return stepsMemo;
}

/** A finished quick batch. */
export type QuickRun = { code: number; report: BatchReport; plan: BatchPlan; remove: () => Promise<void> };

/** A quick batch is a baseline plus every commit-step profile: give it room. */
export const QUICK_TIMEOUT_MS = 900_000;

/**
 * Runs `certify kvfcu/open_share_subaccount@1.0.0 --kind quick` with `extra` flags, and reads back
 * the printed plan and report (section 9 §9.1). Throws with the CLI's stderr when no batch printed.
 */
export async function certifyQuick(extra: string[] = []): Promise<QuickRun> {
  const r = await invoke(["certify", KEY, "--kind", "quick", ...extra]);
  try {
    const raw: unknown = JSON.parse(r.stdout);
    const parsed = z.object({ plan: BatchPlan, report: BatchReport }).parse(raw);
    return { code: r.code, ...parsed, remove: r.remove };
  } catch {
    await r.remove();
    throw new Error(`certify --kind quick printed no batch (exit ${String(r.code)}): ${r.stderr.trim()}`);
  }
}
