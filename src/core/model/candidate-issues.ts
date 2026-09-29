// A candidate folder's `issues.json`: the recorder's review issues, regenerated after every
// decision. Follows design section 9 §6.2 and section 6 §14.15 (blocking, then warning).
import { z } from "zod";

/** One review issue (mirrors `src/core/recorder/issues.ts`'s `RecorderIssue`, as a file format). */
export const CandidateIssue = z
  .object({
    level: z.enum(["blocking", "warning"]),
    code: z.string().min(1),
    message: z.string().min(1),
    subject: z.string().min(1).optional(),
  })
  .strict();

/** One candidate review issue. */
export type CandidateIssue = z.infer<typeof CandidateIssue>;

/** The candidate folder's `issues.json` file. */
export const CandidateIssues = z
  .object({
    schema: z.literal("intyy.candidate_issues/1.0"),
    issues: z.array(CandidateIssue),
  })
  .strict();

/** One candidate's review issues. */
export type CandidateIssues = z.infer<typeof CandidateIssues>;
