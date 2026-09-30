// The certify batch report (`intyy.batch_report/1.0`), written after the last run.
// Follows design section 8 §7.8, §8.1 to §8.3. Thin (docs/decisions.md, M06: "No score store"):
// no scores, stability, coverage, or jev table yet.
import { z } from "zod";
import { AppId, TenantId } from "./common.js";

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
    run_id: z.string().min(1),
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

/** The report for one `quick` certify batch (section 8 §7.8). */
export const BatchReport = z
  .object({
    schema: z.literal("intyy.batch_report/1.0"),
    batch_id: z.string().min(1),
    tenant: TenantId,
    app: AppId,
    capability: z.string().min(1),
    ended_at: z.iso.datetime(),
    cases: z.array(BatchReportCase).min(1),
    /** Thin gate (docs/decisions.md, M06): passed when no case's verdict blocks it. The real
     * approval gate (section 8 §9.5) needs the score store, which thin certify does not have. */
    gate: z.object({ passed: z.boolean() }).strict(),
  })
  .strict();

/** A certify batch report. */
export type BatchReport = z.infer<typeof BatchReport>;
