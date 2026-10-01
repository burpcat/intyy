// The jev formats: step-trouble input and output, reconciliation input and output. The core
// owns these schemas; the adapter owns the provider's API (section 9 §5.3).
// Follows design section 5 §10.2, §10.3, §10.5.
import { z } from "zod";
import type {
  JevReconcileInput as JevReconcileInputType,
  JevReconcileOutput as JevReconcileOutputType,
  JevTroubleInput as JevTroubleInputType,
  JevTroubleOutput as JevTroubleOutputType,
} from "../../ports/models.js";

/** One screen element as the model sees it: role and name, masked (section 5 §10.2). */
export const ModelElement = z.object({ role: z.string(), name: z.string() }).strict();

/** One check in a condition's trace (section 5 §10.2). */
const TraceEntry = z.object({ path: z.string(), check: z.string(), passed: z.boolean() }).strict();

/** The failed condition (section 5 §10.2, `expected`). Shared with the reviewer's input. */
export const ModelExpected = z
  .object({ condition: z.string(), description: z.string(), trace: z.array(TraceEntry) })
  .strict();

/** The failed step (section 5 §10.2, `step`). Shared with the reviewer's input. */
export const ModelStep = z
  .object({
    id: z.string(),
    intent: z.string(),
    action: z.string(),
    risk: z.enum(["idempotent", "reversible", "irreversible"]),
    phase: z.string(),
  })
  .strict();

/** The last passed step (section 5 §10.2, `last_good`). Shared with the reviewer's input. */
export const ModelLastGood = z.object({ step: z.string(), location: z.string() }).strict();

/** A model's confidence: 0 to 1 (section 5 §10.3). */
export const Confidence = z.number().min(0).max(1);

/** The step-trouble input, `intyy.jev.step/1.0` (section 5 §10.2). The stored file equals the sent input. */
export const JevTroubleInput = z
  .object({
    schema: z.literal("intyy.jev.step/1.0"),
    step: ModelStep,
    expected: ModelExpected,
    last_good: ModelLastGood.nullable(),
    screen: z
      .object({ location: z.string(), truncated: z.boolean(), elements: z.array(ModelElement) })
      .strict(),
    outcomes: z.array(z.object({ code: z.string(), description: z.string() }).strict()),
    handlers: z.array(
      z.object({ id: z.string(), class: z.string(), description: z.string() }).strict(),
    ),
    tied: z.array(z.string()),
    screenshot: z.string().optional(),
  })
  .strict() satisfies z.ZodType<JevTroubleInputType>;

/** The step-trouble output (section 5 §10.3). A bucket names its own field; the other may be null. */
export const JevTroubleOutput = z
  .object({
    bucket: z.enum(["outcome", "handler", "needs_review", "unsafe"]),
    handler: z.string().min(1).nullable(),
    outcome: z.string().min(1).nullable(),
    confidence: Confidence,
  })
  .strict()
  .refine((o) => o.bucket !== "handler" || o.handler !== null, {
    message: "handler: the handler bucket names a handler",
  })
  .refine((o) => o.bucket !== "outcome" || o.outcome !== null, {
    message: "outcome: the outcome bucket names an outcome code",
  }) satisfies z.ZodType<JevTroubleOutputType>;

/** The reconciliation input, `intyy.jev.reconcile/1.0` (section 5 §10.5). The reviewer's second opinion reads it too. */
export const JevReconcileInput = z
  .object({
    schema: z.literal("intyy.jev.reconcile/1.0"),
    parent: z
      .object({
        capability: z.string(),
        commit_step: z.object({ id: z.string(), intent: z.string() }).strict(),
        correlation: z.enum(["notes", "none"]),
        last_screen: z.object({ location: z.string(), elements: z.array(ModelElement) }).strict(),
      })
      .strict(),
    check: z
      .object({
        capability: z.string(),
        status: z.string(),
        outcome: z.string().nullable(),
        failure: z
          .object({
            code: z.string(),
            step: z.string(),
            phase: z.string(),
            trace: z.array(TraceEntry),
          })
          .strict()
          .nullable(),
        final_screen: z.object({ location: z.string(), elements: z.array(ModelElement) }).strict(),
      })
      .strict(),
    not_found_outcomes: z.array(z.string()),
  })
  .strict() satisfies z.ZodType<JevReconcileInputType>;

/** The reconciliation output (section 5 §10.5). */
export const JevReconcileOutput = z
  .object({ verdict: z.enum(["found", "not_found", "unclear"]), confidence: Confidence })
  .strict() satisfies z.ZodType<JevReconcileOutputType>;
