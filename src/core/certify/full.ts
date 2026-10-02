// A `full` certify batch: baseline repeats and a twin, the fault matrix on every request step and
// the commit step, extra cases, reconciliation drills, and stability runs with twins. Each case
// follows section 8 §7.4. Without a `stability` setting the report says `stability: null`.
// Follows design section 8 §7.1 to §7.4, §7.8, §8.3, §8.4, §9.1 to §9.5, §9.7.
import { fail, ok, type Outcome } from "../../ports/outcome.js";
import { resolveMajor } from "../catalog/capabilities.js";
import type { BatchPlan, BatchPlanCase, CaseGroup } from "../model/batch-plan.js";
import type { BatchReport, BatchReportCase, JevCall } from "../model/batch-report.js";
import type { ExtraCase, SuiteClass } from "../model/suite.js";
import type { ExplainedEnding, FaultProfile } from "../model/faults.js";
import type { BatchScores, Under } from "../model/score.js";
import { gatePasses, gateRules, type GateCase } from "./gate.js";
import { jevCallsOf } from "./jev-table.js";
import { isDrill } from "./quick.js";
import {
  BASELINE_CASE_ID,
  classify,
  collectTruth,
  resolveInputs,
  routeMapPlain,
  runFaultCase,
  runOne,
  usedHelp,
  prepareBatch,
  type BatchInput,
  type CertifyCaseInput,
  type CertifyDeps,
  type CertifyFailure,
  type FaultCaseRun,
  type Prepared,
} from "./runner.js";
import { batchScores, fragileSteps, marginSummary, stepTrace, tracesMatch, votesOf, type VoteSample } from "./score.js";
import { cleanSamples, stepDelays, timeoutsReport, type StepKind, type TimedRun } from "./timeouts.js";
import { runStabilityCase, stabilityCurve, type StabilityMeta, type StabilityRun } from "./stability.js";
import { judgeCase, matchesExpectRule } from "./verdicts.js";

/** Baseline repeats per class (section 8 §7.2: "each class × 3 repeats"). */
export const BASELINE_REPEATS = 3;

/** Void cases are re-run up to this many times (section 8 §8.3). */
export const VOID_RERUNS = 2;

/** A setup run: another capability's class, run before each case (section 8 §6.1, §7.4 step 2). */
export type SetupSpec = { app: string; capability: string; major: number; cls: SuiteClass };

/** What a full batch needs: the case input minus its single selection, plus the suite's parts. */
export type CertifyFullInput = Omit<CertifyCaseInput, "selection" | "at" | "rerun" | "operator" | "beforeRun"> & {
  /**
   * `regression` runs the baseline, matrix, and extra cases only: no drills and no stability, and no tuned
   * timeouts (section 8 §7.1, §15.1). Omitted: `full`. The caller passes the frozen set that holds the candidate pack revision.
   */
  kind?: "full" | "regression";
  /** The candidate pack revision a regression batch tests, like `app:kvfcu@5`. Recorded in the plan and report. */
  pack?: string;
  /** The sealed, approved fault profile set's profiles (section 8 §6.3). */
  profiles: readonly FaultProfile[];
  /** The suite's `matrix.profiles`: `standard` (every profile) or a list of profile IDs. */
  matrixProfiles: "standard" | readonly string[];
  /** The suite's hand-written cases (section 8 §6.1). */
  extra: readonly ExtraCase[];
  /** The suite's `drills.count` (section 8 §6.1). */
  drills: number;
  /** The suite's setup runs. */
  setup: readonly SetupSpec[];
  /** The suite's stability settings (section 8 §9.3). Omitted or `null`: no stability runs. */
  stability?: { class: string; levels: readonly number[]; seeds: number; twins: boolean } | null;
  /** The fault profile set's explained endings, for the fault-aware judge (section 8 §8.4). */
  explainedEndings?: readonly ExplainedEnding[];
  /** The test data set's business date, set at batch start (section 8 §7.4). */
  businessDate?: string;
  declaration?: { by: string; differs: readonly string[] };
  progress?: (line: string) => void;
};

/** What a full batch returns: the two files, and what the score store records. */
export type FullBatch = {
  plan: BatchPlan;
  report: BatchReport;
  scores: BatchScores;
  under: Under;
  /** Run IDs of the cases that did not `pass`, for a `degraded` line. */
  failing: string[];
};

/** One matrix cell: a profile placed on one step (section 8 §7.2). */
export type MatrixCell = { profile: FaultProfile; step: string; at: string | undefined };

/**
 * The matrix cells (section 8 §7.2): `@each_request_step` profiles on every request step of the task
 * (prelude steps, `session:*`, are not task steps), `@commit_point` profiles on the commit step, a
 * fixed `@step:<id>` profile on that step.
 */
export function matrixCells(
  profiles: readonly FaultProfile[],
  requestSteps: readonly string[],
  commitStepId: string | null,
): MatrixCell[] {
  const taskSteps = requestSteps.filter((s) => !s.startsWith("session:"));
  const out: MatrixCell[] = [];
  for (const profile of profiles) {
    // Why skip: a capability with no commit point (a read-only or session one) has no commit
    // step to fault; its matrix is the request steps alone (section 8 §7.2).
    if (profile.at === "@commit_point") {
      if (commitStepId !== null) out.push({ profile, step: commitStepId, at: undefined });
    } else if (profile.at === "@each_request_step") {
      for (const step of taskSteps) out.push({ profile, step, at: `@step:${step}` });
    } else out.push({ profile, step: profile.at.replace(/^@step:/, ""), at: undefined });
  }
  return out;
}

/** The profiles the suite's matrix names (section 8 §6.1: `standard` means all). */
function chosenProfiles(all: readonly FaultProfile[], pick: "standard" | readonly string[]): FaultProfile[] {
  return pick === "standard" ? [...all] : all.filter((p) => pick.includes(p.id));
}

/** A void case with nothing to point at: the run never started, or the case cannot be placed (section 8 §8.3). */
function voidCase(
  input: BatchInput,
  p: Prepared,
  cls: SuiteClass,
  caseId: string,
  group: CaseGroup,
  profile: string | null,
  seed: string,
  why: string,
): FaultCaseRun {
  return {
    fired: 0,
    lines: [],
    planCase: { case_id: caseId, run_id: "none", group, class: cls.id, profile, inputs: p.inputs, faults: [], seed, expect: null },
    reportCase: {
      case_id: caseId,
      run_id: "none",
      group,
      class: cls.id,
      result: { status: "failed", detail: why },
      truth: {},
      verdict: "void",
      note: `${input.batchId}: ${why}`,
    },
  };
}

/**
 * Runs a case, and re-runs it up to twice when it is void because of a harness or setup error
 * (section 8 §8.3). A case that cannot be placed (a step with no request) is void at once: a re-run
 * would meet the same gap. Still void after the re-runs, the case stays void and the gate fails.
 */
async function withVoidReruns(
  input: BatchInput,
  p: Prepared,
  cls: SuiteClass,
  caseId: string,
  group: CaseGroup,
  profile: string | null,
  seed: string,
  run: () => Promise<Outcome<FaultCaseRun, CertifyFailure>>,
): Promise<FaultCaseRun> {
  let last = "void";
  for (let attempt = 0; attempt <= VOID_RERUNS; attempt += 1) {
    const got = await run();
    if (got.ok && got.value.reportCase.verdict !== "void") return got.value;
    if (!got.ok) {
      last = got.detail === undefined ? got.failure : `${got.failure}: ${got.detail}`;
      if (got.failure !== "harness_unreachable" && got.failure !== "setup_failed") break;
    }
  }
  return voidCase(input, p, cls, caseId, group, profile, seed, last);
}

/**
 * One baseline-style run: reset, chaos, setup, run, judge as the class's own expectation (the
 * `recovers` rule, section 8 §6.3). `referenceInputs` are true when the run used the first
 * baseline's inputs, so its outputs can be compared with that baseline's.
 */
async function baselineRun(
  input: BatchInput,
  deps: CertifyDeps,
  p: Prepared,
  cls: SuiteClass,
  caseId: string,
  group: CaseGroup,
  seed: string,
  inputs: Record<string, string>,
  referenceInputs: boolean,
): Promise<Outcome<FaultCaseRun, CertifyFailure>> {
  const reset = await deps.harness.reset(deps.signal);
  if (!reset.ok) return fail("harness_unreachable", reset.detail);
  const chaos = await deps.harness.setChaos({ entropy: 0, seed }, deps.signal);
  if (!chaos.ok) return fail("harness_unreachable", chaos.detail);
  const setup = await input.beforeRun?.(deps.signal);
  if (setup !== undefined && !setup.ok) return fail("setup_failed", setup.detail);

  const runId = deps.ids.runId();
  const outcome = await runOne(runId, caseId, p.link, p.pin, { ...inputs }, input, deps, p.artifact.contract.effect, "scripted");
  const resultClass = await classify(deps.evidence, input.tenant, outcome);
  const { truth, commit } = await collectTruth(deps, input.tenant, p.artifact, cls, inputs, runId, outcome, referenceInputs ? p.baselineOutcome : null);
  const helped = await usedHelp(deps.evidence, input.tenant, runId);
  const events = await deps.evidence.events(input.tenant, runId, deps.signal);
  const faultLog = await deps.harness.faultLog(deps.signal);
  return ok(baselineResult(cls, caseId, group, runId, seed, inputs, resultClass, commit, truth, helped, events.ok ? events.value : [], faultLog.ok ? faultLog.value : []));
}

/** Builds a baseline case's two entries from its judged facts. */
function baselineResult(
  cls: SuiteClass,
  caseId: string,
  group: CaseGroup,
  runId: string,
  seed: string,
  inputs: Record<string, string>,
  resultClass: BatchReportCase["result"],
  commit: Parameters<typeof matchesExpectRule>[3],
  truth: Awaited<ReturnType<typeof collectTruth>>["truth"],
  helped: boolean,
  lines: unknown[],
  log: FaultCaseRun["log"],
): FaultCaseRun {
  const verdict = judgeCase({
    classMatches: matchesExpectRule("recovers", resultClass, cls.expect, commit),
    truth: { commit: truth.commit?.match ?? null, output: truth.output?.match ?? null, outcome: truth.outcome?.match ?? null },
    // Section 8 §8.3: "a clean run that needs a model is not model-free replay". No baseline expects help.
    unexpectedHelp: helped,
  });
  return {
    fired: 0,
    lines,
    ...(log === undefined ? {} : { log }),
    planCase: { case_id: caseId, run_id: runId, group, class: cls.id, profile: null, inputs, faults: [], seed, expect: cls.expect },
    reportCase: {
      case_id: caseId,
      run_id: runId,
      group,
      class: cls.id,
      result: resultClass,
      truth: {
        ...(truth.commit === undefined ? {} : { commit: truth.commit }),
        ...(truth.output === undefined ? {} : { output: truth.output }),
        ...(truth.outcome === undefined ? {} : { outcome: truth.outcome }),
      },
      verdict,
    },
  };
}

/** The exact versions of the session and check keys a batch used (section 8 §5.1, `under`). */
async function underFacts(input: BatchInput, deps: CertifyDeps, p: Prepared): Promise<Under> {
  const exact = async (link: string | null | undefined): Promise<string | null> => {
    const m = link === null || link === undefined ? null : /^([a-z][a-z0-9_-]*)\/([a-z][a-z0-9_]*)@(\d+)$/.exec(link);
    if (m?.[1] === undefined || m[2] === undefined || m[3] === undefined) return null;
    const got = await resolveMajor(deps.artifacts, m[1], m[2], Number(m[3]), input.appVersion);
    const version = got.ok ? got.value.identity.version : null;
    return version === null ? null : `${m[1]}/${m[2]}@${version}`;
  };
  const modelsOn = input.modelsOff !== true && deps.models?.classifier !== undefined;
  return {
    engine: deps.engineVersion,
    handler_set: input.frozenSet?.runStart.hash ?? null,
    jev: modelsOn ? (deps.jevVersion ?? "jev") : null,
    session: await exact(p.artifact.runs_on.session),
    check: await exact(p.artifact.recovery?.reconciliation?.check?.capability),
  };
}

/**
 * Runs a full batch (section 8 §7.2): the baseline, the matrix, the extra cases, and the drills,
 * one case after another. Returns the plan, the report with its gate, and the scores. Never
 * approval-grade when it is a drill: declared instance facts differ, or `--models off`.
 */
export async function runCertifyFull(
  input: CertifyFullInput,
  deps: CertifyDeps,
): Promise<Outcome<FullBatch, CertifyFailure>> {
  const kind = input.kind ?? "full";
  const regression = kind === "regression";
  const setupPlan: BatchPlanCase[] = [];
  const beforeRun: BatchInput["beforeRun"] =
    input.setup.length === 0
      ? undefined
      : async () => {
          for (const spec of input.setup) {
            const art = await resolveMajor(deps.artifacts, spec.app, spec.capability, spec.major, input.appVersion);
            if (!art.ok) return fail("setup_failed", art.detail);
            const version = art.value.identity.version ?? "";
            const runId = deps.ids.runId();
            const inputs = resolveInputs(spec.cls.inputs, input.pools, 0);
            const link = `${spec.app}/${spec.capability}@${String(spec.major)}`;
            const caseId = `setup_${String(setupPlan.length + 1)}`;
            const outcome = await runOne(runId, caseId, link, `${spec.app}/${spec.capability}@${version}`, inputs, input, deps, art.value.contract.effect, "scripted");
            setupPlan.push({ case_id: caseId, run_id: runId, purpose: "setup", class: spec.cls.id, profile: null, inputs, faults: [], seed: `${input.batchId}:${caseId}`, expect: spec.cls.expect });
            const got = await classify(deps.evidence, input.tenant, outcome);
            if (got.status !== spec.cls.expect.status) return fail("setup_failed", `${caseId} ended ${got.status}`);
          }
          return ok(undefined);
        };
  const base: BatchInput = { ...input, ...(beforeRun === undefined ? {} : { beforeRun }) };

  if (input.businessDate !== undefined) {
    const clock = await deps.harness.setClock(input.businessDate, deps.signal);
    if (!clock.ok && clock.failure !== "unsupported") return fail("harness_unreachable", clock.detail);
  }
  const prepared = await prepareBatch(base, deps);
  if (!prepared.ok) return prepared;
  const p = prepared.value;
  const matrixClass = p.cls;

  const cases: FaultCaseRun[] = [];
  // Samples for tuned timeouts come from the baseline, matrix, and stability runs (section 8 §9.6).
  const timed: TimedRun[] = [];
  const track = (c: FaultCaseRun, faultedStep?: string): void => {
    if (c.reportCase.verdict === "void") return;
    timed.push({
      samples: cleanSamples(c.lines).filter((s) => s.step !== faultedStep),
      delays: stepDelays(c.lines, c.log ?? []),
    });
  };
  const add = (c: FaultCaseRun): void => {
    cases.push(c);
    input.progress?.(`${c.reportCase.case_id}: ${c.reportCase.verdict}`);
  };

  // Baseline: the prepared run is class one, repeat one; its own truth is judged before any reset.
  const firstEvents = await deps.evidence.events(input.tenant, p.baselineRunId, deps.signal);
  const firstLines = firstEvents.ok ? firstEvents.value : [];
  const firstResult = await classify(deps.evidence, input.tenant, p.baselineOutcome);
  const first = await collectTruth(deps, input.tenant, p.artifact, matrixClass, p.inputs, p.baselineRunId, p.baselineOutcome, p.baselineOutcome);
  const firstHelped = await usedHelp(deps.evidence, input.tenant, p.baselineRunId);
  const firstCase = baselineResult(matrixClass, BASELINE_CASE_ID, "baseline", p.baselineRunId, p.baselineSeed, p.inputs, firstResult, first.commit, first.truth, firstHelped, firstLines, p.baselineLog);
  add(firstCase);
  track(firstCase);

  for (const cls of input.classes) {
    for (let n = 0; n < BASELINE_REPEATS; n += 1) {
      if (cls.id === matrixClass.id && n === 0) continue;
      const caseId = `baseline_${cls.id}_${String(n + 1)}`;
      const seed = `${input.batchId}:${caseId}`;
      const inputs = resolveInputs(cls.inputs, input.pools, n);
      const repeat = await withVoidReruns(base, p, cls, caseId, "baseline", null, seed, () => baselineRun(base, deps, p, cls, caseId, "baseline", seed, inputs, false));
      add(repeat);
      track(repeat);
    }
  }
  // The twin repeats the first valid run: same seed, same inputs (section 8 §7.2, §9.3).
  const twin = await withVoidReruns(base, p, matrixClass, "twin", "twin", null, p.baselineSeed, () =>
    baselineRun(base, deps, p, matrixClass, "twin", "twin", p.baselineSeed, p.inputs, true),
  );
  add(twin);
  track(twin);
  const twinMatch = twin.lines.length === 0 ? null : tracesMatch(stepTrace(firstLines), stepTrace(twin.lines));

  // Matrix: every single known fault, placed exactly (section 8 §7.2).
  const gaps: string[] = [];
  // Why open-window steps only: section 8 §7.2 places the request-step faults on the steps whose
  // helper window is open (idempotent), plus the commit step. A reversible step's window closes
  // once it is sent, so a fault there must escalate, and "recovers" would judge that wrongly.
  const riskOf = new Map(p.artifact.steps.map((s) => [s.id, s.risk]));
  const matrixSteps = [...p.routeMap.keys()].filter((id) => id === p.commitStepId || riskOf.get(id) === "idempotent");
  const cellsList = matrixCells(chosenProfiles(input.profiles, input.matrixProfiles), matrixSteps, p.commitStepId);
  for (const cell of cellsList) {
    const caseId = `${cell.profile.id}.${cell.step}`;
    const seed = `${input.batchId}:${caseId}`;
    const ran = await withVoidReruns(base, p, matrixClass, caseId, "matrix", cell.profile.id, seed, () =>
      runFaultCase(base, deps, p, { kind: "profile", profile: cell.profile }, cell.at, caseId, seed, { group: "matrix" }),
    );
    add(ran);
    track(ran, cell.step);
    if (ran.reportCase.verdict === "void") gaps.push(`${cell.profile.kind} on ${cell.step}: the case is void (${ran.reportCase.result.detail ?? "void"})`);
    else if (ran.fired === 0) gaps.push(`${cell.profile.kind} on ${cell.step}: the fault never fired`);
  }

  // Extra: the suite's own cases. A step missing from this version makes the case void (section 8 §6.1).
  for (const extra of input.extra) {
    const cls = input.classes.find((c) => c.id === extra.class);
    if (cls === undefined) return fail("unknown_class", extra.class);
    const caseId = extra.id;
    const seed = `${input.batchId}:${caseId}`;
    const ownInput: BatchInput = { ...base, className: cls.id };
    const ownPrepared: Prepared = { ...p, cls, inputs: resolveInputs(cls.inputs, input.pools, 0) };
    add(await withVoidReruns(ownInput, ownPrepared, cls, caseId, "extra", extra.id, seed, () =>
      runFaultCase(ownInput, deps, ownPrepared, { kind: "extra", extra }, undefined, caseId, seed, { group: "extra" }),
    ));
  }

  // Drills: the commit-step faults that need reconciliation, judged on truth only (section 8 §7.2).
  // Why none without a commit point: a drill faults the commit step (section 8 §14.2).
  const reconciling = p.commitStepId === null ? [] : input.profiles.filter((pr) => pr.expect_commit.startsWith("reconciles_"));
  const jevCalls: JevCall[] = [];
  const drillCount = regression ? 0 : input.drills;
  if (drillCount > 0 && reconciling.length === 0 && p.commitStepId !== null) gaps.push("drills: no fault profile ends in a reconciliation, so none could run");
  for (let i = 0; reconciling.length > 0 && i < drillCount; i += 1) {
    const profile = reconciling[i % reconciling.length];
    if (profile === undefined || p.commitStepId === null) break;
    const caseId = `drill_${String(i + 1)}`;
    const seed = `${input.batchId}:${caseId}`;
    const at = profile.at === "@commit_point" ? undefined : `@step:${p.commitStepId}`;
    const ran = await withVoidReruns(base, p, matrixClass, caseId, "drill", profile.id, seed, () =>
      runFaultCase(base, deps, p, { kind: "profile", profile }, at, caseId, seed, { group: "drill", truthOnly: true }),
    );
    add(ran);
    // Why: the profile's own expectation is the drill's known truth (section 8 §14.2, the drill table).
    const truth = profile.expect_commit === "reconciles_found" ? "found" : "not_found";
    if (ran.reportCase.run_id !== "none") jevCalls.push(...jevCallsOf({ case_id: caseId, run_id: ran.reportCase.run_id, truth }, ran.lines));
  }

  // Stability: random faults at each entropy level, seeds from the batch ID, each run twice (section 8 §9.3).
  const stabilityRuns: StabilityRun[] = [];
  // Why null for a regression: section 8 §7.1 lists no stability runs for it.
  const stab = regression ? null : (input.stability ?? null);
  const stabClass = stab === null ? undefined : input.classes.find((c) => c.id === stab.class);
  if (stab !== null && stabClass === undefined) return fail("unknown_class", stab.class);
  for (const entropy of stab === null ? [] : stab.levels) {
    for (let n = 1; stab !== null && stabClass !== undefined && n <= stab.seeds; n += 1) {
      const seed = `${input.batchId}:s${String(entropy)}:${String(n)}`;
      const inputs = resolveInputs(stabClass.inputs, input.pools, n - 1);
      for (const twin of stab.twins ? [false, true] : [false]) {
        const caseId = `stab_${String(entropy)}_${String(n)}${twin ? "_twin" : ""}`;
        const seen: { meta: StabilityMeta | null } = { meta: null };
        const ran = await withVoidReruns(base, p, stabClass, caseId, "stability", null, seed, async () => {
          const got = await runStabilityCase(base, deps, p, stabClass, input.explainedEndings ?? [], { entropy, seed: n, twin }, caseId, seed, inputs);
          if (!got.ok) return got;
          seen.meta = got.value.meta;
          return ok(got.value.run);
        });
        add(ran);
        track(ran);
        if (ran.reportCase.verdict === "void") gaps.push(`stability ${caseId}: the case is void (${ran.reportCase.result.detail ?? "void"})`);
        else if (seen.meta !== null) stabilityRuns.push({ meta: seen.meta, verdict: ran.reportCase.verdict });
      }
    }
  }

  // Step kinds for the floors (section 8 §9.6): the commit step, steps that sent a request, the rest are fills.
  const requestStepIds = new Set(p.routeMap.keys());
  const stepKinds: Record<string, StepKind> = Object.fromEntries(
    p.artifact.steps.map((s): [string, StepKind] => [s.id, s.id === p.commitStepId ? "commit" : requestStepIds.has(s.id) ? "request" : "fill"]),
  );

  const judged: GateCase[] = cases.map((c) => ({ group: c.reportCase.group ?? "baseline", verdict: c.reportCase.verdict }));
  const drill = isDrill(input.declaration) || input.modelsOff === true;
  const rules = gateRules({
    kind,
    drill,
    complete: deps.signal?.aborted !== true,
    cases: judged,
    twinMatch,
  });
  const samples: VoteSample[] = cases.flatMap((c) =>
    c.reportCase.verdict === "pass" || c.reportCase.verdict === "explained" ? votesOf(c.lines) : [],
  );
  const margin = marginSummary(samples);
  const fragile = fragileSteps(margin.targets);
  const scores = batchScores(judged, margin, fragile);
  const under = await underFacts(base, deps, p);
  const passed = gatePasses(rules);
  const planCases = [...setupPlan, ...cases.map((c) => c.planCase)];
  const startedAt = deps.clock.now().toISOString();

  const plan: BatchPlan = {
    schema: "intyy.batch_plan/1.0",
    batch_id: input.batchId,
    tenant: input.tenant,
    app: input.app,
    capability: p.link,
    kind,
    pin: p.pin,
    started_by: input.staff,
    operator: "scripted",
    started_at: startedAt,
    instance: input.instance,
    route_map: routeMapPlain(p.routeMap),
    cases: planCases,
    ...(input.pack === undefined ? {} : { pack: input.pack }),
    ...(drill ? { drill: true as const } : {}),
    ...(input.modelsOff === true ? { models_off: true as const } : {}),
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
    kind,
    ...(input.appVersion === undefined
      ? {}
      : { key: { capability: p.pin, tenant: input.tenant, app_version: input.appVersion, patch_revision: null } }),
    under,
    cases: cases.map((c) => c.reportCase),
    gate: { passed, rules },
    outcome_score: scores.outcome_score,
    verdicts: scores.verdicts,
    margin,
    fragile,
    coverage_gaps: gaps,
    // Why: section 8 §14.2. Every jev reconcile answer in a drill is labelled by the drill's known truth.
    ...(under.jev === null || regression ? {} : { jev: { version: under.jev, calls: jevCalls } }),
    ...(regression ? {} : { timeouts: timeoutsReport(timed, stepKinds, input.timeouts ?? { values: {}, from: null }) }),
    stability: stab === null ? null : stabilityCurve(stabilityRuns),
    ...(input.pack === undefined ? {} : { pack: input.pack }),
    ...(drill ? { drill: true as const } : {}),
    ...(input.modelsOff === true ? { models_off: true as const } : {}),
  };
  // Why stability cases only when wrong or void: `explained` and `unexplained` are expected there (section 9.5).
  const failing = cases
    .filter((c) => c.reportCase.run_id !== "none")
    .filter((c) => (c.reportCase.group === "stability" ? ["wrong", "void"].includes(c.reportCase.verdict) : c.reportCase.verdict !== "pass"))
    .map((c) => c.reportCase.run_id);
  return ok({ plan, report, scores, under, failing });
}
