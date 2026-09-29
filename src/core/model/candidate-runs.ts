// A candidate folder's `runs.json`: the linked discovery runs, positive and negative.
// Follows design section 9 §6.2 ("runs.json: linked discovery runs, positive and negative").
import { z } from "zod";
import { TenantId } from "./common.js";
import { RunId } from "./ids.js";

/** One linked run: its ID, and the tenant it ran under. */
export const CandidateRunRef = z.object({ run_id: RunId, tenant: TenantId }).strict();

/** One linked run reference. */
export type CandidateRunRef = z.infer<typeof CandidateRunRef>;

/** The candidate folder's `runs.json` file. */
export const CandidateRuns = z
  .object({
    schema: z.literal("intyy.candidate_runs/1.0"),
    /** The run the candidate was first recorded from. */
    positive: CandidateRunRef,
    /** Negative runs attached later (section 6 §14.8). */
    negatives: z.array(CandidateRunRef),
  })
  .strict();

/** One candidate's linked runs. */
export type CandidateRuns = z.infer<typeof CandidateRuns>;
