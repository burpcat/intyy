// The certify batch plan (`intyy.batch_plan/1.0`), written before the first run.
// Follows design section 8 §6.4 (route map), §7.5 (the certify run spec), §7.8 (plan and report).
import { z } from "zod";
import { AppId, TenantId } from "./common.js";
import { FaultKind } from "./faults.js";
import { TestInstance } from "./testdata.js";

/** One step's route key and counter, learned from a clean baseline run (section 8 §6.4). */
export const RouteMapEntry = z.object({ route: z.string().min(1), nth: z.number().int().positive() }).strict();

/** A route map entry. */
export type RouteMapEntry = z.infer<typeof RouteMapEntry>;

/** One named fault, resolved to an exact route and counter (CONTRACT §6.2). A second,
 * independent copy of `ports/harness.ts`'s `NamedFault` shape: `core/model/` may not import
 * `ports/harness.ts` (only `core/certify/` may). */
export const ResolvedFault = z
  .object({
    kind: FaultKind,
    route: z.string().min(1),
    nth: z.number().int().positive(),
    repeat: z.enum(["once", "always"]),
  })
  .strict();

/** A resolved fault. */
export type ResolvedFault = z.infer<typeof ResolvedFault>;

/** One run this batch made: the baseline, or the one chosen case (section 8 §7.4, §7.5). */
export const BatchPlanCase = z
  .object({
    case_id: z.string().min(1),
    run_id: z.string().min(1),
    class: z.string().min(1),
    /** A standard profile ID, a suite `extra` case ID, or `null` for the baseline. */
    profile: z.string().nullable(),
    inputs: z.record(z.string(), z.string()),
    faults: z.array(ResolvedFault),
    seed: z.string().min(1),
    expect: z.object({ status: z.string().min(1) }).loose().nullable(),
  })
  .strict();

/** One plan case. */
export type BatchPlanCase = z.infer<typeof BatchPlanCase>;

/** The plan for one `quick` certify batch (`certify case` or `certify rerun`; section 8 §7.1,
 * §7.8). Never approval-grade (section 9 §9.1). */
export const BatchPlan = z
  .object({
    schema: z.literal("intyy.batch_plan/1.0"),
    batch_id: z.string().min(1),
    tenant: TenantId,
    app: AppId,
    capability: z.string().min(1),
    kind: z.literal("quick"),
    started_by: z.string().min(1),
    started_at: z.iso.datetime(),
    instance: TestInstance,
    route_map: z.record(z.string(), RouteMapEntry),
    cases: z.array(BatchPlanCase).min(1),
    rerun_of: z.object({ batch_id: z.string().min(1), case_id: z.string().min(1) }).optional(),
  })
  .strict();

/** A certify batch plan. */
export type BatchPlan = z.infer<typeof BatchPlan>;
