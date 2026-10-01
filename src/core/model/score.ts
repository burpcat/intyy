// The score record (`intyy.score/1.0`): the current trust state of one key, rebuilt from its history.
// Follows design section 8 §5.1 (the key), §5.3 (record fields), and §4.1 (states).
import { z } from "zod";
import { Sha256Hash } from "./canonical.js";
import { TenantId } from "./common.js";

/** A trust state (section 8 §4.1). */
export const TrustState = z.enum(["draft", "approved", "degraded", "retired"]);

/** A trust state. */
export type TrustState = z.infer<typeof TrustState>;

/** An exact capability, like `kvfcu/open_share_subaccount@1.0.0`: each exact version is its own recipe (§5.1). */
export const CapabilityKey = z
  .string()
  .regex(/^[a-z][a-z0-9_-]*\/[a-z][a-z0-9_]*@\d+\.\d+\.\d+$/, "app/capability@x.y.z");

/** The key: four parts (section 8 §5.1). Engine and handler set hash stay out of it. */
export const ScoreKey = z
  .object({
    capability: CapabilityKey,
    tenant: TenantId,
    /** The bank's app version. Example: `9.2`. A folder name, so one safe path segment. */
    app_version: z.string().regex(/^[A-Za-z0-9_@+-][A-Za-z0-9_.@+-]*$/, "an app version like 9.2"),
    /** The patch revision, or `null` for no patch. */
    patch_revision: z.number().int().positive().nullable(),
  })
  .strict();

/** A score key. */
export type ScoreKey = z.infer<typeof ScoreKey>;

/** Facts a batch ran under, recorded but kept out of the key (section 8 §5.1). `null`: not known. */
export const Under = z
  .object({
    engine: z.string().min(1),
    handler_set: Sha256Hash.nullable(),
    jev: z.string().min(1).nullable(),
    /** The session key the batch used, like `kvfcu/sign_in@1.0.0`. */
    session: z.string().min(1).nullable(),
    /** The check key the batch used. */
    check: z.string().min(1).nullable(),
  })
  .strict();

/** What a batch ran under. */
export type Under = z.infer<typeof Under>;

/** Verdict counts (section 8 §5.3 example). One count per verdict of section 8 §8.3. */
export const VerdictCounts = z
  .object({
    pass: z.number().int().nonnegative(),
    explained: z.number().int().nonnegative(),
    assisted: z.number().int().nonnegative(),
    unexplained: z.number().int().nonnegative(),
    wrong: z.number().int().nonnegative(),
    void: z.number().int().nonnegative(),
  })
  .strict();

/** Verdict counts. */
export type VerdictCounts = z.infer<typeof VerdictCounts>;

/** What a full batch scored (section 8 §5.3). */
export const BatchScores = z
  .object({
    outcome_score: z.number().min(0).max(1).nullable(),
    verdicts: VerdictCounts,
    margin: z.object({ lowest: z.number().nullable(), step: z.string().min(1).nullable() }).strict(),
    fragile: z.array(z.string().min(1)),
  })
  .strict();

/** A full batch's scores. */
export type BatchScores = z.infer<typeof BatchScores>;

/** One batch as the record keeps it (section 8 §5.3: `certify` and `regression`). */
export const BatchSummary = z
  .object({
    batch: z.string().min(1),
    at: z.iso.datetime(),
    gate: z.enum(["passed", "failed"]),
    report_hash: Sha256Hash,
    under: Under,
    /** `null` for a regression batch, and for a full batch before the scorer exists. */
    scores: BatchScores.nullable(),
  })
  .strict();

/** A batch summary. */
export type BatchSummary = z.infer<typeof BatchSummary>;

/** Tuned timeouts in milliseconds, by step ID (section 8 §9.6). */
export const Timeouts = z.record(z.string().min(1), z.number().int().positive());

/** The score record (section 8 §5.3). */
export const ScoreRecord = z
  .object({
    schema: z.literal("intyy.score/1.0"),
    key: ScoreKey,
    /** From the store index. `null`: the artifact is not sealed in this library. */
    hashes: z.object({ artifact: Sha256Hash.nullable(), patch: Sha256Hash.nullable() }).strict(),
    state: TrustState,
    /** The line that set the state. All `null` while no line has set one (a synthetic draft). */
    state_since: z.iso.datetime().nullable(),
    state_by: z.string().min(1).nullable(),
    state_reason: z.string().nullable(),
    /** Latest full batch. */
    certify: BatchSummary.nullable(),
    /** Latest regression batch (M11). */
    regression: BatchSummary.nullable(),
    approval: z
      .object({
        batch: z.string().min(1),
        by: z.string().min(1),
        at: z.iso.datetime(),
        acknowledged: z.array(z.string().min(1)),
        note: z.string().nullable(),
      })
      .strict()
      .nullable(),
    timeouts: z
      .object({
        approved: Timeouts,
        approved_from: z.string().min(1).nullable(),
        candidate: Timeouts.nullable(),
        candidate_from: z.string().min(1).nullable(),
      })
      .strict(),
    /** Context tightenings of jev thresholds (section 8 §14.1). */
    thresholds: z
      .object({
        handler_min: z.number().min(0).max(1).optional(),
        outcome_min: z.number().min(0).max(1).optional(),
        reconciliation_min: z.number().min(0).max(1).optional(),
        batch: z.string().min(1),
      })
      .strict()
      .nullable(),
    /** The reconciliation autonomy record (M11). */
    autonomy: z
      .object({
        state: z.enum(["earning", "ready", "granted", "revoked"]),
        correct: z.number().int().nonnegative(),
        found: z.number().int().nonnegative(),
        not_found: z.number().int().nonnegative(),
        wrong: z.number().int().nonnegative(),
      })
      .strict()
      .nullable(),
    /** The rolling live score (M11). */
    live: z
      .object({
        window: z.number().int().positive(),
        counted: z.number().int().nonnegative(),
        clean: z.number().int().nonnegative(),
        assisted: z.number().int().nonnegative(),
        recipe_failures: z.number().int().nonnegative(),
        app_failures: z.number().int().nonnegative(),
        score: z.number().min(0).max(1).nullable(),
        streak: z.number().int().nonnegative().nullable(),
      })
      .strict()
      .nullable(),
    alerts: z.array(z.string().min(1)),
  })
  .strict();

/** A score record. */
export type ScoreRecord = z.infer<typeof ScoreRecord>;
