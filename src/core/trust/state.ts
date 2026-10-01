// The trust state machine: pure moves between `draft`, `approved`, `degraded`, and `retired`.
// Follows design section 8 §4.2 (transitions) and §10.1 (roles). Nothing moves a key up without a staff ID.
import { fail, ok, type Outcome } from "../../ports/outcome.js";
import type { Role } from "../model/staff.js";
import type { TrustState } from "../model/score.js";

/** The moves a history line makes (section 8 §4.2). `approve` also covers re-approval. */
export type Move = "approve" | "restore" | "reinstate" | "degrade" | "retire";

/** The three non-staff actors (section 8 §5.4: `by`). */
export const SYSTEM_ACTORS = ["live_score", "certify", "system"] as const;

/** True when `by` is a staff ID, not one of the system actors. */
export function isStaffActor(by: string): boolean {
  return by.length > 0 && !(SYSTEM_ACTORS as readonly string[]).includes(by);
}

/** Moves that give trust. An approver makes each (section 8 §10.1). Each also needs a staff ID. */
const UPWARD: readonly Move[] = ["approve", "restore", "reinstate"];

/** Where each move may start, and where it ends (section 8 §4.2). */
const TABLE: Record<Move, { from: readonly TrustState[]; to: TrustState }> = {
  approve: { from: ["draft", "approved"], to: "approved" },
  restore: { from: ["degraded"], to: "approved" },
  reinstate: { from: ["retired"], to: "draft" },
  degrade: { from: ["approved"], to: "degraded" },
  // Why: "any -> retired" is for a human. The system's narrower rule is SYSTEM_FROM below.
  retire: { from: ["draft", "approved", "degraded"], to: "retired" },
};

/** The system actors each non-upward move accepts (section 8 §4.2, `by` column). */
const SYSTEM_MAY: Record<Move, readonly string[]> = {
  approve: [],
  restore: [],
  reinstate: [],
  degrade: ["live_score", "certify"],
  retire: ["system"],
};

/** Where a system actor may start a move, when narrower than a person (section 8 §4.2: newer key approved). */
const SYSTEM_FROM: Partial<Record<Move, readonly TrustState[]>> = {
  retire: ["approved", "degraded"],
};

/** True when the move gives trust. */
export function isUpward(move: Move): boolean {
  return UPWARD.includes(move);
}

/** The roles of which one is enough: any listed role may make the move (section 8 §10.1). */
export function rolesFor(move: Move): readonly Role[] {
  return isUpward(move) ? ["approver"] : ["operator", "approver"];
}

/**
 * The state after a move, or why it is refused. `needs_staff`: an upward move by a system actor,
 * or a system actor the move does not accept. `illegal_move`: the state does not allow the move.
 * Roles are not checked here; `decide` adds them. Rebuild uses this, since a history line does not hold roles.
 */
export function transition(
  from: TrustState,
  move: Move,
  by: string,
): Outcome<TrustState, "illegal_move" | "needs_staff"> {
  if (!isStaffActor(by) && !SYSTEM_MAY[move].includes(by)) {
    return fail("needs_staff", `${move} by ${by || "nobody"}: a staff ID is needed`);
  }
  const row = TABLE[move];
  const allowed = isStaffActor(by) ? row.from : (SYSTEM_FROM[move] ?? row.from);
  if (!allowed.includes(from)) {
    return fail("illegal_move", `${move} is not allowed from ${from}`);
  }
  return ok(row.to);
}

/**
 * A staff move as a command makes it: `by`'s roles must include one the move needs, then the move
 * must be legal. `role` outranks `illegal_move`, so a person without authority learns nothing about the state.
 */
export function decide(
  from: TrustState,
  move: Move,
  by: string,
  roles: readonly Role[],
): Outcome<TrustState, "illegal_move" | "needs_staff" | "role"> {
  const t = transition(from, move, by);
  if (!t.ok && t.failure === "needs_staff") return t;
  if (isStaffActor(by) && !rolesFor(move).some((r) => roles.includes(r))) {
    return fail("role", `${by} needs the ${rolesFor(move).join(" or ")} role to ${move}`);
  }
  return t;
}
