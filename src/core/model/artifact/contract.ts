// The `contract` block: inputs, outputs, outcomes, and effect.
// Follows design section 2 §12.
import { z } from "zod";
import { ValueType } from "../runspec.js";
import { SnakeId } from "./shared.js";

/**
 * Sensitivity labels (section 2 §12.7). `none`, unlike a run spec input, which is never `none`.
 */
export const ContractSensitivity = z.enum(["none", "pii", "financial"]);

/** One sensitivity label. */
export type ContractSensitivity = z.infer<typeof ContractSensitivity>;

/** A bound in a range: a number, or a string for `money`, `decimal`, and `date`. */
const RangeEnd = z.union([z.number(), z.string().min(1)]);

/** Optional input limits (section 2 §12.4). */
export const Constraints = z
  .object({
    length: z
      .object({ min: z.number().int().nonnegative(), max: z.number().int().positive() })
      .strict()
      .optional(),
    range: z.object({ min: RangeEnd.optional(), max: RangeEnd.optional() }).strict().optional(),
    values: z.array(z.string().min(1)).min(1).optional(),
    format: z.enum(["digits", "letters", "alphanumeric"]).optional(),
  })
  .strict();

/** One `contract.inputs` entry (section 2 §12.2). */
export const ContractInput = z
  .object({
    name: SnakeId,
    type: ValueType,
    description: z.string().min(1),
    required: z.boolean(),
    sensitivity: ContractSensitivity,
    constraints: Constraints.optional(),
  })
  .strict();

/** One declared input. */
export type ContractInput = z.infer<typeof ContractInput>;

/** One `contract.outputs` entry: returns on success only (section 2 §12.5). */
export const ContractOutput = z
  .object({
    name: SnakeId,
    type: ValueType,
    description: z.string().min(1),
    sensitivity: ContractSensitivity,
  })
  .strict();

/** One declared output. */
export type ContractOutput = z.infer<typeof ContractOutput>;

/** One `contract.outcomes` entry: a business outcome the caller must handle (section 2 §12.6). */
export const ContractOutcome = z
  .object({
    code: SnakeId,
    description: z.string().min(1),
    condition: SnakeId,
  })
  .strict();

/** One declared outcome. */
export type ContractOutcome = z.infer<typeof ContractOutcome>;

/** Whether the capability commits a change (section 2 §3.4, §12.1). */
export const Effect = z.enum(["read_only", "commits"]);

/**
 * `contract` (section 2 §12): everything the caller needs, and nothing it does not. Steps,
 * targets, and conditions stay hidden from the calling agent (§12.9).
 */
export const Contract = z
  .object({
    inputs: z.array(ContractInput),
    outputs: z.array(ContractOutput),
    outcomes: z.array(ContractOutcome),
    effect: Effect,
  })
  .strict();

/** The artifact's `contract` block. */
export type Contract = z.infer<typeof Contract>;
