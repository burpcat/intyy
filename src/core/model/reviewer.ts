// The reviewer formats: the fix-step input, and the output (one action, or give up). The core
// owns these schemas; the output schema also becomes the reviewer's tool definition.
// Follows design section 5 §11.1, §11.2.
import { z } from "zod";
import type {
  ReviewerInput as ReviewerInputType,
  ReviewerOutput as ReviewerOutputType,
} from "../../ports/models.js";
import { Confidence, ModelExpected, ModelLastGood, ModelStep } from "./jev.js";

/** One element the reviewer may point at, by ID (section 5 §11.1). */
const ReviewerElement = z.object({ id: z.string().min(1), role: z.string(), name: z.string() }).strict();

/** The reviewer's fix-step input, `intyy.reviewer.step/1.0` (section 5 §11.1). The stored file equals the sent input. */
export const ReviewerInput = z
  .object({
    schema: z.literal("intyy.reviewer.step/1.0"),
    step: ModelStep,
    expected: ModelExpected,
    last_good: ModelLastGood.nullable(),
    screen: z
      .object({ location: z.string(), truncated: z.boolean(), elements: z.array(ReviewerElement) })
      .strict(),
    jev: z
      .object({
        bucket: z.enum(["outcome", "handler", "needs_review", "unsafe"]),
        confidence: Confidence,
      })
      .strict()
      .nullable(),
    inputs: z.array(z.string()),
    allowed: z
      .object({
        actions: z.array(z.string()),
        keys: z.array(z.string()),
        paths: z.array(z.string()),
      })
      .strict(),
    commit: z.enum(["not_sent", "confirmed"]),
    screenshot: z.string().nullable(),
  })
  .strict() satisfies z.ZodType<ReviewerInputType>;

/** The one action the reviewer may propose (section 5 §11.2). The gate checks it again. */
export const ReviewerAction = z.discriminatedUnion("type", [
  z.object({ type: z.literal("click"), element: z.string().min(1) }).strict(),
  z.object({ type: z.literal("type"), element: z.string().min(1), value: z.string() }).strict(),
  z.object({ type: z.literal("select"), element: z.string().min(1), value: z.string() }).strict(),
  z.object({ type: z.literal("set_checked"), element: z.string().min(1), checked: z.boolean() }).strict(),
  z.object({ type: z.literal("press"), key: z.string().min(1) }).strict(),
  z.object({ type: z.literal("navigate"), location: z.string().min(1) }).strict(),
]);

/** The reviewer's output: one action with a reason and an expectation, or a refusal (section 5 §11.2). */
export const ReviewerOutput = z.union([
  z.object({ action: ReviewerAction, reason: z.string().min(1), expected: z.string().min(1) }).strict(),
  z.object({ give_up: z.literal(true), reason: z.string().min(1) }).strict(),
]) satisfies z.ZodType<ReviewerOutputType>;
