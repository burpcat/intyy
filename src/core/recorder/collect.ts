// Recorder step 1 (section 6 §14.2): collects every `action` line of one run, in log order,
// with its gate result, approval hint, fingerprint, and the screen locations before and after.
import type { ActionTag, ActionTool, Fingerprint } from "./log-lines.js";
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
  riskHint: "irreversible" | "reversible" | "idempotent" | null;
};

/**
 * Collects one run's kept-and-dropped actions alike, in seq order (section 6 §14.2 step 1).
 * `rawLines` are already-`JSON.parse`d lines from that run's masked `events.jsonl`, in file order.
 */
export function collectActions(runId: string, rawLines: readonly unknown[]): CollectedAction[] {
  const locationByTurn = new Map<number, string>();
  const atByTurn = new Map<number, string>();
  const riskHintByTurn = new Map<number, "irreversible" | "reversible" | "idempotent">();
  const parsedActions: {
    seq: number;
    turn: number;
    tool: ActionTool;
    target: string | null;
    value: string | null;
    format: string | null;
    result: "ok" | "failed";
    dispatched: boolean | "unknown";
    tag: ActionTag;
    reason: string;
    expected: string;
    corrects: number | null;
    fingerprint: Fingerprint | null;
    at: string;
  }[] = [];

  for (const raw of rawLines) {
    const line = parseLine(raw);
    if (line.kind === "observation") {
      const turn = turnOf(line.step);
      locationByTurn.set(turn, line.data.location);
      atByTurn.set(turn, line.at);
    } else if (line.kind === "escalation" && line.data.kind === "approval") {
      const hint = line.data.risk_hint;
      if (hint !== undefined && hint !== null) riskHintByTurn.set(turnOf(line.step), hint);
    } else if (line.kind === "action") {
      const turn = turnOf(line.step);
      parsedActions.push({
        seq: line.seq,
        turn,
        tool: line.data.type,
        target: line.data.target,
        value: line.data.value,
        format: line.data.format,
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
    const after = locationByTurn.get(a.turn + 1) ?? null;
    return {
      runId,
      seq: a.seq,
      turn: a.turn,
      tool: a.tool,
      target: a.target,
      value: a.value,
      format: a.format,
      result: a.result,
      dispatched: a.dispatched,
      tag: a.tag,
      reason: a.reason,
      expected: a.expected,
      corrects: a.corrects,
      fingerprint: a.fingerprint,
      beforeLocation: before,
      afterLocation: after,
      at: a.at,
      afterAt: atByTurn.get(a.turn + 1) ?? null,
      riskHint: riskHintByTurn.get(a.turn) ?? null,
    };
  });
}
