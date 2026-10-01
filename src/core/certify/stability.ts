// Stability runs, twins, and the fault-aware judge. A stability run uses random faults (entropy),
// so no single result is "right" in advance: the judge reads the fault log, then decides. Twins
// repeat a run with the same seed and inputs; their step traces must match.
// Follows design section 8 §7.2 (stability row), §8.4 (the judge), §9.3 (the curve and twins).
import type { FaultLogEntry } from "../../ports/harness.js";
import { fail, ok, type Outcome } from "../../ports/outcome.js";
import type { BatchReportCase, ResultClass, StabilityLevel, Verdict } from "../model/batch-report.js";
import type { ExplainedEnding } from "../model/faults.js";
import type { CommitState } from "../model/result.js";
import type { SuiteClass } from "../model/suite.js";
import {
  classify,
  collectTruth,
  runOne,
  usedHelp,
  writeFaultsFile,
  type BatchInput,
  type CertifyDeps,
  type CertifyFailure,
  type FaultCaseRun,
  type Prepared,
} from "./runner.js";
import { stepTrace } from "./score.js";
import { judgeCase, matchesExpectRule } from "./verdicts.js";

/** The faults a run met: how many, and which styles (CONTRACT §6.3: `decision` is not `pass`). */
export type FiredFaults = { count: number; styles: string[] };

/** Reads the fault log: every request the app faulted, by entropy or by name. */
export function firedFaults(log: readonly Pick<FaultLogEntry, "decision" | "style">[]): FiredFaults {
  const hit = log.filter((e) => e.decision !== "pass");
  return { count: hit.length, styles: [...new Set(hit.flatMap((e) => (e.style === null ? [] : [e.style])))].sort() };
}

/** True when the ending is a failure or escalation that a style that fired honestly causes (section 8 §8.4). */
export function explains(
  rules: readonly ExplainedEnding[],
  fired: FiredFaults,
  result: ResultClass,
  commit: CommitState | null,
): boolean {
  return rules.some((r) => {
    if (r.status !== result.status) return false;
    if (fired.count < (r.min_faults ?? 1)) return false;
    if (!r.styles.includes("*") && !r.styles.some((s) => fired.styles.includes(s))) return false;
    if (r.commit !== undefined && r.commit !== commit) return false;
    const detail = result.detail ?? "";
    return r.endings.some((e) => (r.status === "failed" ? detail === e : detail === e || detail.startsWith(`${e}/`)));
  });
}

/** What the fault-aware judge reads (section 8 §8.4). */
export type StabilityJudgeInput = {
  /** The run ended as the class expects. */
  classMatches: boolean;
  truth: { commit?: boolean | null; output?: boolean | null; outcome?: boolean | null };
  /** Rung 3 or a takeover helped. Random faults never ask for help (entropy picks no pop-up, CONTRACT §6). */
  helped: boolean;
  result: ResultClass;
  commit: CommitState | null;
  fired: FiredFaults;
  rules: readonly ExplainedEnding[];
};

/**
 * The verdict of one stability run (section 8 §8.4). A failed truth check is `wrong`. The class's
 * own result is `pass` (or `assisted` when help was needed). A listed ending for a style that
 * fired is `explained`. Any other truthful ending is `unexplained`.
 * Why lenient on counts: the matrix proves each single fault exactly; stability measures toughness.
 */
export function judgeStability(i: StabilityJudgeInput): Verdict {
  if (i.classMatches) return judgeCase({ classMatches: true, truth: i.truth, unexpectedHelp: i.helped });
  if (judgeCase({ classMatches: false, truth: i.truth }) === "wrong") return "wrong";
  return explains(i.rules, i.fired, i.result, i.commit) ? "explained" : "unexplained";
}

/** What the curve needs from one stability run. */
export type StabilityMeta = {
  entropy: number;
  /** 1-based seed number at this level. */
  seed: number;
  twin: boolean;
  faults: number;
  /** Recoveries at ladder rungs 1, 2, 3. */
  rungs: [number, number, number];
  /** Escalation reasons, one per escalation line. */
  escalations: string[];
  /** The run's step trace (section 3 §6.8), for the twin comparison. */
  trace: string[];
};

/** One stability run with its verdict, for the curve. */
export type StabilityRun = { meta: StabilityMeta; verdict: Verdict };

/** Recoveries per rung and escalation reasons, read from a run's log lines (section 5 §8.12). */
export function ladderFacts(lines: readonly unknown[]): { rungs: [number, number, number]; escalations: string[] } {
  const rungs: [number, number, number] = [0, 0, 0];
  const escalations: string[] = [];
  for (const raw of lines) {
    if (typeof raw !== "object" || raw === null || !("event" in raw)) continue;
    const line = raw as { event?: unknown; data?: { rung?: unknown; next?: unknown; reason?: unknown; kind?: unknown } };
    if (line.event === "ladder" && (line.data?.next === "continue" || line.data?.next === "resume_at")) {
      const r = line.data.rung;
      if (r === 1 || r === 2 || r === 3) rungs[r - 1] = (rungs[r - 1] ?? 0) + 1;
    }
    if (line.event === "escalation") {
      const reason = line.data?.reason;
      escalations.push(
        typeof reason === "string" && reason !== "" ? reason : typeof line.data?.kind === "string" ? line.data.kind : "unknown",
      );
    }
  }
  return { rungs, escalations };
}

/** Rounds to three places, so curve numbers stay short and stable. */
const round3 = (n: number): number => Math.round(n * 1000) / 1000;

/** True when two step traces are identical. */
function sameTrace(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((line, i) => line === b[i]);
}

/**
 * The curve (section 8 §9.3): one row per entropy level, lowest first. `void` runs are left out of
 * every column. `twin_mismatch` is the share of twin pairs, both judged, whose step traces differ.
 */
export function stabilityCurve(runs: readonly StabilityRun[]): StabilityLevel[] {
  const levels = [...new Set(runs.map((r) => r.meta.entropy))].sort((a, b) => a - b);
  return levels.map((entropy) => {
    const judged = runs.filter((r) => r.meta.entropy === entropy && r.verdict !== "void");
    const n = judged.length;
    const rate = (v: Verdict): number => (n === 0 ? 0 : round3(judged.filter((r) => r.verdict === v).length / n));
    const rungs = { "1": 0, "2": 0, "3": 0 };
    const escalations: Record<string, number> = {};
    for (const r of judged) {
      rungs["1"] += r.meta.rungs[0];
      rungs["2"] += r.meta.rungs[1];
      rungs["3"] += r.meta.rungs[2];
      for (const reason of r.meta.escalations) escalations[reason] = (escalations[reason] ?? 0) + 1;
    }
    let pairs = 0;
    let mismatched = 0;
    for (const first of judged.filter((r) => !r.meta.twin)) {
      const twin = judged.find((r) => r.meta.twin && r.meta.seed === first.meta.seed);
      if (twin === undefined) continue;
      pairs += 1;
      if (!sameTrace(first.meta.trace, twin.meta.trace)) mismatched += 1;
    }
    return {
      entropy,
      runs: n,
      pass: rate("pass"),
      explained: rate("explained"),
      assisted: rate("assisted"),
      unexplained: rate("unexplained"),
      wrong: judged.filter((r) => r.verdict === "wrong").length,
      faults: n === 0 ? 0 : round3(judged.reduce((sum, r) => sum + r.meta.faults, 0) / n),
      rungs,
      escalations,
      twin_mismatch: pairs === 0 ? 0 : round3(mismatched / pairs),
    };
  });
}

/**
 * Runs one stability case (section 8 §7.4 with entropy, not named faults): reset, set entropy and
 * seed, setup, run, read and copy the fault log, ask the oracle, judge with the fault-aware judge.
 * A twin calls this again with the same seed and inputs.
 */
export async function runStabilityCase(
  input: BatchInput,
  deps: CertifyDeps,
  p: Prepared,
  cls: SuiteClass,
  rules: readonly ExplainedEnding[],
  at: { entropy: number; seed: number; twin: boolean },
  caseId: string,
  seedText: string,
  inputs: Record<string, string>,
): Promise<Outcome<{ run: FaultCaseRun; meta: StabilityMeta }, CertifyFailure>> {
  const reset = await deps.harness.reset(deps.signal);
  if (!reset.ok) return fail("harness_unreachable", reset.detail);
  const chaos = await deps.harness.setChaos({ entropy: at.entropy, seed: seedText }, deps.signal);
  if (!chaos.ok) return fail("harness_unreachable", chaos.detail);
  const setup = await input.beforeRun?.(deps.signal);
  if (setup !== undefined && !setup.ok) return fail("setup_failed", setup.detail);

  const runId = deps.ids.runId();
  const outcome = await runOne(runId, caseId, p.link, p.pin, { ...inputs }, input, deps, p.artifact.contract.effect, "scripted");

  // Read the log before the clean-up wipes it (section 8 §7.4 step 7).
  const full = await deps.harness.faultLog(deps.signal);
  const log = full.ok ? full.value : [];
  await writeFaultsFile(deps, input.tenant, runId, log);
  await deps.harness.setChaos({ entropy: 0, seed: "0" }, deps.signal);
  await deps.harness.reset(deps.signal);

  const result = await classify(deps.evidence, input.tenant, outcome);
  // Why a reference only for the baseline's own inputs: other inputs give other data (section 8 §8.2).
  const sameAsBaseline = JSON.stringify(inputs) === JSON.stringify(p.inputs);
  const { truth, commit } = await collectTruth(deps, input.tenant, p.artifact, cls, inputs, runId, outcome, sameAsBaseline ? p.baselineOutcome : null);
  const helped = await usedHelp(deps.evidence, input.tenant, runId);
  const fired = firedFaults(log);
  const verdict = judgeStability({
    classMatches: matchesExpectRule("recovers", result, cls.expect, commit),
    truth: { commit: truth.commit?.match ?? null, output: truth.output?.match ?? null, outcome: truth.outcome?.match ?? null },
    helped,
    result,
    commit,
    fired,
    rules,
  });
  const events = await deps.evidence.events(input.tenant, runId, deps.signal);
  const lines = events.ok ? events.value : [];
  const facts = ladderFacts(lines);
  const reportCase: BatchReportCase = {
    case_id: caseId,
    run_id: runId,
    group: "stability",
    class: cls.id,
    result,
    truth: {
      ...(truth.commit === undefined ? {} : { commit: truth.commit }),
      ...(truth.output === undefined ? {} : { output: truth.output }),
      ...(truth.outcome === undefined ? {} : { outcome: truth.outcome }),
    },
    verdict,
  };
  return ok({
    run: {
      fired: fired.count,
      lines,
      log,
      planCase: { case_id: caseId, run_id: runId, group: "stability", class: cls.id, profile: null, inputs, faults: [], seed: seedText, expect: cls.expect },
      reportCase,
    },
    meta: { entropy: at.entropy, seed: at.seed, twin: at.twin, faults: fired.count, rungs: facts.rungs, escalations: facts.escalations, trace: stepTrace(lines) },
  });
}
