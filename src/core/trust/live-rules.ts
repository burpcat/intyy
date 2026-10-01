// The live score, the window rule, and the streak rule: pure functions of a key's two logs.
// Follows design section 8 §12.3 (the score and the two rules), §12.5 (excluding runs), and §15.3
// (live scores by handler set). No clock, no files: callers pass the lines.
import { COUNTED_CLASSES, type LiveLine } from "../model/live-line.js";
import type { HistoryLine } from "../model/score-history.js";
import type { LiveBlock, TrustState } from "../model/score.js";

/** The window: the last 50 counted runs (section 8 §12.3). */
export const LIVE_WINDOW = 50;
/** The window rule needs at least this many counted runs (section 8 §12.3). */
export const WINDOW_MIN_RUNS = 20;
/** Three recipe failures in a row at one step and code make the streak (section 8 §12.3). */
export const STREAK_RUNS = 3;

/** A rule that fired: which one, the runs a human would read, and a plain reason. */
export type RuleHit = { rule: "window" | "streak"; runs: string[]; reason: string };

/** The run IDs any `excluded` history line removed from the window (section 8 §12.5). */
export function excludedRuns(history: readonly HistoryLine[]): Set<string> {
  const out = new Set<string>();
  for (const line of history) {
    if (line.event === "excluded") for (const id of line.runs) out.add(id);
  }
  return out;
}

/**
 * Where the rules start looking: the time of the latest `approved` or `restored` line, or `null`.
 * Why: a restored key must not degrade again at once on the runs that degraded it (docs/decisions.md, M11).
 */
export function windowStart(history: readonly HistoryLine[]): string | null {
  let since: string | null = null;
  for (const line of history) {
    if (line.event === "approved" || line.event === "restored") since = line.at;
  }
  return since;
}

/** A line's class once exclusions apply: an excluded run is `not_counted` (section 8 §12.1). */
function effective(line: LiveLine, excluded: ReadonlySet<string>): LiveLine["class"] {
  return excluded.has(line.run_id) ? "not_counted" : line.class;
}

/** True for a line that enters the live score. */
function isCounted(cls: LiveLine["class"]): boolean {
  return COUNTED_CLASSES.includes(cls);
}

/** The trailing recipe failures that share one step and one code (the current streak), oldest first. */
function trailingStreak(counted: readonly LiveLine[]): LiveLine[] {
  const last = counted[counted.length - 1];
  if (last?.class !== "recipe_failure") return [];
  const out: LiveLine[] = [];
  for (let i = counted.length - 1; i >= 0; i--) {
    const l = counted[i];
    if (l?.class !== "recipe_failure" || l.step !== last.step || l.code !== last.code) break;
    out.unshift(l);
  }
  return out;
}

/**
 * The live block for one handler set: the last 50 counted runs among `lines`, with the app failures
 * that fall inside that span (section 8 §5.3, §12.3). `lines` are in file order.
 */
export function liveBlock(
  handlerSet: string | null,
  lines: readonly LiveLine[],
  excluded: ReadonlySet<string>,
): LiveBlock {
  const counted = lines.filter((l) => isCounted(effective(l, excluded)));
  const window = counted.slice(-LIVE_WINDOW);
  const first = window[0];
  const from = first === undefined ? 0 : lines.indexOf(first);
  const app = lines.slice(from).filter((l) => effective(l, excluded) === "app_failure").length;
  const clean = window.filter((l) => l.class === "clean").length;
  const assisted = window.filter((l) => l.class === "assisted").length;
  const failures = window.length - clean - assisted;
  const streak = trailingStreak(window).length;
  return {
    handler_set: handlerSet,
    window: LIVE_WINDOW,
    counted: window.length,
    clean,
    assisted,
    recipe_failures: failures,
    app_failures: app,
    score: window.length === 0 ? null : clean / window.length,
    streak: streak === 0 ? null : streak,
  };
}

/**
 * The `live` record field: the block for the handler set of the latest line and the one before it
 * (section 8 §15.3). `null` when the key has no live lines.
 */
export function liveField(
  lines: readonly LiveLine[],
  excluded: ReadonlySet<string>,
): { current: LiveBlock; previous: LiveBlock | null } | null {
  const last = lines[lines.length - 1];
  if (last === undefined) return null;
  const current = last.under.handler_set;
  // Why the last index: the previous set is the one whose runs ended most recently before the current set's.
  let previous: string | null | undefined;
  for (let i = lines.length - 1; i >= 0; i--) {
    const hs = lines[i]?.under.handler_set;
    if (hs !== undefined && hs !== current) {
      previous = hs;
      break;
    }
  }
  const of = (hs: string | null): LiveBlock =>
    liveBlock(hs, lines.filter((l) => l.under.handler_set === hs), excluded);
  return { current: of(current), previous: previous === undefined ? null : of(previous) };
}

/**
 * The two demotion rules (section 8 §12.3). Returns the rule that fires, or `null`. Only an `approved`
 * key can degrade. Only lines after `windowStart(history)` count; excluded runs, app failures, and
 * `not_counted` lines are skipped, and skipping never breaks a streak. The streak is checked first,
 * since it names the more precise cause.
 */
export function evaluateRules(
  state: TrustState,
  history: readonly HistoryLine[],
  live: readonly LiveLine[],
): RuleHit | null {
  if (state !== "approved") return null;
  const excluded = excludedRuns(history);
  const since = windowStart(history);
  const mine = live.filter((l) => since === null || l.at > since);
  const counted = mine.filter((l) => isCounted(effective(l, excluded)));

  const streak = trailingStreak(counted);
  if (streak.length >= STREAK_RUNS) {
    const picked = streak.slice(-STREAK_RUNS);
    const first = picked[0];
    return {
      rule: "streak",
      runs: picked.map((l) => l.run_id),
      reason: `Streak rule: ${String(STREAK_RUNS)} recipe failures in a row at step ${first?.step ?? "(none)"} with code ${first?.code ?? "(none)"}.`,
    };
  }

  const window = counted.slice(-LIVE_WINDOW);
  const clean = window.filter((l) => l.class === "clean").length;
  // Why integers: clean / counted < 0.90 as clean * 10 < counted * 9, so 18 of 20 never fails on rounding.
  if (window.length >= WINDOW_MIN_RUNS && clean * 10 < window.length * 9) {
    return {
      rule: "window",
      runs: window.filter((l) => l.class !== "clean").map((l) => l.run_id),
      reason: `Window rule: live score ${(clean / window.length).toFixed(2)} over the last ${String(window.length)} counted runs, below 0.90.`,
    };
  }
  return null;
}
