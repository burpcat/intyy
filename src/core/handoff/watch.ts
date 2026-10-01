// The watcher: while a human drives, read the screen every second and settle the commit.
// Follows design section 7 §15 (watchers during a takeover) and section 3 §6.4 (`check` lines,
// role `watch`). It never acts. It checks the commit step's checkpoint and declared outcomes,
// only while the commit is in flight, and nothing else.
import type { Clock } from "../../ports/clock.js";
import type { Eyes } from "../../ports/surface.js";
import type { LogLine } from "../orchestrator/run-log.js";
import { evaluate, type EvalCtx } from "../targets/evaluate.js";
import { fromObservation } from "../targets/screen.js";

/** Section 7 §15: the watcher checks once a second. */
export const WATCH_INTERVAL_MS = 1000;

/** What the watcher found: the checkpoint passed, or a declared outcome showed. */
export type WatchVerdict = { kind: "confirmed" } | { kind: "refused"; code: string };

/** What the watcher needs. Conditions are named; `ctx` resolves them. */
export type WatchDeps = {
  eyes: Eyes;
  clock: Clock;
  ctx: EvalCtx;
  /** The commit step's ID, for the log lines. */
  step: string;
  /** The commit step's checkpoint condition. */
  checkpoint: string;
  /** The commit step's declared outcomes, each with the condition that shows it. */
  outcomes: readonly { code: string; condition: string }[];
  /** True while the commit is in flight (`uncertain`). Otherwise the watcher only waits. */
  inFlight: () => boolean;
  log: (line: LogLine) => void;
  /** Called once, at the moment a verdict is found. The watcher stops after it. */
  onVerdict: (v: WatchVerdict) => void;
};

/** Reads the screen once and answers: the checkpoint passed, a declared outcome showed, or neither
 * (`null`). A failed look is not an answer. `check` lines follow the rule in {@link watchCommit}. */
async function pollOnce(
  d: WatchDeps,
  last: Map<string, boolean>,
  signal: AbortSignal | undefined,
): Promise<WatchVerdict | null> {
  const check = (condition: string, passed: boolean): void => {
    if (last.get(condition) === passed && !passed) return;
    last.set(condition, passed);
    d.log({ event: "check", step: d.step, by: "engine", data: { condition, role: "watch", passed } });
  };
  const seen = await d.eyes.observe(signal);
  if (!seen.ok) return null;
  const screen = fromObservation(seen.value);
  const holds = (condition: string): boolean =>
    evaluate({ check: "ref", ref: condition }, screen, d.ctx) === "true";
  const shown = d.outcomes.map((o) => ({ ...o, passed: holds(o.condition) }));
  const passed = holds(d.checkpoint);
  for (const o of shown) check(o.condition, o.passed);
  check(d.checkpoint, passed);
  const won = shown.find((o) => o.passed);
  if (won !== undefined) return { kind: "refused", code: won.code };
  return passed ? { kind: "confirmed" } : null;
}

/**
 * One check now, for the handback (section 7 §16.1 step 2): "check its checkpoint and outcomes
 * now". Same rules as the watcher, with no wait. `null` means still unknown.
 */
export function checkCommitNow(d: WatchDeps, signal?: AbortSignal): Promise<WatchVerdict | null> {
  return pollOnce(d, new Map(), signal);
}

/**
 * Polls until a verdict, or until `signal` aborts. Why a declared outcome wins when both show:
 * the outcome race does the same (section 7 §5.3). A `check` line is written when a condition's
 * answer first appears or changes, and on every pass, not on every poll.
 */
export async function watchCommit(d: WatchDeps, signal: AbortSignal): Promise<void> {
  const last = new Map<string, boolean>();
  for (;;) {
    try {
      await d.clock.after(WATCH_INTERVAL_MS, signal);
    } catch {
      return; // the takeover ended
    }
    if (signal.aborted) return;
    if (!d.inFlight()) continue;
    // Why skip a failed look: it is not an answer. The next second looks again.
    const verdict = await pollOnce(d, last, signal);
    if (verdict !== null) {
      d.onVerdict(verdict);
      return;
    }
  }
}
