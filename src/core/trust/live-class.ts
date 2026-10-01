// The live classifier: one finished run (its result and its run log) becomes the live lines it
// writes, one for the task or check key and one for the session key. Pure: no files, no clock.
// Follows design section 8 §5.5 (live lines), §12.1 (which runs count), and §12.2 (codes by class).
import type { LiveClass, LiveLine, LiveUnder } from "../model/live-line.js";
import type { Result } from "../model/result.js";

/** Recipe codes: the recipe is wrong or out of date. They count against the key (section 8 §12.2). */
const RECIPE_CODES: ReadonlySet<string> = new Set([
  "precondition_failed",
  "target_not_found",
  "target_ambiguous",
  "action_blocked",
  "action_failed",
  "checkpoint_timeout",
  "output_parse_failed",
  "run_timeout",
  "undeclared_outcome",
  "outputs_unavailable",
]);

/** App codes: the bank app, not the recipe, broke. They are tracked as app health (section 8 §12.2). */
const APP_CODES: ReadonlySet<string> = new Set(["app_unreachable", "session_lost", "app_error", "permission_denied"]);

/** The class a failure code falls in. Every other code (intyy's own, human, or unknown) is `not_counted`. */
export function classOfCode(code: string): LiveClass {
  if (RECIPE_CODES.has(code)) return "recipe_failure";
  if (APP_CODES.has(code)) return "app_failure";
  return "not_counted";
}

/** Facts read from one run's log lines, split by task and prelude (`session:` steps). */
type Scope = {
  /** The lowest margin per target. */
  margins: Record<string, number>;
  /** The differing clues per target. */
  differing: Record<string, string[]>;
  /** A rung 3 action happened (the reviewer acted). */
  rung3: boolean;
  /** Clean step time in ms: a step's first pass with no ladder line for it. */
  stepMs: Record<string, number>;
  /** Any log line carried this scope's steps. */
  seen: boolean;
  /** Early-warning flags: warnings the drift reader counts (section 8 §12.4). */
  flags: Set<string>;
};

/** What the run log tells the classifier. */
export type EventFacts = {
  task: Scope;
  prelude: Scope;
  /** The step the run ended at, from `run_end`, with the `session:` prefix kept. */
  endStep: string | null;
  /** `run_start.mode`, when the log has it. */
  mode: "supervised" | "unattended" | null;
  /** `run_start.purpose`, such as `commit_retry`. */
  purpose: string | null;
};

const PRELUDE = "session:";

function emptyScope(): Scope {
  return { margins: {}, differing: {}, rung3: false, stepMs: {}, seen: false, flags: new Set() };
}

/** A plain object, or `null`. Events are masked JSON, so narrow before use. */
function obj(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/**
 * Reads the log lines the classifier needs: `target_vote` (margins, differing clues), `step_end`
 * (clean time), `ladder` and `action` (rung 3), `warning` (early-warning flags), `run_start` (mode), `run_end` (the last step).
 * A line it cannot read is skipped: a bad log line never stops a live line (section 8 §5.6).
 */
export function readEvents(events: readonly unknown[]): EventFacts {
  const facts: EventFacts = { task: emptyScope(), prelude: emptyScope(), endStep: null, mode: null, purpose: null };
  // Why a first pass: a step is clean only if no ladder line names it, wherever the ladder line sits.
  const laddered = new Set<string>();
  for (const e of events) {
    const line = obj(e);
    if (line?.event === "ladder" && typeof line.step === "string") laddered.add(line.step);
  }
  const taken = new Set<string>();
  for (const e of events) {
    const line = obj(e);
    if (line === null || typeof line.event !== "string") continue;
    const data = obj(line.data);
    const step = typeof line.step === "string" ? line.step : null;
    const scope = step?.startsWith(PRELUDE) === true ? facts.prelude : facts.task;
    if (step !== null) scope.seen = true;
    switch (line.event) {
      case "run_start":
        if (data?.mode === "supervised" || data?.mode === "unattended") facts.mode = data.mode;
        if (typeof data?.purpose === "string") facts.purpose = data.purpose;
        break;
      case "run_end":
        facts.endStep = step;
        break;
      case "target_vote":
        if (typeof data?.target === "string") {
          const m = data.margin;
          if (typeof m === "number") scope.margins[data.target] = Math.min(scope.margins[data.target] ?? m, m);
          const dis = Array.isArray(data.disagree) ? data.disagree.filter((c): c is string => typeof c === "string") : [];
          if (dis.length > 0) scope.differing[data.target] = [...new Set([...(scope.differing[data.target] ?? []), ...dis])].sort();
        }
        break;
      case "ladder":
        if (data?.rung === 3) scope.rung3 = true;
        break;
      case "action":
        if (line.by === "reviewer") scope.rung3 = true;
        break;
      case "warning":
        // Why these two codes only: they are the warnings section 8 §12.4 counts (`detector_drift`, `contradiction`).
        if (data?.code === "detector_missed" && typeof data.handler === "string") scope.flags.add(`detector_missed:${data.handler}`);
        if (data?.code === "reconciliation_contradiction") scope.flags.add("reconciliation_contradiction");
        break;
      case "step_end":
        // Why: section 8 §9.6 and docs/decisions.md (M10): a clean sample is a step's first pass, with no ladder line.
        if (step !== null && data?.result === "passed" && typeof data.observed_ms === "number" && !laddered.has(step) && !taken.has(step)) {
          taken.add(step);
          scope.stepMs[step] = Math.max(0, Math.round(data.observed_ms));
        }
        break;
      default:
        break;
    }
  }
  return facts;
}

/** Help from a model or a human that makes a finished run `assisted` rather than `clean` (section 8 §12.1). */
function wasAssisted(result: Result, facts: EventFacts): boolean {
  if (facts.task.rung3 || result.recoveries.some((r) => r.via === "reviewer")) return true;
  if (result.status === "business_outcome" && result.outcome.decided_by !== "code") return true;
  if (result.status !== "rejected" && result.effect?.check !== undefined && result.effect.check.decided_by !== "code") return true;
  // Why: approvals and start confirmations are the design working, not help. A takeover is help,
  // unless it came from a handler that says `needs_human` (section 8 §12.1, `clean`).
  return result.interventions.some(
    (i) => (i.kind === "takeover" && i.reason !== "needs_human_handler") || i.kind === "reconciliation_decision",
  );
}

/** The class, code, and step of a run for the key that owns the task (or the check). */
function classify(
  result: Result,
  facts: EventFacts,
): { cls: LiveClass; code: string | null; step: string | null; uncertain: boolean } {
  // Why: section 8 §12.1. A run that ends with the commit `uncertain` is a recipe failure: when unsure, assume the worst.
  const uncertain = result.status !== "rejected" && result.effect?.commit === "uncertain";
  switch (result.status) {
    case "failed": {
      const { code, step } = result.failure;
      return { cls: uncertain ? "recipe_failure" : classOfCode(code), code, step, uncertain };
    }
    case "success":
    case "business_outcome":
      if (uncertain) return { cls: "recipe_failure", code: "commit_uncertain", step: facts.endStep, uncertain };
      return { cls: wasAssisted(result, facts) ? "assisted" : "clean", code: null, step: null, uncertain: false };
    default:
      // Rejected, running, escalated: nothing ran to a verdict, so nothing counts.
      return { cls: "not_counted", code: null, step: null, uncertain: false };
  }
}

/** The `flags` field: the scope's warning flags, plus `commit_uncertain`; empty means the field is left out. */
function flagsOf(flags: ReadonlySet<string>, uncertain: boolean): { flags?: string[] } {
  const all = [...flags, ...(uncertain ? ["commit_uncertain"] : [])].sort();
  return all.length === 0 ? {} : { flags: all };
}

/** What one run needs to become live lines. */
export type RunForLive = {
  runId: string;
  /** When the run ended (ISO). */
  at: string;
  mode: "supervised" | "unattended";
  /** `reconciliation` for a check child: its line is `as: check`. */
  kind: "replay" | "reconciliation";
  result: Result;
  events: readonly unknown[];
  under: LiveUnder;
};

/** The lines one run writes: the task (or check) line, and the prelude line when a session ran. */
export type LiveLines = { main: LiveLine; prelude: LiveLine | null };

/**
 * Builds the live lines for one finished run (section 8 §5.5). A failure inside the prelude belongs to
 * the session key: its line carries the failure, and the task line is `not_counted`, since the task's
 * own steps never ran. A prelude that ran cleanly gives the session key a `clean` line (`assisted`
 * when the reviewer acted inside it).
 */
export function liveLinesOf(run: RunForLive): LiveLines {
  const facts = readEvents(run.events);
  const base = { run_id: run.runId, at: run.at, mode: run.mode, under: run.under };
  const whole = classify(run.result, facts);
  const preludeFailed = run.result.status === "failed" && facts.endStep?.startsWith(PRELUDE) === true;

  const main: LiveLine = {
    ...base,
    as: run.kind === "reconciliation" ? "check" : "task",
    class: preludeFailed ? "not_counted" : whole.cls,
    code: whole.code,
    step: preludeFailed ? null : whole.step,
    margins: facts.task.margins,
    differing: facts.task.differing,
    step_ms: facts.task.stepMs,
    ...flagsOf(facts.task.flags, !preludeFailed && whole.uncertain),
  };
  if (!facts.prelude.seen && !preludeFailed) return { main, prelude: null };

  const preludeClass: LiveClass = preludeFailed ? whole.cls : facts.prelude.rung3 ? "assisted" : "clean";
  const prelude: LiveLine = {
    ...base,
    as: "prelude",
    class: preludeClass,
    code: preludeFailed ? whole.code : null,
    step: preludeFailed ? (facts.endStep?.slice(PRELUDE.length) ?? null) : null,
    margins: facts.prelude.margins,
    differing: facts.prelude.differing,
    step_ms: {},
    ...flagsOf(facts.prelude.flags, false),
  };
  return { main, prelude };
}
