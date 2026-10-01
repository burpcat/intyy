// The run summary file (`intyy.run/1.0`): one run's end state, written once at `run.json`
// (section 3 §7.3). A union on `kind`: the thin `discovery` shape `runDiscovery` has written
// since M03, and M05's fuller `replay` shape. The candidate commands read the discovery shape
// back to find which capability and tenant a finished run belongs to (docs/decisions.md,
// M04: `candidate new <run_id>`; M05: the run.json union, owner decision, 2026-09-29).
import { z } from "zod";
import { AppCapabilityName, TenantId } from "./common.js";
import { Sha256Hash } from "./canonical.js";
import { BatchId, RunId } from "./ids.js";
import { RequestId } from "./request.js";
import { Result } from "./result.js";

/** How a discovery run ended. Only the four end states `runDiscovery` ever writes (section 3
 * §5.2; the orchestrator never writes `running` or `escalated` to a discovery run.json). */
export const RunStatus = z.enum(["success", "business_outcome", "rejected", "failed"]);

/** One discovery run status. */
export type RunStatus = z.infer<typeof RunStatus>;

/** Every status a replay `run.json` may show, including while it is not yet final
 * (section 3 §5.2). */
export const ReplayRunStatus = z.enum([
  "success",
  "business_outcome",
  "rejected",
  "failed",
  "running",
  "escalated",
]);

/** One replay run status. */
export type ReplayRunStatus = z.infer<typeof ReplayRunStatus>;

/** One proof file `run.json` lists: its path, hash, and byte count (section 3 §7.3). */
const RunFile = z
  .object({ path: z.string().min(1), sha256: Sha256Hash, bytes: z.number().int().nonnegative() })
  .strict();

/** How long each tier of this run's files stays, as the dates they retire (section 3 §7.9). */
const Retention = z
  .object({
    debug_until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "a date like 2026-10-24"),
    audit_until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "a date like 2027-09-24"),
  })
  .strict();

/**
 * The discovery `run.json` (section 3 §7.3, thin form). Unchanged since M03/M04, so every
 * existing fixture keeps parsing (owner decision, 2026-09-29: "keep the discovery variants
 * byte-compatible").
 */
const DiscoveryRunJson = z
  .object({
    schema: z.literal("intyy.run/1.0"),
    run_id: RunId,
    tenant: TenantId,
    kind: z.literal("discovery"),
    capability: AppCapabilityName,
    /** The spec file this run ran, `<app>/<name>`, where `name` may add a variant suffix (`kvfcu/
     * open_share_subaccount.missing`). A negative run shares its capability with the positive
     * one, so `capability` alone cannot name its spec (section 6 §14.8). Optional: runs written
     * before this field have none. */
    spec: z.string().regex(/^[a-z][a-z0-9_-]*\/[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)?$/).optional(),
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

/**
 * The replay `run.json` (section 3 §7.3, full form). `capability` is not in the design's
 * example; it is added, common with the discovery shape, so a reader never has to open
 * `result` to learn what a run was for (owner decision, 2026-09-29: a documented gap-fill,
 * not part of the literal §7.3 example). `kind: "reconciliation"` (docs/decisions.md, M06;
 * section 7 §11.1) shares this same shape: a check run is a replay run in every way but its
 * own `kind` and `parent_run_id`.
 */
const ReplayRunJson = z
  .object({
    schema: z.literal("intyy.run/1.0"),
    run_id: RunId,
    tenant: TenantId,
    kind: z.enum(["replay", "reconciliation"]),
    capability: AppCapabilityName,
    parent_run_id: RunId.nullable(),
    batch_id: BatchId.nullable(),
    /** Which case in the batch this run is (section 3 §4.9, the certify run spec). `null` for
     * every run outside a certify batch. */
    case_id: z.string().min(1).nullable(),
    request_id: RequestId.nullable(),
    status: ReplayRunStatus,
    /** The stored result, sensitive outputs masked (section 3 §7.3). */
    result: Result,
    /** A copy of the `run_start` log line's `frozen` block. Its shape follows what each run
     * kind freezes (section 3 §6.5); later tasks fill in a typed replay form. */
    frozen: z.record(z.string(), z.unknown()),
    files: z.array(RunFile),
    retention: Retention,
  })
  .strict();

/** The `run.json` file (section 3 §7.3): one file that answers "what was this run?" without
 * reading the log. */
export const RunJson = z.discriminatedUnion("kind", [DiscoveryRunJson, ReplayRunJson]);

/** One run's summary. */
export type RunJson = z.infer<typeof RunJson>;
