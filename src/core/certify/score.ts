// The scorer: verdict counts, the outcome score, locator margins, fragile steps, and step traces.
// Pure functions of run logs and verdicts. Follows design section 8 §9.1, §9.2, and section 3 §6.8.
import { canonicalJson } from "../model/canonical.js";
import type { TargetMargin, Verdict } from "../model/batch-report.js";
import type { CaseGroup } from "../model/batch-plan.js";
import type { BatchScores, VerdictCounts } from "../model/score.js";

/** Counts of each verdict (section 8 §5.3 example). */
export function verdictCounts(verdicts: readonly Verdict[]): VerdictCounts {
  const counts: VerdictCounts = { pass: 0, explained: 0, assisted: 0, unexplained: 0, wrong: 0, void: 0 };
  for (const v of verdicts) counts[v] += 1;
  return counts;
}

/** Groups that count toward the outcome score: baseline (with its twin), matrix, extra, drills (section 8 §9.1). */
const SCORED: readonly CaseGroup[] = ["baseline", "twin", "matrix", "extra", "drill"];

/**
 * Outcome score: `pass` verdicts over judged runs. `void` runs are left out; `wrong` runs count as
 * not passing (section 8 §9.1). `null` when nothing was judged.
 */
export function outcomeScore(cases: readonly { group: CaseGroup; verdict: Verdict }[]): number | null {
  const judged = cases.filter((c) => SCORED.includes(c.group) && c.verdict !== "void");
  if (judged.length === 0) return null;
  return judged.filter((c) => c.verdict === "pass").length / judged.length;
}

/** One target vote seen in a run log: the step, the target, and the vote's margin and winner score. */
export type VoteSample = { step: string; target: string; margin: number | null; score: number | null };

/** The votes in a run's log lines (`target_vote`, section 3 §6.4). Other lines are skipped. */
export function votesOf(lines: readonly unknown[]): VoteSample[] {
  const out: VoteSample[] = [];
  for (const raw of lines) {
    if (typeof raw !== "object" || raw === null || !("event" in raw) || raw.event !== "target_vote") continue;
    const line = raw as { step?: unknown; data?: { target?: unknown; margin?: unknown; score?: unknown } };
    const { target, margin, score } = line.data ?? {};
    if (typeof line.step !== "string" || typeof target !== "string") continue;
    out.push({
      step: line.step,
      target,
      margin: typeof margin === "number" ? margin : null,
      score: typeof score === "number" ? score : null,
    });
  }
  return out;
}

/** The middle value of a list (the mean of the two middle values for an even count). */
function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const low = sorted[mid - 1] ?? 0;
  const high = sorted[mid] ?? 0;
  return sorted.length % 2 === 1 ? high : (low + high) / 2;
}

/** A fragile step: lowest margin under this, or lowest winner score under {@link FRAGILE_SCORE} (section 8 §9.2). */
export const FRAGILE_MARGIN = 0.3;
/** See {@link FRAGILE_MARGIN}. */
export const FRAGILE_SCORE = 0.85;

/** The batch's locator margins (section 8 §9.2). */
export type MarginSummary = {
  lowest: number | null;
  step: string | null;
  targets: Record<string, TargetMargin>;
};

/**
 * Per target: the lowest margin, the median, and the lowest winner score. The batch margin is the
 * lowest target margin with its step. The caller passes samples from `pass` runs only.
 * A vote with no margin or score adds nothing to that column.
 */
export function marginSummary(samples: readonly VoteSample[]): MarginSummary {
  const byTarget = new Map<string, VoteSample[]>();
  for (const s of samples) byTarget.set(s.target, [...(byTarget.get(s.target) ?? []), s]);
  const targets: Record<string, TargetMargin> = {};
  for (const [target, list] of [...byTarget].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const margins = list.flatMap((s) => (s.margin === null ? [] : [s.margin]));
    const scores = list.flatMap((s) => (s.score === null ? [] : [s.score]));
    const step = list[0]?.step;
    if (step === undefined || margins.length === 0 || scores.length === 0) continue;
    targets[target] = { step, lowest: Math.min(...margins), median: median(margins), score_low: Math.min(...scores) };
  }
  let lowest: number | null = null;
  let step: string | null = null;
  for (const t of Object.values(targets)) {
    if (lowest === null || t.lowest < lowest) {
      lowest = t.lowest;
      step = t.step;
    }
  }
  return { lowest, step, targets };
}

/** The fragile steps, sorted: a target with a lowest margin under 0.30 or a lowest score under 0.85. */
export function fragileSteps(targets: Readonly<Record<string, TargetMargin>>): string[] {
  const steps = Object.values(targets)
    .filter((t) => t.lowest < FRAGILE_MARGIN || t.score_low < FRAGILE_SCORE)
    .map((t) => t.step);
  return [...new Set(steps)].sort();
}

/** What a full batch's history line and record hold (section 8 §5.3). */
export function batchScores(
  cases: readonly { group: CaseGroup; verdict: Verdict }[],
  margin: MarginSummary,
  fragile: readonly string[],
): BatchScores {
  return {
    outcome_score: outcomeScore(cases),
    verdicts: verdictCounts(cases.map((c) => c.verdict)),
    margin: { lowest: margin.lowest, step: margin.step },
    fragile: [...fragile],
  };
}

/** The data keys a step trace keeps (section 3 §6.8). Times, waits, scores, and paths are left out. */
const TRACE_KEYS = [
  "condition",
  "role",
  "passed",
  "decision",
  "rule",
  "type",
  "target",
  "winner",
  "rung",
  "verdict",
  "status",
  "code",
  "kind",
  "reason",
  "result",
] as const;

/** Lines the trace follows: the ones that show what the run decided (section 3 §6.8). */
const TRACE_EVENTS = new Set([
  "check",
  "target_vote",
  "gate",
  "action",
  "ladder",
  "escalation",
  "commit_intent",
  "step_end",
  "run_end",
]);

/**
 * The step trace of a run (section 3 §6.8): for each decision line, its event, step, and the
 * plain facts that must repeat. Same inputs, same seed, same frozen facts give the same trace.
 */
export function stepTrace(lines: readonly unknown[]): string[] {
  const out: string[] = [];
  for (const raw of lines) {
    if (typeof raw !== "object" || raw === null || !("event" in raw) || typeof raw.event !== "string") continue;
    if (!TRACE_EVENTS.has(raw.event)) continue;
    const line = raw as { event: string; step?: unknown; by?: unknown; data?: Record<string, unknown> };
    const kept: Record<string, unknown> = {};
    for (const k of TRACE_KEYS) if (line.data !== undefined && k in line.data) kept[k] = line.data[k];
    out.push(canonicalJson({ event: line.event, step: line.step ?? null, by: line.by ?? null, data: kept }));
  }
  return out;
}

/** True when two runs have identical step traces. */
export function tracesMatch(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((line, i) => line === b[i]);
}
