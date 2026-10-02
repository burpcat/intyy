// The route map: fault log plus run log give each step's route key and count.
// Follows design section 8 §6.4.
import type { FaultLogEntry } from "../../ports/harness.js";
import { parseLine } from "../recorder/log-lines.js";

/** One step's route key and counter, learned from a clean baseline run (section 8 §6.4). */
export type RouteMapEntry = { route: string; nth: number };

/** Step ID to its route map entry, in the order the steps first sent a request. */
export type RouteMap = Map<string, RouteMapEntry>;

/** One dispatched action: the step it belongs to, and when (section 8 §6.4). */
export type ActionTime = { step: string; at: string };

/**
 * Every dispatched action in a run's log (section 8 §6.4): a `gate` line, `decision: "allowed"`,
 * on a real step. Order matches the log's own arrival order (`seq`); prelude actions carry their
 * own step IDs (`session:*`) and count too ("prelude requests belong to prelude steps").
 */
export function actionTimesFromRunLog(lines: readonly unknown[]): ActionTime[] {
  const out: ActionTime[] = [];
  for (const raw of lines) {
    // Why only gate lines: a replay's other lines, like a reviewer's `action`, are not the
    // recorder's discovery shapes, and only `gate` lines say what was dispatched.
    if (typeof raw !== "object" || raw === null || !("event" in raw) || raw.event !== "gate") continue;
    const parsed = parseLine(raw);
    if (parsed.kind !== "gate" || parsed.data.decision !== "allowed" || parsed.step === null) continue;
    out.push({ step: parsed.step, at: parsed.at });
  }
  return out;
}

/**
 * Builds the route map (section 8 §6.4): each fault log entry belongs to the last action at or
 * before its own time. `which: first` is the only style 1.0 supports, so only the first request
 * of each step is kept. A request before any action (never expected on a clean baseline) is
 * dropped: it cannot belong to any step.
 */
export function buildRouteMap(actions: readonly ActionTime[], faultLog: readonly FaultLogEntry[]): RouteMap {
  const map: RouteMap = new Map();
  for (const entry of faultLog) {
    let owner: string | undefined;
    for (const a of actions) {
      if (a.at <= entry.time) owner = a.step;
      else break;
    }
    if (owner === undefined || map.has(owner)) continue;
    map.set(owner, { route: `${entry.method} ${entry.path}`, nth: entry.route_count });
  }
  return map;
}

/** Every step that sent a request, in step order (section 8 §6.4): "a step with no requests,
 * like a fill step, gets no matrix cases." Used to list the request steps in a refusal. */
export function requestSteps(map: RouteMap): string[] {
  return [...map.keys()];
}
