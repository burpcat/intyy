// The safety test report (`intyy.safety_report/1.0`): what `npm run test:safety` writes to
// `evidence/tests/safety.json`. Follows build plan section 10 §11.1 (item A12) and design
// section 4 §14, §15 (the known-limit test, tracked and marked expected).
import { z } from "zod";

/** One test: its full name and how it ended. `expected_failure` marks a known-limit test: it
 * `passed` because it fails as it should, and the report says so. */
const SafetyTest = z
  .object({
    name: z.string().min(1),
    status: z.enum(["passed", "failed", "skipped"]),
    expected_failure: z.literal(true).optional(),
  })
  .strict();

/** One test file, with its tests. */
const SafetyFile = z
  .object({ file: z.string().min(1), status: z.enum(["passed", "failed"]), tests: z.array(SafetyTest) })
  .strict();

/** The report. `success` is true when no test failed and the known-limit test ran. */
export const SafetyReport = z
  .object({
    schema: z.literal("intyy.safety_report/1.0"),
    generated_at: z.iso.datetime(),
    success: z.boolean(),
    totals: z
      .object({
        tests: z.number().int().nonnegative(),
        passed: z.number().int().nonnegative(),
        failed: z.number().int().nonnegative(),
        skipped: z.number().int().nonnegative(),
        expected_failures: z.number().int().nonnegative(),
      })
      .strict(),
    files: z.array(SafetyFile),
  })
  .strict();

/** The safety test report. */
export type SafetyReport = z.infer<typeof SafetyReport>;
