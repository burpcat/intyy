// Small schemas shared by more than one artifact block.
// Follows design section 2 §7.1 (IDs) and §16.5 (links use a major version).
import { z } from "zod";

/**
 * A target, condition, step, input, output, or outcome ID: lower snake case (section 2 §7.1).
 * Uniqueness within its kind is a loader check (task 2), not part of the shape.
 */
export const SnakeId = z
  .string()
  .regex(/^[a-z][a-z0-9_]*$/, "lower snake case, like click_search");

/** One artifact or condition ID. */
export type SnakeId = z.infer<typeof SnakeId>;

/**
 * A link to another capability by major version only, like `kvfcu/find_account_by_reference@1`
 * (section 2 §16.5). Used by `recovery.reconciliation.check.capability` and `compensated_by.capability`.
 */
export const MajorCapabilityLink = z
  .string()
  .regex(/^[a-z][a-z0-9_-]*\/[a-z][a-z0-9_]*@[1-9]\d*$/, "a link like kvfcu/find_account_by_reference@1");
