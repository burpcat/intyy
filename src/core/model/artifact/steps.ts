// The `steps` block: the ordered recipe.
// Follows design section 2 §15.
import { z } from "zod";
import { KeyName, PathPattern } from "../common.js";
import { SnakeId } from "./shared.js";

/** How a step may be retried (section 2 §15.1). Only `idempotent` steps are retried (§15.3). */
export const RiskKind = z.enum(["idempotent", "reversible", "irreversible"]);

/** `read.source` (section 2 §15.2): reads visible text, or a control's current value. */
const ReadSource = z.enum(["text", "value"]);

/** One step's action (section 2 §15.2). `type`, `select`, and `read` may name a display format. */
export const StepAction = z.discriminatedUnion("type", [
  z.object({ type: z.literal("navigate"), location: PathPattern }).strict(),
  z.object({ type: z.literal("click"), target: SnakeId }).strict(),
  z
    .object({
      type: z.literal("type"),
      target: SnakeId,
      value: z.string().min(1),
      format: z.string().min(1).optional(),
    })
    .strict(),
  z.object({ type: z.literal("select"), target: SnakeId, value: z.string().min(1) }).strict(),
  z.object({ type: z.literal("set_checked"), target: SnakeId, checked: z.boolean() }).strict(),
  z.object({ type: z.literal("press"), key: KeyName }).strict(),
  z
    .object({
      type: z.literal("read"),
      target: SnakeId,
      source: ReadSource,
      output: SnakeId,
      pattern: z.string().min(1).optional(),
      format: z.string().min(1).optional(),
    })
    .strict(),
]);

/** One action a step may take. */
export type StepAction = z.infer<typeof StepAction>;

/**
 * One `steps[]` entry (section 2 §15.1). Array order sets step order. `intent` explains; it
 * never drives replay.
 */
export const Step = z
  .object({
    id: SnakeId,
    intent: z.string().min(1),
    action: StepAction,
    precondition: SnakeId,
    checkpoint: SnakeId,
    outcomes: z.array(SnakeId),
    risk: RiskKind,
    timeout_ms: z.number().int().positive(),
  })
  .strict();

/** One step of the recipe. */
export type Step = z.infer<typeof Step>;
