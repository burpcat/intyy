// Recorder step 1 (section 6 §14.2): collects every `action` line of one run, in log order,
// with its gate result, approval hint, fingerprint, and the screen locations before and after.
// Also collects each turn's saved snapshot file and the `done` call's proof, the plumbing
// §14.5's landmark and last-checkpoint rules need (docs/decisions.md, M04).
import type { ActionTag, ActionTool, Fingerprint, RiskClass } from "./log-lines.js";
import { parseLine } from "./log-lines.js";

/** The turn number in a step tag like `t3`. Throws on a step outside that shape: a bug, since
 * every logged screen action carries one (loop.ts always sets `step` to `t<turn>`). */
function turnOf(step: string | null): number {
  const m = step === null ? null : /^t(\d+)$/.exec(step);
  if (m?.[1] === undefined) throw new Error(`not a turn step: ${String(step)}`);
  return Number(m[1]);
}

/** One `action` line, with its screen context (section 6 §14.2 step 1). */
export type CollectedAction = {
  runId: string;
  seq: number;
  turn: number;
  tool: ActionTool;
  /** The turn-local element ID (`e6`), or `null` for `press`, `navigate`, and `scroll`. */
  target: string | null;
  /** What the LLM typed, as it wrote it. Only `type` actions carry one. */
  value: string | null;
  format: string | null;
  /** The chosen option, for `select`. `undefined` on an older log with no such field. */
  option: string | null | undefined;
  /** The requested checked state, for `set_checked`. Same absent-on-old-logs rule. */
  checked: boolean | null | undefined;
  /** The pressed key, for `press`. Same absent-on-old-logs rule. */
  key: string | null | undefined;
  result: "ok" | "failed";
  dispatched: boolean | "unknown";
  /** The tag the LLM gave at action time (section 6 §12.1). */
  tag: ActionTag;
  reason: string;
  expected: string;
  /** The turn this action's `correction` undoes, or `null`. */
  corrects: number | null;
  fingerprint: Fingerprint | null;
  /** The masked location before this action ran (this turn's `observation` line). */
  beforeLocation: string;
  /** The masked location after this action ran (the next turn's `observation` line), or `null`
   * when the run ended before another observation (the last action of the run). */
  afterLocation: string | null;
  /** This action line's own timestamp. */
  at: string;
  /** The next turn's `observation` timestamp, or `null` when there is none (section 6 §14.11,
   * the observed time a timeout drafts from). */
  afterAt: string | null;
  /** The operator's approval hint (section 3 §6.4), when this action needed one. */
  riskHint: RiskClass | null;
  /** The staff ID who gave `riskHint`, or `null` when there is none. */
  riskHintBy: string | null;
  /**
   * The rules' own risk class (section 4 §7), from the `gate` line that let this action run
   * (`gate.ts`'s `#decide`, `data.risk`). `null` only for an actor the gate never classes, or an
   * older log with no matching line: a blocking issue, never a guess (section 6 §14.9).
   */
  gateRisk: RiskClass | null;
};

/**
 * Collects one run's kept-and-dropped actions alike, in seq order (section 6 §14.2 step 1).
 * `rawLines` are already-`JSON.parse`d lines from that run's masked `events.jsonl`, in file order.
 */
export function collectActions(runId: string, rawLines: readonly unknown[]): CollectedAction[] {
  const locationByTurn = new Map<number, string>();
  const atByTurn = new Map<number, string>();
  const riskHintByTurn = new Map<number, RiskClass>();
  const riskHintByByTurn = new Map<number, string>();
  const gateRiskByTurn = new Map<number, RiskClass>();
  const parsedActions: Omit<
    CollectedAction,
    "runId" | "beforeLocation" | "afterLocation" | "afterAt" | "riskHint" | "riskHintBy" | "gateRisk"
  >[] = [];

  for (const raw of rawLines) {
    const line = parseLine(raw);
    if (line.kind === "observation") {
      const turn = turnOf(line.step);
      locationByTurn.set(turn, line.data.location);
      atByTurn.set(turn, line.at);
    } else if (line.kind === "escalation" && line.data.kind === "approval") {
      const hint = line.data.risk_hint;
      if (hint !== undefined && hint !== null) {
        const turn = turnOf(line.step);
        riskHintByTurn.set(turn, hint);
        if (line.data.staff_id !== undefined) riskHintByByTurn.set(turn, line.data.staff_id);
      }
    } else if (line.kind === "gate" && line.data.decision === "allowed" && line.data.risk !== undefined) {
      // Why last wins: an action needing approval logs "needs_approval" first, then "allowed"
      // once approved, both under the same step. The final "allowed" line is the one that ran.
      gateRiskByTurn.set(turnOf(line.step), line.data.risk);
    } else if (line.kind === "action") {
      parsedActions.push({
        seq: line.seq,
        turn: turnOf(line.step),
        tool: line.data.type,
        target: line.data.target,
        value: line.data.value,
        format: line.data.format,
        option: line.data.option,
        checked: line.data.checked,
        key: line.data.key,
        result: line.data.result,
        dispatched: line.data.dispatched,
        tag: line.data.tag,
        reason: line.data.reason,
        expected: line.data.expected,
        corrects: line.data.corrects,
        fingerprint: line.data.fingerprint,
        at: line.at,
      });
    }
  }

  return parsedActions.map((a): CollectedAction => {
    const before = locationByTurn.get(a.turn);
    if (before === undefined) throw new Error(`no observation logged for turn ${String(a.turn)}`);
    return {
      ...a,
      runId,
      beforeLocation: before,
      afterLocation: locationByTurn.get(a.turn + 1) ?? null,
      afterAt: atByTurn.get(a.turn + 1) ?? null,
      riskHint: riskHintByTurn.get(a.turn) ?? null,
      riskHintBy: riskHintByByTurn.get(a.turn) ?? null,
      gateRisk: gateRiskByTurn.get(a.turn) ?? null,
    };
  });
}

/** Every `a11y/*.yaml` file one run's `observation` lines saved, by turn (section 6 §14.5,
 * "found by comparing the two snapshots"). */
export function collectA11yFiles(rawLines: readonly unknown[]): ReadonlyMap<number, string> {
  const out = new Map<number, string>();
  for (const raw of rawLines) {
    const line = parseLine(raw);
    if (line.kind !== "observation") continue;
    const file = line.data.files.find((f) => f.startsWith("a11y/"));
    if (file !== undefined) out.set(turnOf(line.step), file);
  }
  return out;
}

/** The `done` (positive run) or `report_outcome` (negative run) call's proof element IDs and
 * turn, or `null` when the run never called it (section 6 §14.5, "last checkpoint from proof";
 * section 6 §14.8, the outcome condition "like the last checkpoint"). */
export function collectProof(
  rawLines: readonly unknown[],
  tool: "done" | "report_outcome",
): { turn: number; ids: readonly string[] } | null {
  for (const raw of rawLines) {
    if (typeof raw !== "object" || raw === null || !("event" in raw) || raw.event !== "llm_decision") {
      continue;
    }
    const data = "data" in raw ? raw.data : undefined;
    if (typeof data !== "object" || data === null || !("action" in data)) continue;
    const action = data.action;
    if (
      typeof action === "object" &&
      action !== null &&
      "type" in action &&
      action.type === tool &&
      "input" in action
    ) {
      const input = action.input;
      const proof =
        typeof input === "object" && input !== null && "proof" in input ? input.proof : undefined;
      if (
        Array.isArray(proof) &&
        proof.every((id): id is string => typeof id === "string") &&
        "step" in raw &&
        typeof raw.step === "string"
      ) {
        return { turn: turnOf(raw.step), ids: proof };
      }
    }
  }
  return null;
}
