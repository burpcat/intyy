// The certify case runner: arms a named fault through the harness, runs a clean baseline plus
// the chosen case, judges the case against the oracle, and returns the batch's plan and report.
// Only `core/certify/`, `adapters/kvfcu-harness/`, and `fakes/` may import `ports/harness.ts`.
// Follows design section 8 §7.4 to §7.8, §8.1 to §8.3; section 9 §9.1; section 3 §4.9 (the
// certify run spec is internal only); docs/decisions.md, M06 (this milestone's owner lines).
import type { Clock, Ids } from "../../ports/clock.js";
import type { FaultLogEntry, Harness, NamedFault, OracleAccount } from "../../ports/harness.js";
import type { Locks } from "../../ports/locks.js";
import { fail, ok, type Outcome } from "../../ports/outcome.js";
import { Secret } from "../../ports/secret.js";
import type { Secrets } from "../../ports/secrets.js";
import type { OperatorPort } from "../../ports/operator.js";
import type { EvidenceStore } from "../../ports/stores.js";
import type { SurfaceFactory } from "../../ports/surface.js";
import type { ArtifactStore } from "../catalog/artifacts.js";
import type { Artifact } from "../model/artifact.js";
import type { BatchPlan, BatchPlanCase, CaseGroup, ResolvedFault } from "../model/batch-plan.js";
import type { BatchReport, BatchReportCase } from "../model/batch-report.js";
import type { ContractValue } from "../model/common.js";
import type { ExpectRule, FaultPlacement, FaultProfile } from "../model/faults.js";
import type { CommitState } from "../model/result.js";
import type { Settings } from "../model/settings.js";
import type { ExtraCase, SuiteClass } from "../model/suite.js";
import type { TestInstance } from "../model/testdata.js";
import type { RequestIndexDeps } from "../orchestrator/request-index.js";
import { resolveExact, resolveMajor } from "../catalog/capabilities.js";
import type { FrozenSet } from "../packs/merge.js";
import type { MergeResult } from "../safety/policy/merge.js";
import { Redactor, redactionRules } from "../safety/redaction/redactor.js";
import { runReplay, type ReplayDeps, type ReplayInput, type ReplayOutcome } from "../replay/executor.js";
import { actionTimesFromRunLog, buildRouteMap, type RouteMap } from "./route-map.js";
import { requestStepsFor, resolveAnchor } from "./anchors.js";
import { ScriptedOperator } from "./scripted-operator.js";
import {
  commitTruth,
  notesQueryFor,
  outcomeTruth,
  outputTruthAgainstBaseline,
  outputTruthAgainstOracle,
  type TruthResult,
} from "./truth.js";
import { judgeCase, matchesExpectRule, matchesExtraExpect, matchesWaivedEnding, type ResultClass } from "./verdicts.js";

/** The certify run spec's `operator` field (updates file §11.1, section 8 §7.5). */
export type CertifyOperator = "scripted" | "mailbox";

/** One profile or suite `extra` case, already picked out by the caller (updates file §11.1). */
export type CertifySelection =
  | { kind: "profile"; profile: FaultProfile }
  | { kind: "extra"; extra: ExtraCase };

/** What `runCertifyCase` needs, resolved by the caller (the CLI owns loading and role checks). */
export type CertifyCaseInput = {
  batchId: string;
  tenant: string;
  app: string;
  capability: string;
  major: number;
  /** The exact sealed version to test, like `1.0.0` (the `pin`, section 3 §4.9). Omitted means
   * the newest sealed version of `major` that fits `appVersion`, a documented convenience. */
  version?: string;
  appVersion: string | undefined;
  staff: string;
  /** Who answers the case run's interventions (updates file §11.1, section 8 §7.6): the scripted
   * operator (the default), or the real mailbox, where a human answers with `intyy operator`.
   * The clean baseline always uses the scripted one. */
  operator?: CertifyOperator;
  className: string;
  selection: CertifySelection;
  /** The `--at` override: an explicit `@step:<id>`, used only for an `@each_request_step` profile. */
  at: string | undefined;
  classes: readonly SuiteClass[];
  pools: Readonly<Record<string, readonly string[]>>;
  instance: TestInstance;
  /** Set on `certify rerun`: the exact inputs and seed to repeat (section 9 §9.1). */
  rerun?: { batchId: string; caseId: string; inputs: Readonly<Record<string, string>>; seed: string };
  /** The merged, approved handler set for this tenant, app, and app version (section 5 §7.4).
   * A production replay of this same key would load exactly this; the caller loads it (the CLI,
   * via `loadFrozenSetFor`), so a test can inject its own set to make a handler-driven takeover
   * case testable. Omitted (like a plain `runReplay` call) means no pack files exist
   * (docs/decisions.md, M06): an empty set, not an error. */
  frozenSet?: FrozenSet;
  /** `--models off`: no rung 2, no rung 3. The batch is then a drill (section 8 §7.1). */
  modelsOff?: boolean;
  /** The key's candidate timeouts: every run of the batch uses them, so the batch tests what it may
   * ship (section 8 §9.6). Omitted: the artifact's own values. */
  timeouts?: { values: Readonly<Record<string, number>>; from: string | null };
  /**
   * Runs the suite's setup runs right after a reset, before the fault is armed (section 8 §7.4
   * step 2). The caller builds it; a failure makes the case `void` (section 8 §8.3).
   */
  beforeRun?: (signal?: AbortSignal) => Promise<Outcome<void, "setup_failed">>;
};

/** The part of the case input a whole batch shares: everything but the one case's selection. */
export type BatchInput = Omit<CertifyCaseInput, "selection" | "at">;

/** Every port this module needs. Only certify holds the harness (section 8 §6.5). */
export type CertifyDeps = {
  evidence: EvidenceStore;
  clock: Clock;
  ids: Ids;
  secrets: Secrets;
  surface: SurfaceFactory;
  artifacts: ArtifactStore;
  requestIndex: RequestIndexDeps;
  harness: Harness;
  /** The real mailbox's operator port, used only when the input says `operator: "mailbox"`. */
  mailboxOperator?: (run: { tenant: string; runId: string }) => OperatorPort;
  policy: MergeResult;
  settings: { doc: Settings; rev: string; hash: string };
  engineVersion: string;
  /**
   * The models rungs 2 and 3 may use (section 5 §8.7, §8.8). Omitted: no model is ever called, so
   * the batch tests the ladder without rungs 2 and 3. A real caller passes only what a live run
   * would have, so the batch tests the same ladder (section 8 §7.1). `input.modelsOff` wins.
   */
  models?: ReplayDeps["models"];
  /** The jev version batch `under` records when jev is on, like `jev@1.4.2` (section 8 §5.1). */
  jevVersion?: string;
  /** Run locks: each case run holds its own, as `replay` does, so another command's crash sweep
   * never takes a live case run for a crashed one (section 9 §12.2). Omitted: no lock (tests). */
  locks?: Locks;
  signal?: AbortSignal;
};

/** Why `runCertifyCase` could not finish. `detail` on `needs_at` is the request steps, joined
 * by `", "` (docs/decisions.md, M06: "the request steps are listed"). */
export type CertifyFailure =
  | "environment_not_test"
  | "no_version_for_context"
  /** `version` names a version that is not sealed, or does not fit the app version. */
  | "version_not_sealed"
  | "unknown_class"
  | "needs_at"
  | "no_commit_point"
  | "no_request"
  | "harness_unreachable"
  /** A setup run failed, so the case could not start (section 8 §7.4 step 2). */
  | "setup_failed";

/** One resolved fault, with its own placement (for a suite `extra` case's several faults). */
type Placed = { placement: FaultPlacement; resolved: { route: string; nth: number } };

export const BASELINE_CASE_ID = "baseline";
const CASE_ID = "case";

/** `app/capability@major`. */
function capabilityLink(app: string, capability: string, major: number): string {
  return `${app}/${capability}@${String(major)}`;
}

/** Picks pool values at one fixed index (docs/decisions.md, M06: "the baseline and the case
 * share one pool index"). A literal value (no leading `@`) passes through unchanged. */
export function resolveInputs(
  raw: Readonly<Record<string, ContractValue>>,
  pools: Readonly<Record<string, readonly string[]>>,
  index: number,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (typeof value === "string" && value.startsWith("@")) {
      const pool = pools[value.slice(1)];
      const picked = pool !== undefined && pool.length > 0 ? pool[index % pool.length] : undefined;
      out[name] = picked ?? value;
    } else {
      out[name] = String(value);
    }
  }
  return out;
}

/** The synthetic authorization certify grants itself (section 8 §7.5): "the staff member who
 * starts certify consents for test data." `null` for a `read_only` capability, which needs none. */
function syntheticAuthorization(
  effect: Artifact["contract"]["effect"],
  batchId: string,
  staff: string,
  link: string,
  now: Date,
): ReplayInput["request"]["authorization"] {
  if (effect !== "commits") return undefined;
  // Why `setTime`, not `new Date()`: core never makes a Date (CLAUDE.md); `now` is already one,
  // from the clock port, and `granted_at` reads its string before this mutates it forward.
  const grantedAt = now.toISOString();
  now.setTime(now.getTime() + 30 * 60_000);
  return {
    consent_ref: `certify:${batchId}`,
    granted_by: "staff",
    staff_id: staff,
    granted_at: grantedAt,
    expires_at: now.toISOString(),
    capability: link,
  };
}

/** Runs one internal replay for certify: `mode: "supervised"`, but `isChildRun: true` skips the
 * start confirmation outright (section 8 §7.5: "Certify runs behave as unattended. No start
 * confirmation."; docs/decisions.md, M06, the same flag "child runs ask no start confirmation"). */
export async function runOne(
  runId: string,
  caseId: string,
  link: string,
  pin: string,
  inputs: Record<string, string>,
  input: BatchInput,
  deps: CertifyDeps,
  effect: Artifact["contract"]["effect"],
  operator: CertifyOperator,
): Promise<ReplayOutcome> {
  const now = deps.clock.now();
  const authorization = syntheticAuthorization(effect, input.batchId, input.staff, link, now);
  const hold =
    deps.locks === undefined
      ? null
      : await deps.locks.acquire("run", runId, { owner: runId, command: "certify", staff: input.staff, waitMs: 0 });
  if (hold !== null && !hold.ok) throw new Error(`certify: run ${runId}'s lock is already held`);
  try {
    return await runOneUnlocked(runId, caseId, link, pin, inputs, input, deps, operator, authorization);
  } finally {
    if (hold?.ok === true) await deps.locks?.release(hold.value);
  }
}

/** {@link runOne}'s replay itself, with its run lock already held. */
function runOneUnlocked(
  runId: string,
  caseId: string,
  link: string,
  pin: string,
  inputs: Record<string, string>,
  input: BatchInput,
  deps: CertifyDeps,
  operator: CertifyOperator,
  authorization: ReplayInput["request"]["authorization"],
): Promise<ReplayOutcome> {
  return runReplay(
    {
      runId,
      request: {
        schema: "intyy.request/1.0",
        request_id: runId,
        capability: link,
        inputs,
        mode: "supervised",
        ...(authorization === undefined ? {} : { authorization }),
      },
      tenant: input.tenant,
      agentId: "certify",
      policy: deps.policy,
      settings: deps.settings,
      appVersion: input.appVersion,
      engineVersion: deps.engineVersion,
      outputsRevealed: true,
      // Why: a human takes over in the browser, so the mailbox case shows the window and claims
      // implicitly under the staff ID that started the batch (section 7 §12.4, updates §11.1).
      visible: operator === "mailbox",
      ...(operator === "mailbox" ? { staffId: input.staff } : {}),
      isChildRun: true,
      // Section 3 §4.9: the certify run spec's own `batch_id`/`case_id`.
      batchId: input.batchId,
      caseId,
      pin,
      ...(input.timeouts === undefined ? {} : { timeouts: input.timeouts }),
      // Section 5 §7.4: the same merged handler set a production replay of this key would load.
      ...(input.frozenSet === undefined ? {} : { frozenSet: input.frozenSet }),
    },
    {
      evidence: deps.evidence,
      clock: deps.clock,
      ids: deps.ids,
      secrets: deps.secrets,
      surface: deps.surface,
      artifacts: deps.artifacts,
      requestIndex: deps.requestIndex,
      operator:
        operator === "mailbox" && deps.mailboxOperator !== undefined
          ? deps.mailboxOperator
          : (): OperatorPort => new ScriptedOperator(),
      ...(deps.models === undefined && input.modelsOff !== true
        ? {}
        : { models: { ...(deps.models ?? {}), ...(input.modelsOff === true ? { off: true } : {}) } }),
      ...(deps.signal === undefined ? {} : { signal: deps.signal }),
    },
  );
}

/** The baseline run's own dispatched actions, paired with the harness's fault log, for the
 * route map (section 8 §6.4). The harness was reset right before the baseline ran, so the log
 * holds exactly that run's requests, in order. */
async function routeMapFor(
  evidence: EvidenceStore,
  harness: Harness,
  tenant: string,
  runId: string,
  signal?: AbortSignal,
): Promise<{ routeMap: RouteMap; log: FaultLogEntry[] }> {
  const events = await evidence.events(tenant, runId, signal);
  const lines = events.ok ? events.value : [];
  const log = await harness.faultLog(signal);
  const entries = log.ok ? log.value : [];
  return { routeMap: buildRouteMap(actionTimesFromRunLog(lines), entries), log: entries };
}

/** Writes the case run's own `faults.jsonl` (section 8 §7.4 step 7): one fault log line per
 * line, masked through a fresh redactor built from this batch's policy, like any evidence file
 * (a path or a route may hold a raw member number, and safety never trusts "it's just plumbing"). */
export async function writeFaultsFile(
  deps: CertifyDeps,
  tenant: string,
  runId: string,
  entries: readonly FaultLogEntry[],
): Promise<void> {
  const folder = await deps.evidence.openRun(tenant, runId, deps.signal);
  if (!folder.ok) return;
  const r = new Redactor(redactionRules(deps.policy.effective));
  const text = entries.map((e) => JSON.stringify(e)).join("\n") + (entries.length > 0 ? "\n" : "");
  await folder.value.writeFile("faults.jsonl", r.value(text), deps.signal);
}

/** `<kind>/<reason>/<step>` for an escalated result, else `null` (section 8 §8.1). Reads the
 * run's own escalation lines: the first opened `takeover` or `reconciliation_decision`. */
async function escalationDetail(
  evidence: EvidenceStore,
  tenant: string,
  runId: string,
): Promise<{ kind: string; reason: string; step: string | null } | null> {
  const events = await evidence.events(tenant, runId);
  if (!events.ok) return null;
  for (const raw of events.value) {
    if (typeof raw !== "object" || raw === null || !("event" in raw) || raw.event !== "escalation") continue;
    const line = raw as { data?: { kind?: unknown; reason?: unknown }; step?: unknown };
    const kind = line.data?.kind;
    if (kind !== "takeover" && kind !== "reconciliation_decision") continue;
    const reason = line.data?.reason;
    const step = typeof line.step === "string" ? line.step : null;
    return { kind, reason: typeof reason === "string" ? reason : "", step };
  }
  return null;
}

/** Section 8 §8.1: the run's result, classified. */
export async function classify(
  evidence: EvidenceStore,
  tenant: string,
  outcome: ReplayOutcome,
  firstInterventionCounts = false,
): Promise<ResultClass> {
  const r = outcome.result;
  // Why: updates §11.1, "Judging: the first intervention's kind, reason, and step are the observed
  // result." A human may hand back, so the run can end any way after the first takeover.
  if (firstInterventionCounts) {
    const esc = await escalationDetail(evidence, tenant, outcome.runId);
    if (esc !== null) return { status: "escalated", detail: `${esc.kind}/${esc.reason}/${esc.step ?? ""}` };
  }
  if (r.status === "success") return { status: "success", detail: null };
  if (r.status === "business_outcome") return { status: "business_outcome", detail: r.outcome.code };
  if (r.status === "failed") {
    if (r.failure.code === "ended_by_operator" || r.failure.code === "escalation_timeout") {
      const esc = await escalationDetail(evidence, tenant, outcome.runId);
      if (esc !== null) return { status: "escalated", detail: `${esc.kind}/${esc.reason}/${esc.step ?? ""}` };
    }
    return { status: "failed", detail: r.failure.code };
  }
  // `rejected`/`running` are never a finished certify run's own status (a bug, not expected
  // trouble: only certify's own pre-run checks, above, ever stop a case before it starts).
  return { status: "failed", detail: r.status };
}

/** One resolved fault, given the artifact's commit step and the baseline's route map. */
function placeFault(
  placement: FaultPlacement,
  routeMap: RouteMap,
  commitStepId: string | null,
  at: string | undefined,
): Outcome<Placed, CertifyFailure> {
  const resolved = resolveAnchor(placement.at, routeMap, commitStepId, at);
  if (resolved.ok) return ok({ placement, resolved: resolved.value });
  if (resolved.failure === "needs_at") return fail("needs_at", requestStepsFor(routeMap).join(", "));
  return fail(resolved.failure);
}

/** What a batch learns from its one clean baseline run, and every case after it shares
 * (section 8 §6.4, §7.4): the resolved artifact, the class, the inputs, and the route map. */
export type Prepared = {
  artifact: Artifact;
  pin: string;
  link: string;
  cls: SuiteClass;
  inputs: Record<string, string>;
  baselineRunId: string;
  baselineSeed: string;
  baselineOutcome: ReplayOutcome;
  routeMap: RouteMap;
  /** The first baseline's fault log, for the timeout cross-check (section 8 §9.6). */
  baselineLog: readonly FaultLogEntry[];
  commitStepId: string | null;
};

/** Checks the batch can start, then runs the one clean baseline and builds the route map
 * (section 8 §7.4 steps 1 to 6 for the baseline; §6.4). */
export async function prepareBatch(input: BatchInput, deps: CertifyDeps): Promise<Outcome<Prepared, CertifyFailure>> {
  const app = deps.settings.doc.apps[input.app];
  if (app === undefined || app.environment !== "test") return fail("environment_not_test");

  let artifact: Artifact;
  if (input.version !== undefined) {
    const exact = await resolveExact(deps.artifacts, input.app, input.capability, input.version, input.appVersion);
    if (!exact.ok) return fail("version_not_sealed", exact.detail);
    artifact = exact.value;
  } else {
    const newest = await resolveMajor(deps.artifacts, input.app, input.capability, input.major, input.appVersion);
    if (!newest.ok) return fail("no_version_for_context", newest.detail);
    artifact = newest.value;
  }
  // Section 3 §4.9: the resolved exact key is the run's `pin`, for the baseline, the case, and the plan.
  const pin = `${input.app}/${input.capability}@${artifact.identity.version ?? input.version ?? ""}`;

  const cls = input.classes.find((c) => c.id === input.className);
  if (cls === undefined) return fail("unknown_class");

  const link = capabilityLink(input.app, input.capability, input.major);
  const reset = await deps.harness.reset(deps.signal);
  if (!reset.ok) return fail("harness_unreachable", reset.detail);

  const baselineSeed = `${input.batchId}:${BASELINE_CASE_ID}`;
  const chaosBase = await deps.harness.setChaos({ entropy: 0, seed: baselineSeed }, deps.signal);
  if (!chaosBase.ok) return fail("harness_unreachable", chaosBase.detail);
  const preparedSetup = await input.beforeRun?.(deps.signal);
  if (preparedSetup !== undefined && !preparedSetup.ok) return fail("setup_failed", preparedSetup.detail);

  const poolIndex = 0;
  const inputs = input.rerun?.inputs ?? resolveInputs(cls.inputs, input.pools, poolIndex);
  const baselineRunId = deps.ids.runId();
  const baselineOutcome = await runOne(
    baselineRunId,
    BASELINE_CASE_ID,
    link,
    pin,
    { ...inputs },
    input,
    deps,
    artifact.contract.effect,
    "scripted",
  );

  const { routeMap, log: baselineLog } = await routeMapFor(deps.evidence, deps.harness, input.tenant, baselineRunId, deps.signal);
  const commitStepId = artifact.recovery?.commit_point ?? null;
  return ok({
    artifact,
    pin,
    link,
    cls,
    inputs,
    baselineRunId,
    baselineSeed,
    baselineOutcome,
    routeMap,
    baselineLog,
    commitStepId,
  });
}

/** One commit attempt of a case: its run ID, the commit state it reported, and whether it is the last. */
type Attempt = { runId: string; commit: CommitState | null; last: boolean };

/**
 * The commit attempts of one finished case run (section 8 §8.2, section 7 §11.3). Earlier attempts
 * come from `effect.attempts`, each with its own run ID and state. The last attempt is the case run
 * itself, or, after a retry, the retry child: a run whose `run_start` names this run as its parent
 * with `purpose: commit_retry`. Why read the log: the result holds the earlier attempts only.
 */
async function attemptsOf(
  deps: CertifyDeps,
  tenant: string,
  runId: string,
  outcome: ReplayOutcome,
  commit: CommitState | null,
): Promise<Attempt[]> {
  const earlier = outcome.result.effect?.attempts ?? [];
  const out: Attempt[] = earlier.map((a) => ({ runId: a.run_id, commit: a.commit, last: false }));
  let lastId = runId;
  if (earlier.length > 0) {
    for (const id of await deps.evidence.listRuns(tenant, deps.signal)) {
      const events = await deps.evidence.events(tenant, id, deps.signal);
      if (!events.ok) continue;
      const start = (events.value as { event?: unknown; data?: { parent_run_id?: unknown; purpose?: unknown } }[]).find((l) => l.event === "run_start");
      if (start?.data?.purpose === "commit_retry" && start.data.parent_run_id === runId) lastId = id;
    }
  }
  out.push({ runId: lastId, commit, last: true });
  return out;
}

/** The truth checks of one finished run (section 8 §8.2), and its reported commit state. Plain code;
 * only the match results leave this function, never the oracle's values. `baseline` is the batch's
 * clean first run: the reference for a `read_only` capability's outputs, when `sameInputs` says the
 * run used the baseline's inputs (other inputs give other data, so there is nothing to compare). */
export async function collectTruth(
  deps: CertifyDeps,
  tenant: string,
  artifact: Artifact,
  cls: SuiteClass,
  inputs: Readonly<Record<string, string>>,
  runId: string,
  outcome: ReplayOutcome,
  baseline: ReplayOutcome | null,
): Promise<{ truth: { commit?: TruthResult; output?: TruthResult; outcome?: TruthResult }; commit: CommitState | null }> {
  // Why on every status: `effect` sits on the shared envelope (section 3 §5.8), present on
  // every non-rejected result of a `commits` capability, whatever its final status.
  const commit: CommitState | null = outcome.result.effect?.commit ?? null;
  const truth: { commit?: TruthResult; output?: TruthResult; outcome?: TruthResult } = {};
  let oracleAccount: OracleAccount | undefined;
  if (artifact.contract.effect === "commits") {
    if (notesQueryFor(inputs, runId) !== null) {
      // Why per attempt: section 8 §8.2 and section 7 §11.4. A retry child has its own run ID, so the
      // oracle sees each attempt apart. Each earlier attempt is judged by its own reported state, the
      // last one by the final state, and all attempts together may hold one account at most.
      const attempts = await attemptsOf(deps, tenant, runId, outcome, commit);
      const counts: number[] = [];
      let judged: TruthResult = { match: true };
      let readAll = true;
      for (const a of attempts) {
        const notes = notesQueryFor(inputs, a.runId);
        const answer = notes === null ? null : await deps.harness.oracle(new Secret(notes), deps.signal);
        if (answer === null || !answer.ok) {
          readAll = false;
          break;
        }
        counts.push(answer.value.count);
        if (a.last) oracleAccount = answer.value.accounts[0];
        const one = a.commit === null ? { match: true } : commitTruth(a.commit, answer.value.count);
        if (one.match !== true && judged.match === true) judged = one;
      }
      if (readAll && commit !== null) {
        const total = counts.reduce((sum, n) => sum + n, 0);
        truth.commit = judged.match === true && total >= 2 ? { match: false, note: "the oracle found more than one account across the attempts" } : judged;
      }
    } else {
      truth.commit = { match: null, note: "commit truth unavailable: the case names no notes input" };
    }
  }
  if (outcome.result.status === "success") {
    truth.output =
      artifact.contract.effect === "commits"
        ? outputTruthAgainstOracle(outcome.result.outputs, oracleAccount)
        : baseline === null
          ? { match: null, note: "the inputs differ from the baseline's, so its outputs are no reference" }
          : baseline.result.status === "success"
            ? outputTruthAgainstBaseline(outcome.result.outputs, baseline.result.outputs)
            : { match: null, note: "the baseline did not succeed" };
  }
  if (outcome.result.status === "business_outcome") {
    truth.outcome = outcomeTruth(outcome.result.outcome.code, cls.expect);
  }
  return { truth, commit };
}

/**
 * True when rung 3 or a takeover helped the run (section 8 §8.3, `assisted`): a `ladder` line by
 * the reviewer, or a `takeover` escalation. Reads the run's own log.
 */
export async function usedHelp(evidence: EvidenceStore, tenant: string, runId: string): Promise<boolean> {
  const events = await evidence.events(tenant, runId);
  if (!events.ok) return false;
  return events.value.some((raw) => {
    if (typeof raw !== "object" || raw === null || !("event" in raw)) return false;
    const line = raw as { event?: unknown; by?: unknown; data?: { rung?: unknown; kind?: unknown } };
    if (line.event === "ladder") return line.by === "reviewer" || line.data?.rung === 3;
    return line.event === "escalation" && line.data?.kind === "takeover";
  });
}

/** One fault case, run and judged: its plan entry and its report entry. */
export type FaultCaseRun = {
  planCase: BatchPlanCase;
  reportCase: BatchReportCase;
  /** How many of this case's named faults the harness reports as fired (section 8 §9.4, coverage). */
  fired: number;
  /** The case run's own log lines, for margins and step traces. Empty when the log could not be read. */
  lines: unknown[];
  /** The case run's fault log, for the timeout cross-check (section 8 §9.6). Absent for a void case. */
  log?: readonly FaultLogEntry[];
};

/**
 * Runs one fault case after the baseline (section 8 §7.4 steps 1 to 9): place the faults through
 * the route map, reset, arm, run, copy the fault log, ask the oracle, judge. Many cases of one
 * quick batch share one `Prepared` (section 8 §6.4: "the first baseline run of a batch").
 */
export async function runFaultCase(
  input: BatchInput,
  deps: CertifyDeps,
  p: Prepared,
  selection: CertifySelection,
  at: string | undefined,
  caseId: string,
  caseSeed: string,
  opts?: { group?: CaseGroup; truthOnly?: boolean },
): Promise<Outcome<FaultCaseRun, CertifyFailure>> {
  const { artifact, cls, link, pin, inputs, routeMap, commitStepId, baselineOutcome } = p;
  const placements: readonly FaultPlacement[] =
    selection.kind === "profile" ? [{ kind: selection.profile.kind, at: selection.profile.at }] : selection.extra.faults;

  const placed: Placed[] = [];
  for (const placement of placements) {
    const got = placeFault(placement, routeMap, commitStepId, at);
    if (!got.ok) return got;
    placed.push(got.value);
  }

  const profileId = selection.kind === "profile" ? selection.profile.id : selection.extra.id;
  const resolvedFaults: ResolvedFault[] = placed.map((f) => ({
    kind: f.placement.kind,
    route: f.resolved.route,
    nth: f.resolved.nth,
    repeat: "once",
  }));
  const namedFaults: NamedFault[] = placed.map((f, i) => ({
    id: `${input.batchId}_${profileId}_${String(i)}`,
    kind: f.placement.kind,
    route: f.resolved.route,
    nth: f.resolved.nth,
    repeat: "once",
  }));

  // Section 8 §6.4: "Counts repeat after a reset. Same actions, same requests, same counters."
  // Resetting again before the case run puts route counters back to zero, so the armed fault's
  // `nth` (learned from the baseline, above) hits the same request it found there.
  const resetCase = await deps.harness.reset(deps.signal);
  if (!resetCase.ok) return fail("harness_unreachable", resetCase.detail);

  const chaosCase = await deps.harness.setChaos({ entropy: 0, seed: caseSeed }, deps.signal);
  if (!chaosCase.ok) return fail("harness_unreachable", chaosCase.detail);
  // Section 8 §7.4 step 2: setup runs come after the reset, before the fault is armed.
  const setup = await input.beforeRun?.(deps.signal);
  if (setup !== undefined && !setup.ok) return fail("setup_failed", setup.detail);
  const armed = await deps.harness.addFaults(namedFaults, deps.signal);
  if (!armed.ok) return fail("harness_unreachable", armed.detail);

  const caseRunId = deps.ids.runId();
  const caseOperator: CertifyOperator = input.operator ?? "scripted";
  const caseOutcome = await runOne(caseRunId, caseId, link, pin, { ...inputs }, input, deps, artifact.contract.effect, caseOperator);

  // Section 8 §7.4 step 7: "Read the fault log. Copy this case's entries into the run's
  // faults.jsonl." Read before the final `clearFaults`/`reset` wipe it. The reset just above
  // means the log already holds only this case's own entries, from zero.
  const fullLog = await deps.harness.faultLog(deps.signal);
  const caseLog = fullLog.ok ? fullLog.value : [];
  await writeFaultsFile(deps, input.tenant, caseRunId, caseLog);
  const armedIds = new Set(namedFaults.map((f) => f.id));
  const fired = new Set(caseLog.flatMap((e) => (e.named_id !== null && armedIds.has(e.named_id) ? [e.named_id] : []))).size;

  await deps.harness.clearFaults(deps.signal);
  await deps.harness.setChaos({ entropy: 0, seed: "0" }, deps.signal);
  await deps.harness.reset(deps.signal);

  const resultClass = await classify(deps.evidence, input.tenant, caseOutcome, caseOperator === "mailbox");
  const { truth, commit } = await collectTruth(deps, input.tenant, artifact, cls, inputs, caseRunId, caseOutcome, baselineOutcome);
  const helped = await usedHelp(deps.evidence, input.tenant, caseRunId);

  // Why: docs/decisions.md, M06. A waiver has no check, so a commit-step fault ends at a human.
  const waived =
    selection.kind === "profile" &&
    artifact.recovery?.reconciliation?.waiver !== undefined &&
    isCommitStepFault(selection.profile, at, commitStepId);

  // Why `truthOnly`: section 8 §7.2, drills are "judged on truth only: any truthful result passes".
  const classMatches =
    opts?.truthOnly === true
      ? true
      : waived
        ? matchesWaivedEnding(resultClass, commit, commitStepId)
        : selection.kind === "profile"
          ? matchesExpectRule(
              expectRuleFor(selection.profile, at, commitStepId),
              resultClass,
              cls.expect,
              commit,
              artifact.recovery?.reconciliation?.check?.mode,
            )
          : matchesExtraExpect(resultClass, selection.extra.expect);
  // Section 8 §8.3: help is expected for a profile that may escalate, `unknown_popup` (the
  // reviewer), a waived ending, and an extra case that expects an escalation (the supervisor case).
  const expectsHelp =
    opts?.truthOnly === true ||
    waived ||
    (selection.kind === "profile"
      ? selection.profile.kind === "unknown_popup" ||
        expectRuleFor(selection.profile, at, commitStepId) === "recovers_or_escalates"
      : selection.extra.expect.status === "escalated");

  const verdict = judgeCase({
    classMatches,
    truth: {
      commit: truth.commit?.match ?? null,
      output: truth.output?.match ?? null,
      outcome: truth.outcome?.match ?? null,
    },
    unexpectedHelp: helped && !expectsHelp,
  });

  const events = await deps.evidence.events(input.tenant, caseRunId, deps.signal);
  return ok({
    fired,
    lines: events.ok ? events.value : [],
    log: caseLog,
    planCase: {
      case_id: caseId,
      run_id: caseRunId,
      ...(opts?.group === undefined ? {} : { group: opts.group }),
      class: input.className,
      profile: profileId,
      inputs,
      faults: resolvedFaults,
      seed: caseSeed,
      expect: selection.kind === "extra" ? selection.extra.expect : null,
    },
    reportCase: {
      case_id: caseId,
      run_id: caseRunId,
      ...(opts?.group === undefined ? {} : { group: opts.group }),
      class: input.className,
      result: resultClass,
      truth: {
        ...(truth.commit === undefined ? {} : { commit: truth.commit }),
        ...(truth.output === undefined ? {} : { output: truth.output }),
        ...(truth.outcome === undefined ? {} : { outcome: truth.outcome }),
      },
      verdict,
      ...(waived ? { waived: true as const } : {}),
    },
  });
}

/** The route map as the plain object the plan file holds (section 8 §6.4). */
export function routeMapPlain(routeMap: RouteMap): Record<string, { route: string; nth: number }> {
  const out: Record<string, { route: string; nth: number }> = {};
  for (const [step, entry] of routeMap) out[step] = entry;
  return out;
}

/** The baseline's plan entry (section 8 §7.8). */
export function baselinePlanCase(input: BatchInput, p: Prepared): BatchPlanCase {
  return {
    case_id: BASELINE_CASE_ID,
    run_id: p.baselineRunId,
    class: input.className,
    profile: null,
    inputs: p.inputs,
    faults: [],
    seed: p.baselineSeed,
    expect: p.cls.expect,
  };
}

/** The baseline's report entry, judged as the class's own plain expectation (the `recovers`
 * rule, section 8 §6.3). Quick batches list it as a case, so a baseline that fails shows. */
export async function baselineReportCase(input: BatchInput, deps: CertifyDeps, p: Prepared): Promise<BatchReportCase> {
  const resultClass = await classify(deps.evidence, input.tenant, p.baselineOutcome);
  const commit: CommitState | null = p.baselineOutcome.result.effect?.commit ?? null;
  return {
    case_id: BASELINE_CASE_ID,
    run_id: p.baselineRunId,
    class: input.className,
    result: resultClass,
    truth: {},
    verdict: judgeCase({
      classMatches: matchesExpectRule("recovers", resultClass, p.cls.expect, commit),
      truth: {},
    }),
  };
}

/** Runs one certify case: a clean baseline, then the chosen profile or `extra` case, judged
 * against the oracle. Never approval-grade (section 8 §7.1). */
export async function runCertifyCase(
  input: CertifyCaseInput,
  deps: CertifyDeps,
): Promise<Outcome<{ plan: BatchPlan; report: BatchReport }, CertifyFailure>> {
  const prepared = await prepareBatch(input, deps);
  if (!prepared.ok) return prepared;
  const p = prepared.value;
  const caseSeed = input.rerun?.seed ?? `${input.batchId}:${CASE_ID}`;
  const ran = await runFaultCase(input, deps, p, input.selection, input.at, CASE_ID, caseSeed);
  if (!ran.ok) return ran;
  const { planCase, reportCase } = ran.value;
  const caseOperator: CertifyOperator = input.operator ?? "scripted";

  const plan: BatchPlan = {
    schema: "intyy.batch_plan/1.0",
    batch_id: input.batchId,
    tenant: input.tenant,
    app: input.app,
    capability: p.link,
    kind: "quick",
    pin: p.pin,
    started_by: input.staff,
    operator: caseOperator,
    started_at: deps.clock.now().toISOString(),
    instance: input.instance,
    route_map: routeMapPlain(p.routeMap),
    cases: [baselinePlanCase(input, p), planCase],
    ...(input.rerun === undefined ? {} : { rerun_of: { batch_id: input.rerun.batchId, case_id: input.rerun.caseId } }),
  };
  const report: BatchReport = {
    schema: "intyy.batch_report/1.0",
    batch_id: input.batchId,
    tenant: input.tenant,
    app: input.app,
    capability: p.link,
    ended_at: deps.clock.now().toISOString(),
    cases: [reportCase],
    gate: { passed: reportCase.verdict === "pass" || reportCase.verdict === "explained" },
  };
  return ok({ plan, report });
}

/** The fault-ending rule that applies to one profile placement (section 8 §6.3): `expect_commit`
 * when the fault landed on the artifact's own commit step, else `expect_window`. For
 * `@each_request_step`, `at` (the caller's `--at`) names the exact step. */
export function expectRuleFor(profile: FaultProfile, at: string | undefined, commitStepId: string | null): ExpectRule {
  return isCommitStepFault(profile, at, commitStepId) ? profile.expect_commit : profile.expect_window ?? profile.expect_commit;
}

/** Whether the profile's fault lands on the artifact's own commit step. */
export function isCommitStepFault(profile: FaultProfile, at: string | undefined, commitStepId: string | null): boolean {
  const stepId =
    profile.at === "@commit_point"
      ? commitStepId
      : profile.at === "@each_request_step"
        ? (at?.replace(/^@step:/, "") ?? null)
        : profile.at.replace(/^@step:/, "");
  return stepId !== null && stepId === commitStepId;
}
