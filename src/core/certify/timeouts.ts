// Tuned timeouts: clean step-time samples from a full batch's runs, the scaled-delay cross-check,
// and the per-step proposal. Pure functions of run logs and fault logs; the batch report holds the
// result and approval installs it. Follows design section 8 §9.6 (tuned timeouts) and section 6
// §14.11 (the floors).
import type { FaultLogEntry } from "../../ports/harness.js";
import type { BatchTimeouts } from "../model/batch-report.js";
import { actionTimesFromRunLog } from "./route-map.js";

/** A proposal needs at least this many clean samples (section 8 §9.6). */
export const MIN_SAMPLES = 20;
/** Proposals never exceed this (section 8 §9.6: "Capped at 60 s"). */
export const TIMEOUT_CAP_MS = 60_000;
/** Proposals round up to this step (section 8 §9.6). */
export const ROUND_MS = 500;
/** A request this slow must show a step time at least as long, or the batch was scaled (section 8 §9.6). */
export const SCALE_CHECK_MS = 5_000;

/** The kinds of step, each with its own floor (section 8 §9.6, section 6 §14.11). */
export type StepKind = "fill" | "request" | "commit";

/** The floor of each kind, in milliseconds. */
export const FLOORS: Readonly<Record<StepKind, number>> = { fill: 5_000, request: 10_000, commit: 15_000 };

/** One clean observed step time. */
export type TimeSample = { step: string; ms: number };

/** One log line, as far as samples care. */
type Line = { event?: unknown; step?: unknown; data?: { result?: unknown; observed_ms?: unknown; role?: unknown; passed?: unknown; waited_ms?: unknown } };

function asLines(lines: readonly unknown[]): Line[] {
  return lines.filter((l): l is Line => typeof l === "object" && l !== null);
}

/**
 * The clean samples of one run (section 8 §9.6): a step's first pass, with no `ladder` line for that
 * step, as the time from its action to its checkpoint passing. An ordinary step logs it on
 * `step_end` (`observed_ms`); the commit step logs `waited_ms` on its passed checkpoint `check`.
 * Prelude steps (`session:*`) are not this key's steps and give none.
 */
export function cleanSamples(lines: readonly unknown[]): TimeSample[] {
  const all = asLines(lines);
  const laddered = new Set(all.flatMap((l) => (l.event === "ladder" && typeof l.step === "string" ? [l.step] : [])));
  const seen = new Set<string>();
  const out: TimeSample[] = [];
  for (const l of all) {
    if (typeof l.step !== "string" || l.step.startsWith("session:") || laddered.has(l.step) || seen.has(l.step)) continue;
    const d = l.data;
    const ms =
      l.event === "step_end" && d?.result === "passed"
        ? d.observed_ms
        : l.event === "check" && d?.role === "checkpoint" && d.passed === true
          ? d.waited_ms
          : undefined;
    if (typeof ms !== "number") continue;
    seen.add(l.step);
    out.push({ step: l.step, ms });
  }
  return out;
}

/**
 * The longest nominal delay of any request each step sent (section 8 §9.6, the cross-check). A
 * fault log entry belongs to the last action at or before its own time, as in the route map (§6.4).
 */
export function stepDelays(lines: readonly unknown[], faultLog: readonly FaultLogEntry[]): Map<string, number> {
  const actions = actionTimesFromRunLog(lines);
  const out = new Map<string, number>();
  for (const e of faultLog) {
    let owner: string | undefined;
    for (const a of actions) {
      if (a.at <= e.time) owner = a.step;
      else break;
    }
    if (owner !== undefined) out.set(owner, Math.max(out.get(owner) ?? 0, e.delay_ms));
  }
  return out;
}

/** One run's facts for the batch-level checks. */
export type TimedRun = { samples: readonly TimeSample[]; delays: ReadonlyMap<string, number> };

/**
 * True when the batch ran with shortened delays (section 8 §9.6): some step sent a request with a
 * nominal delay of 5 s or more, yet its clean time was shorter. Fast samples would give short timeouts.
 */
export function batchWasScaled(runs: readonly TimedRun[]): boolean {
  return runs.some((r) =>
    r.samples.some((s) => {
      const delay = r.delays.get(s.step) ?? 0;
      return delay >= SCALE_CHECK_MS && s.ms < delay;
    }),
  );
}

/** The 95th percentile by nearest rank. `sorted` is ascending and not empty. */
function p95(sorted: readonly number[]): number {
  return sorted[Math.max(0, Math.ceil(0.95 * sorted.length) - 1)] ?? 0;
}

/**
 * The proposal for one step (section 8 §9.6): the largest of the floor, 1.5 x the 95th percentile,
 * and 1.2 x the longest sample; rounded up to 500 ms; capped at 60 s.
 */
export function proposeOne(kind: StepKind, ms: readonly number[]): number {
  const sorted = [...ms].sort((a, b) => a - b);
  const raw = Math.max(FLOORS[kind], 1.5 * p95(sorted), 1.2 * (sorted.at(-1) ?? 0));
  return Math.min(TIMEOUT_CAP_MS, Math.ceil(raw / ROUND_MS) * ROUND_MS);
}

/**
 * The batch's timeout facts (section 8 §9.6, §9.7). A step with fewer than 20 samples gets no
 * proposal and keeps its current value; a scaled batch proposes nothing. `kinds` names every task
 * step with its kind, so each step is either proposed or listed.
 */
export function timeoutsReport(
  runs: readonly TimedRun[],
  kinds: Readonly<Record<string, StepKind>>,
  ranWith: { values: Readonly<Record<string, number>>; from: string | null },
): BatchTimeouts {
  const base = { ran_with: { ...ranWith.values }, ran_with_from: ranWith.from };
  if (batchWasScaled(runs)) return { ...base, proposed: {}, not_proposed: {}, scaled: true };
  const proposed: Record<string, number> = {};
  const notProposed: Record<string, string> = {};
  for (const [step, kind] of Object.entries(kinds)) {
    const ms = runs.flatMap((r) => r.samples.filter((s) => s.step === step).map((s) => s.ms));
    if (ms.length >= MIN_SAMPLES) proposed[step] = proposeOne(kind, ms);
    else notProposed[step] = `${String(ms.length)} samples`;
  }
  return { ...base, proposed, not_proposed: notProposed };
}
