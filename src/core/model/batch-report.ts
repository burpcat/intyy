// The certify batch report (`intyy.batch_report/1.0`), written after the last run.
// Follows design section 8 §7.8, §8.1 to §8.3. Thin (docs/decisions.md, M06: "No score store"):
// no scores, stability, coverage, or jev table yet.
import { z } from "zod";
import { AppId, TenantId } from "./common.js";
import { CaseGroup } from "./batch-plan.js";
import { ScoreKey, Under, VerdictCounts } from "./score.js";

/** Status plus one detail (section 8 §8.1): an outcome code, a failure code, or
 * `<kind>/<reason>/<step>` for `escalated`. */
export const ResultClass = z
  .object({ status: z.enum(["success", "business_outcome", "failed", "escalated"]), detail: z.string().nullable() })
  .strict();

/** A result class. */
export type ResultClass = z.infer<typeof ResultClass>;

/** One truth check's outcome (section 8 §8.2). `match: null` means "unavailable". */
export const TruthCheck = z.object({ match: z.boolean().nullable(), note: z.string().optional() }).strict();

/** A truth check. */
export type TruthCheck = z.infer<typeof TruthCheck>;

/** A case's truth checks (section 8 §8.2). Not every check applies to every case. */
export const TruthChecks = z
  .object({ commit: TruthCheck.optional(), output: TruthCheck.optional(), outcome: TruthCheck.optional() })
  .strict();

/** A case's truth checks. */
export type TruthChecks = z.infer<typeof TruthChecks>;

/** A case's verdict (section 8 §8.3). `explained` never applies to `certify case`/`rerun`: it
 * is for stability runs only, which thin certify does not make. */
export const Verdict = z.enum(["pass", "explained", "assisted", "unexplained", "wrong", "void"]);

/** A verdict. */
export type Verdict = z.infer<typeof Verdict>;

/** One case's judged result. */
export const BatchReportCase = z
  .object({
    case_id: z.string().min(1),
    /** `none` for a void case that never reached a run (section 8 §8.3). */
    run_id: z.string().min(1),
    /** The part of a `full` batch this case belongs to (section 8 §7.2). Absent in a quick batch. */
    group: CaseGroup.optional(),
    /** `setup` for a run that only prepared data. Not judged as a case. */
    purpose: z.literal("setup").optional(),
    /** Why a case is `void`, when plain code knows (section 8 §8.3). */
    note: z.string().min(1).optional(),
    class: z.string().min(1),
    result: ResultClass,
    truth: TruthChecks,
    verdict: Verdict,
    /** `true` when the artifact's recovery is a waiver and this commit-step fault was judged
     * against the waived ending instead of the profile's rule (docs/decisions.md, M06). */
    waived: z.literal(true).optional(),
  })
  .strict();

/** A report case. */
export type BatchReportCase = z.infer<typeof BatchReportCase>;

/** The six gate rules (section 8 §9.5). Each is true or false on its own, so a failed gate says which. */
export const GateRules = z
  .object({
    complete: z.boolean(),
    no_wrong: z.boolean(),
    baseline: z.boolean(),
    matrix: z.boolean(),
    extra: z.boolean(),
    no_void: z.boolean(),
  })
  .strict();

/** The six gate rules. */
export type GateRules = z.infer<typeof GateRules>;

/** One target's locator margins across the batch's `pass` runs (section 8 §9.2). */
export const TargetMargin = z
  .object({
    step: z.string().min(1),
    lowest: z.number(),
    median: z.number(),
    /** The lowest winner score. */
    score_low: z.number(),
  })
  .strict();

/** A target's margins. */
export type TargetMargin = z.infer<typeof TargetMargin>;

/** The report for one certify batch (section 8 §7.8, §9.7). `full` batches fill every field; a
 * `quick` batch leaves the optional ones out. */
export const BatchReport = z
  .object({
    schema: z.literal("intyy.batch_report/1.0"),
    batch_id: z.string().min(1),
    tenant: TenantId,
    app: AppId,
    capability: z.string().min(1),
    ended_at: z.iso.datetime(),
    kind: z.enum(["quick", "full"]).optional(),
    key: ScoreKey.optional(),
    under: Under.optional(),
    cases: z.array(BatchReportCase).min(1),
    /** A quick batch has the thin gate (docs/decisions.md, M06): passed when no case's verdict
     * blocks it. A full batch has the real one (section 8 §9.5): `rules` says which rule failed. */
    gate: z
      .object({
        passed: z.boolean(),
        /** Why a whole batch failed the gate beyond its cases, like a matrix that could not be
         * placed (section 8 §7.1: a harness gap is listed, not hidden). */
        notes: z.array(z.string().min(1)).optional(),
        /** The six rules of section 8 §9.5. Absent in a quick batch, which has no approval-grade gate. */
        rules: GateRules.optional(),
      })
      .strict(),
    /** Pass verdicts over judged runs in the baseline, matrix, extra, and drills (section 8 §9.1). */
    outcome_score: z.number().min(0).max(1).nullable().optional(),
    verdicts: VerdictCounts.optional(),
    /** The batch's lowest locator margin, its step, and each target's margins (section 8 §9.2). */
    margin: z
      .object({
        lowest: z.number().nullable(),
        step: z.string().min(1).nullable(),
        targets: z.record(z.string(), TargetMargin),
      })
      .strict()
      .optional(),
    /** Steps with a lowest margin under 0.30 or a lowest winner score under 0.85 (section 8 §9.2). */
    fragile: z.array(z.string().min(1)).optional(),
    /** Faults planned that never fired, and cases the harness could not run (section 8 §9.4). */
    coverage_gaps: z.array(z.string().min(1)).optional(),
    /** The stability curve. `null`: not run (section 8 §9.3 is a later task). */
    stability: z.null().optional(),
    /** `true` when the batch ran with `--models off`: a drill (section 8 §7.1). */
    models_off: z.literal(true).optional(),
    /** `true` for a drill batch (section 8 §7.1): the plan's instance facts differ from the test
     * data set's. */
    drill: z.literal(true).optional(),
  })
  .strict();

/** A certify batch report. */
export type BatchReport = z.infer<typeof BatchReport>;
