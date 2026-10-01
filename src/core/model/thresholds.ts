// The jev threshold record (`intyy.thresholds/1.0`): the three confidence cutoffs for one app and
// one jev version. Follows design section 5 §10.4 and section 8 §14.1.
import { z } from "zod";
import { AppId } from "./common.js";
import { Approval } from "./store-index.js";

/** One cutoff: a confidence from 0 to 1. At 1.0, jev can never reach that answer (section 8 §14.1). */
const Cutoff = z.number().min(0).max(1);

/**
 * A jev version as a folder name, like `jev@1.4.2`. The same rule as a store path segment, so
 * `library/thresholds/<app>/<jev_version>/<rev>.json` stays inside the store.
 */
export const JevVersion = z
  .string()
  .regex(/^[A-Za-z0-9_@+-][A-Za-z0-9_.@+-]*$/, "a jev version like jev@1.4.2");

/** The starting values (section 5 §10.4, section 8 §14.1). The build keeps them; calibration is designed only. */
export const DEFAULT_CUTOFFS = {
  handler_min: 0.8,
  outcome_min: 0.95,
  reconciliation_min: 0.9,
} as const;

/** The threshold record for one app and jev version (section 8 §14.1, level 1). */
export const Thresholds = z
  .object({
    schema: z.literal("intyy.thresholds/1.0"),
    app: AppId,
    jev_version: JevVersion,
    revision: z.number().int().positive(),
    handler_min: Cutoff,
    outcome_min: Cutoff,
    reconciliation_min: Cutoff,
    approved: Approval.optional(),
  })
  .strict();

/** A threshold record. */
export type Thresholds = z.infer<typeof Thresholds>;

/** The store ID for a record: `<app>/<jev_version>` (section 9 §6.2 path `thresholds/<app>/<jev_version>/<rev>.json`). */
export function thresholdsId(doc: Pick<Thresholds, "app" | "jev_version">): string {
  return `${doc.app}/${doc.jev_version}`;
}

/**
 * Loader check beyond the schema. Section 5 §10.4: "An outcome needs more confidence than a
 * handler", because an outcome ends the run and a handler's actions stay gated.
 */
export function checkThresholds(doc: Thresholds): string[] {
  return doc.outcome_min < doc.handler_min
    ? [
        `outcome_min: ${String(doc.outcome_min)} is below handler_min ${String(doc.handler_min)}; an outcome needs more confidence than a handler`,
      ]
    : [];
}
