// A `quick` certify batch: one clean baseline for the route map, then the matrix on the commit
// step only, every case using that one route map. Follows design section 8 §7.1 (batch kinds,
// drills), §6.4 (route map), §7.4, §7.8; section 9 §9.1, §9.2; docs/decisions.md, M08.
import { fail, ok, type Outcome } from "../../ports/outcome.js";
import type { BatchPlan, BatchPlanCase } from "../model/batch-plan.js";
import type { BatchReport, BatchReportCase } from "../model/batch-report.js";
import type { FaultProfile } from "../model/faults.js";
import {
  baselinePlanCase,
  baselineReportCase,
  prepareBatch,
  routeMapPlain,
  runFaultCase,
  type BatchInput,
  type CertifyCaseInput,
  type CertifyDeps,
  type CertifyFailure,
} from "./runner.js";

/** What a quick batch needs: the case input minus its single selection, plus the profile set. */
export type CertifyQuickInput = Omit<CertifyCaseInput, "selection" | "at" | "rerun" | "operator"> & {
  /** The sealed, approved fault profile set's profiles (section 8 §6.3). */
  profiles: readonly FaultProfile[];
  /** Set when `--instance` declared facts: who declared them, and which differ from the test
   * data set's `instance` (section 9 §9.2). Any difference makes the batch a drill. */
  declaration?: { by: string; differs: readonly string[] };
  /** Called after each run with one line of progress (section 9 §9.1: one line per case). */
  progress?: (line: string) => void;
};

/** One matrix case: a profile, and the `--at` that puts it on the commit step. */
export type MatrixEntry = { profile: FaultProfile; at: string | undefined };

/**
 * The profiles that land on the commit step (section 8 §7.1: "the matrix on the commit step
 * only"). `@commit_point` lands there; `@each_request_step` is placed at the commit step; a fixed
 * `@step:<id>` counts only when it names the commit step. With no commit step known (a plan-only
 * count), the fixed ones are left out.
 */
export function matrixProfiles(profiles: readonly FaultProfile[], commitStepId: string | null): MatrixEntry[] {
  const out: MatrixEntry[] = [];
  for (const profile of profiles) {
    if (profile.at === "@commit_point") out.push({ profile, at: undefined });
    else if (profile.at === "@each_request_step") {
      out.push({ profile, at: commitStepId === null ? undefined : `@step:${commitStepId}` });
    } else if (commitStepId !== null && profile.at === `@step:${commitStepId}`) out.push({ profile, at: undefined });
  }
  return out;
}

/** True when a declaration differs from the test data set's instance (section 8 §7.1). */
export function isDrill(declaration: CertifyQuickInput["declaration"]): boolean {
  return declaration !== undefined && declaration.differs.length > 0;
}

/**
 * Runs a quick batch: the baseline for `input.className`, then each matrix profile on the commit
 * step, one case after another. A profile the baseline gave no route for is not run: the report's
 * gate fails with a note naming it, and the batch still writes its plan and report (so a drill
 * whose baseline failed safely still has evidence). Never approval-grade.
 */
export async function runCertifyQuick(
  input: CertifyQuickInput,
  deps: CertifyDeps,
): Promise<Outcome<{ plan: BatchPlan; report: BatchReport }, CertifyFailure>> {
  const caseInput: BatchInput = input;
  const prepared = await prepareBatch(caseInput, deps);
  if (!prepared.ok) return prepared;
  const p = prepared.value;
  if (p.commitStepId === null) return fail("no_commit_point");

  const planCases: BatchPlanCase[] = [baselinePlanCase(caseInput, p)];
  const reportCases: BatchReportCase[] = [await baselineReportCase(caseInput, deps, p)];
  input.progress?.(`baseline: ${reportCases[0]?.verdict ?? ""}`);
  const notes: string[] = [];
  for (const { profile, at } of matrixProfiles(input.profiles, p.commitStepId)) {
    const ran = await runFaultCase(
      caseInput,
      deps,
      p,
      { kind: "profile", profile },
      at,
      profile.id,
      `${input.batchId}:${profile.id}`,
    );
    if (!ran.ok) {
      // Why: a missing route is a gap in the baseline, not a harness fault. List it and go on.
      if (ran.failure === "no_request") {
        notes.push(`${profile.id}: the baseline sent no request at the commit step, so the fault could not be placed`);
        continue;
      }
      return ran;
    }
    planCases.push(ran.value.planCase);
    reportCases.push(ran.value.reportCase);
    input.progress?.(`${profile.id}: ${ran.value.reportCase.verdict}`);
  }

  const drill = isDrill(input.declaration);
  const plan: BatchPlan = {
    schema: "intyy.batch_plan/1.0",
    batch_id: input.batchId,
    tenant: input.tenant,
    app: input.app,
    capability: p.link,
    kind: "quick",
    pin: p.pin,
    started_by: input.staff,
    operator: "scripted",
    started_at: deps.clock.now().toISOString(),
    instance: input.instance,
    route_map: routeMapPlain(p.routeMap),
    cases: planCases,
    ...(drill ? { drill: true as const } : {}),
    ...(input.declaration === undefined
      ? {}
      : { declaration: { by: input.declaration.by, differs: [...input.declaration.differs] } }),
  };
  const report: BatchReport = {
    schema: "intyy.batch_report/1.0",
    batch_id: input.batchId,
    tenant: input.tenant,
    app: input.app,
    capability: p.link,
    ended_at: deps.clock.now().toISOString(),
    cases: reportCases,
    // Why: section 8 §9.5 asks every case to pass. Thin gate (docs/decisions.md, M06).
    gate: {
      passed: notes.length === 0 && reportCases.every((c) => c.verdict === "pass" || c.verdict === "explained"),
      ...(notes.length === 0 ? {} : { notes }),
    },
    ...(drill ? { drill: true as const } : {}),
  };
  return ok({ plan, report });
}
