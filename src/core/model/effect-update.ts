// The manual-reconcile finding (`intyy.effect_update/1.0`): a new record, never a rewrite of
// the parent's own final result. Follows design section 9 §10.6.
import { z } from "zod";
import { StaffId } from "./common.js";
import { RunId } from "./ids.js";

/** One manual-reconcile finding, written as `effect_update.json` in the parent's own folder
 * (section 9 §10.6). "A final result never changes"; this is a new record beside it. */
export const EffectUpdate = z
  .object({
    schema: z.literal("intyy.effect_update/1.0"),
    parent_run_id: RunId,
    check_run_id: RunId.nullable(),
    finding: z.enum(["found_by_check", "absent_by_check"]),
    decided_by: z.enum(["code", "human"]),
    staff_id: StaffId.nullable(),
    at: z.iso.datetime(),
  })
  .strict();

/** One manual-reconcile finding. */
export type EffectUpdate = z.infer<typeof EffectUpdate>;
