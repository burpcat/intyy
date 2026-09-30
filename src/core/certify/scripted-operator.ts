// The scripted operator: certify has no human. This answers the operator port exactly as
// section 8 §7.6's table says. Follows design section 8 §7.6.
import type { Masked } from "../../ports/masked.js";
import type { Handle, Intervention, OperatorEvent, OperatorPort } from "../../ports/operator.js";
import { fail, ok, type Outcome } from "../../ports/outcome.js";

/** The staff ID every scripted answer is logged with (section 8 §7.6): "no one mistakes it for
 * a person." */
export const SCRIPTED_STAFF = "certify";

/**
 * Answers exactly as section 8 §7.6 says, and ends promptly, never waiting out a deadline:
 * `retry` for a retry decision; `approved` for an approval (only reachable under
 * `policy.approvals.force_human`); `end_run` for a takeover — its only decision word, so "the
 * script ends the run" resolves on the very next tick, through the decided path, with
 * `staff_id: certify` on the closing log line (section 8 §7.6: "no one mistakes it for a
 * person"). A reconciliation decision has no "just end" word (`found`/`not_found` are its only
 * two, and either would chase a further check or retry instead of ending), so it answers
 * nothing: the port closes at once, and the case's own result still names the request the run
 * ended on (`runner.ts`'s `classify`, reading the run's first `escalation` line).
 */
export class ScriptedOperator implements OperatorPort {
  open(req: Masked<Intervention>): Promise<Outcome<Handle, "write_failed">> {
    // Why cast: the Handle brand has no runtime form (section 9 §5.4). Stashing the request
    // itself as the handle needs no separate storage.
    return Promise.resolve(ok(req as unknown as Handle));
  }

  next(h: Handle): Promise<Outcome<OperatorEvent, "closed">> {
    const req = h as unknown as { kind?: unknown };
    if (req.kind === "retry_decision") {
      return Promise.resolve(ok({ kind: "decided", staff: SCRIPTED_STAFF, decision: "retry" }));
    }
    if (req.kind === "approval") {
      return Promise.resolve(ok({ kind: "decided", staff: SCRIPTED_STAFF, decision: "approved" }));
    }
    if (req.kind === "takeover") {
      return Promise.resolve(ok({ kind: "decided", staff: SCRIPTED_STAFF, decision: "end_run" }));
    }
    // `reconciliation_decision`, and `start_confirmation` (never reached: certify runs skip it
    // outright, docs/decisions.md M06 "Child runs ask no start confirmation").
    return Promise.resolve(fail("closed"));
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}
