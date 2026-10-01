// The `recovery` block: what to do when the one irreversible step fails.
// Follows design section 2 §16.
import { z } from "zod";
import { RunId } from "../ids.js";
import { MajorCapabilityLink, SnakeId } from "./shared.js";

/** A map from a linked capability's field names to our value references (section 2 §16.2, §16.4). */
const ValueMap = z.record(z.string(), z.string().min(1));

/**
 * How a check's result is read (owner decisions, 2026-10-01). `reference`: section 2 §16.2,
 * success means found. `count_diff`: the check reads one count before the run and again after a
 * lost reply; one more means found, the same means absent, anything else is unclear.
 */
export const CheckMode = z.enum(["reference", "count_diff"]);

/**
 * `recovery.reconciliation.check` (section 2 §16.2): a read-only capability that tells whether
 * the commit worked. `mode` defaults to `reference`, so older files load unchanged.
 * `count_output` names the check's integer output; a loader check requires it for `count_diff`
 * only, with no `outputs` and no `not_found_outcomes` (owner decisions, 2026-10-01).
 */
export const ReconciliationCheck = z
  .object({
    capability: MajorCapabilityLink,
    mode: CheckMode.default("reference"),
    inputs: ValueMap,
    not_found_outcomes: z.array(SnakeId),
    outputs: ValueMap,
    count_output: SnakeId.optional(),
  })
  .strict();

/**
 * `recovery.reconciliation.waiver` (section 2 §16.3): why the app offers no check screen.
 * `attempt_run` cites the discovery run that found no screen to read the result; a waiver
 * without it does not load (owner decision, 2026-10-01).
 */
export const Waiver = z.object({ reason: z.string().min(1), attempt_run: RunId }).strict();

/**
 * `recovery.reconciliation` (section 2 §16.1): a check or a waiver. `null` is a candidate
 * placeholder (owner decision, 2026-09-29; section 2 §19.9); sealing rejects it.
 */
export const Reconciliation = z
  .object({ check: ReconciliationCheck.optional(), waiver: Waiver.optional() })
  .strict()
  .nullable();

/** `recovery.compensated_by` (section 2 §16.4): a link to an undo capability. */
export const CompensatedBy = z
  .object({ capability: MajorCapabilityLink, inputs: ValueMap })
  .strict();

/**
 * `recovery` (section 2 §16): present only when `contract.effect` is `commits` (a loader check,
 * task 2). `commit_point` is `null` when the recorder found zero or two irreversible-flagged
 * steps: a blocking review issue, "No commit point" (section 6 §14.9, §14.15), not yet a fact
 * the sealed file can state.
 */
export const Recovery = z
  .object({
    commit_point: SnakeId.nullable(),
    reconciliation: Reconciliation,
    compensated_by: CompensatedBy.optional(),
  })
  .strict();

/** The artifact's `recovery` block. */
export type Recovery = z.infer<typeof Recovery>;
