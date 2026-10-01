// Reconciliation autonomy, as pure rules: the ready rule, folding history lines into the record,
// the per-batch evidence from drill labels, the live spot-check pick, and the plain-text summary.
// Follows design section 8 §14.2 (scope, evidence, record, revocation) and section 5 §10.6.
import { fail, ok, type Outcome } from "../../ports/outcome.js";
import type { JevCall, BatchReport } from "../model/batch-report.js";
import { hashJson } from "../model/canonical.js";
import type { HistoryLine } from "../model/score-history.js";
import type { Autonomy, AutonomyCounts, AutonomyScope } from "../model/score.js";
import { isStaffActor } from "./state.js";

/** One autonomy history line. */
export type AutonomyLine = Extract<HistoryLine, { event: "autonomy" }>;

/** What `ready` needs (section 8 §14.2): 20 correct, at least 5 of each kind, zero wrong. */
export const READY_RULE = { correct: 20, found: 5, not_found: 5 } as const;

/** One run in this many runs the live spot check (section 5 §10.6: "about 1 in 20"). */
export const SPOT_CHECK_ONE_IN = 20;

/** Evidence of nothing. */
export function zeroCounts(): AutonomyCounts {
  return { correct: 0, found: 0, not_found: 0, wrong: 0, unclear: 0 };
}

/** True when the evidence meets the ready rule. Why both kinds: a jev that always says `found` would earn 20 alone (§14.2). */
export function isReady(c: AutonomyCounts): boolean {
  return c.correct >= READY_RULE.correct && c.found >= READY_RULE.found && c.not_found >= READY_RULE.not_found && c.wrong === 0;
}

/** What labelled jev calls add to the evidence. `unclear` only counts as `unclear`; it is never right or wrong (§14.2). */
export function countCalls(calls: readonly Pick<JevCall, "answer" | "label">[]): AutonomyCounts {
  const c = zeroCounts();
  for (const call of calls) {
    if (call.answer === "unclear") c.unclear += 1;
    else if (call.label === "wrong") c.wrong += 1;
    else if (call.label === "right") {
      c.correct += 1;
      c[call.answer] += 1;
    }
  }
  return c;
}

/**
 * Labels one jev reconcile answer against the drill's known truth (§14.2: "correct when the oracle
 * agrees"). `unclear` is `below_threshold`: no usable answer, never right or wrong.
 */
export function labelCall(answer: JevCall["answer"], truth: JevCall["truth"]): JevCall["label"] {
  if (answer === "unclear") return "below_threshold";
  return answer === truth ? "right" : "wrong";
}

/** True when two scopes are the same check key, check patch, and jev version. */
export function sameScope(a: AutonomyScope, b: AutonomyScope): boolean {
  return a.check === b.check && a.check_patch === b.check_patch && a.jev === b.jev;
}

/** `ready` or `earning`, from the counts. */
function stateFrom(c: AutonomyCounts): "earning" | "ready" {
  return isReady(c) ? "ready" : "earning";
}

function scopeOf(a: AutonomyScope): AutonomyScope {
  return { check: a.check, check_patch: a.check_patch, jev: a.jev };
}

/**
 * Applies one `autonomy` history line to the record (§14.2). `earned` adds a batch's counts; a new
 * scope starts over, and a granted record whose scope changed is `revoked` by that start-over.
 * `revoked` zeroes the evidence. `granted` needs `ready` and a person. `ready` is a marker only:
 * the state comes from the counts. Pure.
 */
export function foldAutonomy(
  cur: Autonomy | null,
  line: AutonomyLine,
): Outcome<Autonomy | null, "illegal_move" | "needs_staff"> {
  switch (line.action) {
    case "ready":
      return ok(cur);
    case "earned": {
      const scope = line.scope ?? { check: null, check_patch: null, jev: null };
      const add = line.counts ?? zeroCounts();
      const batches = line.evidence;
      if (cur === null || !sameScope(cur, scope)) {
        // Why: a new check key or jev version starts over, and a grant never carries across (§14.2).
        const lost = cur?.state === "granted";
        return ok({
          state: stateFrom(add),
          ...scopeOf(scope),
          evidence: { ...add, batches: [...batches] },
          granted: null,
          revoked: lost ? { by: line.by, at: line.at, reason: `scope changed: ${line.reason}` } : (cur?.revoked ?? null),
        });
      }
      const sum: AutonomyCounts = {
        correct: cur.evidence.correct + add.correct,
        found: cur.evidence.found + add.found,
        not_found: cur.evidence.not_found + add.not_found,
        wrong: cur.evidence.wrong + add.wrong,
        unclear: cur.evidence.unclear + add.unclear,
      };
      return ok({
        ...cur,
        // Why: a granted record stays granted while evidence grows; only a revocation takes it away.
        state: cur.state === "granted" ? "granted" : stateFrom(sum),
        evidence: { ...sum, batches: [...new Set([...cur.evidence.batches, ...batches])] },
      });
    }
    case "revoked": {
      const scope = line.scope ?? (cur === null ? { check: null, check_patch: null, jev: null } : scopeOf(cur));
      return ok({
        state: "revoked",
        ...scopeOf(scope),
        evidence: { ...zeroCounts(), batches: [] },
        granted: null,
        revoked: { by: line.by, at: line.at, reason: line.reason },
      });
    }
    case "granted":
      if (!isStaffActor(line.by)) return fail("needs_staff", `granting autonomy by ${line.by}: a staff ID is needed`);
      if (cur?.state !== "ready") return fail("illegal_move", `autonomy is ${cur?.state ?? "absent"}, not ready`);
      return ok({ ...cur, state: "granted", granted: { by: line.by, at: line.at, reason: line.reason }, revoked: null });
  }
}

/**
 * The state a run sees (§14.2: "a new check key or jev version starts over"). A granted record whose
 * scope is not the run's is `revoked` on read, with no write; the next batch of the new scope makes it so.
 */
export function stateFor(a: Autonomy | null, scope: AutonomyScope): Autonomy["state"] | "none" {
  if (a === null) return "none";
  return a.state === "granted" && !sameScope(a, scope) ? "revoked" : a.state;
}

/** True when autonomy is granted for exactly this scope. A run freezes this as `reconciliation_autonomy` (§14.2). */
export function grantedFor(a: Autonomy | null, scope: AutonomyScope): boolean {
  return stateFor(a, scope) === "granted";
}

/** True when this run takes the live spot check: a hash of the run ID picks 1 in 20, so the pick repeats (section 5 §10.6). */
export function spotChecked(runId: string): boolean {
  return Number.parseInt(hashJson(runId).replace("sha256:", "").slice(0, 8), 16) % SPOT_CHECK_ONE_IN === 0;
}

/**
 * The history line a full batch's drill labels make, or `null` for none. A drill batch, a quick or
 * regression batch, a batch without jev, and a batch with no check key make no evidence (§14.2:
 * "earned in certify only"; §7.1: a drill batch never changes the record). One wrong answer makes a
 * `revoked` line instead of an `earned` one: the old evidence no longer describes today.
 */
export function evidenceLine(report: BatchReport, at: string): AutonomyLine | null {
  if (report.kind !== "full" || report.drill === true || report.models_off === true) return null;
  const check = report.under?.check ?? null;
  const jev = report.under?.jev ?? null;
  if (report.jev === undefined || report.jev.calls.length === 0 || check === null || jev === null) return null;
  const counts = countCalls(report.jev.calls);
  const scope: AutonomyScope = { check, check_patch: null, jev };
  if (counts.wrong > 0) {
    return {
      event: "autonomy",
      at,
      by: "certify",
      reason: `batch ${report.batch_id}: jev answered ${String(counts.wrong)} reconciliation drill(s) wrong`,
      action: "revoked",
      evidence: [report.batch_id],
      scope,
    };
  }
  return {
    event: "autonomy",
    at,
    by: "certify",
    reason: `batch ${report.batch_id} added ${String(counts.correct)} correct reconciliation answer(s)`,
    action: "earned",
    evidence: [report.batch_id],
    scope,
    counts,
  };
}

/** One plain line for the record: the state and the evidence against the ready rule. */
export function describeAutonomy(a: Autonomy | null, scope?: AutonomyScope): string {
  if (a === null) return "none (no jev reconciliation evidence yet)";
  const e = a.evidence;
  const state = scope === undefined ? a.state : stateFor(a, scope);
  const need = `need ${String(READY_RULE.correct)} correct, ${String(READY_RULE.found)}+ found, ${String(READY_RULE.not_found)}+ not_found, 0 wrong`;
  return (
    `${state}; ${String(e.correct)} correct (${String(e.found)} found, ${String(e.not_found)} not_found), ` +
    `${String(e.wrong)} wrong, ${String(e.unclear)} unclear; check ${a.check ?? "none"}, jev ${a.jev ?? "none"}` +
    (state === "granted" ? "" : `; ${need}`)
  );
}
