// The test data set (`intyy.testdata/1.0`): named pools of fake values for one tenant's app.
// Follows design section 8 §6.2 and section 9 §8.7.
import { z } from "zod";
import { AppId, TenantId } from "./common.js";
import { Approval } from "./store-index.js";

/** A pool name: dotted lower-case words. Example: `members.valid`. */
const PoolName = z
  .string()
  .regex(/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/, "a dotted lower-case pool name like members.valid");

/** The harness settings this bank's test app normally runs with (section 8 §6.2). */
export const TestInstance = z
  .object({
    variant: z.string().min(1),
    strip_semantics: z.boolean(),
    drop_labels: z.number().int().nonnegative(),
    label_seed: z.string().min(1),
  })
  .strict();

/** The test instance settings. */
export type TestInstance = z.infer<typeof TestInstance>;

/** One tenant's test data set for one app (section 8 §6.2). */
export const Testdata = z
  .object({
    schema: z.literal("intyy.testdata/1.0"),
    tenant: TenantId,
    app: AppId,
    revision: z.number().int().positive(),
    pools: z.record(PoolName, z.array(z.string().min(1)).min(1)),
    instance: TestInstance,
    business_date: z.iso.date(),
    approved: Approval.optional(),
  })
  .strict();

/** A test data set. */
export type Testdata = z.infer<typeof Testdata>;

/**
 * Loader check: no pool holds a reserved canary member number (CLAUDE.md: the canary never
 * appears in test data; `canaryMembers` is the data root's own `intyy.json#canary_members`).
 */
export function checkNoCanary(doc: Testdata, canaryMembers: readonly string[]): string[] {
  const canary = new Set(canaryMembers);
  const problems: string[] = [];
  for (const [pool, values] of Object.entries(doc.pools)) {
    for (const v of values) if (canary.has(v)) problems.push(`canary_value: ${pool}: ${v} is the canary`);
  }
  return problems;
}

/**
 * Loader check: the app's settings must not say `environment: production` (section 9 §8.7,
 * "`testdata check` refuses"). `environment` is `undefined` when the app has no settings yet.
 */
export function checkNotProduction(environment: string | undefined): string[] {
  return environment === "production"
    ? ["production_app: test data is refused for an app whose settings say environment: production"]
    : [];
}
