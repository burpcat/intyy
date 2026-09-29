// The run summary file (`intyy.run/1.0`): one discovery run's end state, written once at
// `run.json` (section 3 §7.3). The candidate commands read it back to find which capability
// and tenant a finished run belongs to (docs/decisions.md, M04: `candidate new <run_id>`).
import { z } from "zod";
import { TenantId } from "./common.js";
import { RunId } from "./ids.js";

/** How a run ended. Only the four end states `runDiscovery` ever writes (section 3 §5.2,
 * section 9 orchestrator: `running` and `escalated` never reach `run.json`). */
export const RunStatus = z.enum(["success", "business_outcome", "rejected", "failed"]);

/** One run status. */
export type RunStatus = z.infer<typeof RunStatus>;

/** The `run.json` file. */
export const RunJson = z
  .object({
    schema: z.literal("intyy.run/1.0"),
    run_id: RunId,
    tenant: TenantId,
    kind: z.enum(["discovery"]),
    /** `<app>/<capability>` (section 3 §7.3). */
    capability: z.string().regex(/^[a-z][a-z0-9_-]*\/[a-z][a-z0-9_]*$/, "app/capability"),
    status: RunStatus,
    code: z.string().min(1).nullable(),
    started_at: z.iso.datetime(),
    ended_at: z.iso.datetime(),
    counts: z
      .object({
        turns: z.number().int().nonnegative(),
        actions: z.number().int().nonnegative(),
        blocked: z.number().int().nonnegative(),
        invalid: z.number().int().nonnegative(),
      })
      .strict()
      .nullable(),
  })
  .strict();

/** One run's summary. */
export type RunJson = z.infer<typeof RunJson>;
