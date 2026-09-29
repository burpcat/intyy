// One line of a candidate's `decisions.jsonl`: a human review decision, append only.
// Follows design section 9 §6.2 (candidate folder layout), §8.2 (candidate `<what>` list), and
// section 2 §17.4 (the artifact's own `provenance.decisions` list). The two lists are
// reconciled here (docs/decisions.md, M04): `patch` is left out, since patch review is a
// separate file format, not built in M04.
import { z } from "zod";
import { StaffId } from "./common.js";

/**
 * What a candidate review decision covers (section 9 §8.2, section 2 §17.4). `tag` retags a
 * raw action; `recovery` names the recovery link or check; the rest match the artifact's own
 * `DecisionWhat` (section 2 §17.4), minus `patch`.
 */
export const CandidateDecisionWhat = z.enum([
  "tag",
  "risk",
  "sensitivity",
  "outcome_name",
  "refusal",
  "waiver",
  "recovery",
  "edit",
  "risk_second_look",
]);

/** One decision-what value. */
export type CandidateDecisionWhat = z.infer<typeof CandidateDecisionWhat>;

/**
 * One `decisions.jsonl` line (section 9 §6.2). The last decision on a `subject` wins; nothing
 * is deleted (section 2 §6.4). `subject` is a stable generated ID (docs/decisions.md, M04): an
 * action is `<run_id>#<seq>`, a step or target keeps its own generated ID, and an `edit`
 * subject is a dotted path like `steps.click_login.timeout_ms`. `note` lives only here; the
 * artifact's own `provenance.decisions` entries carry no note.
 */
export const CandidateDecision = z
  .object({
    schema: z.literal("intyy.candidate_decision/1.0"),
    what: CandidateDecisionWhat,
    subject: z.string().min(1),
    value: z.string().min(1),
    by: StaffId,
    at: z.iso.datetime(),
    note: z.string().min(1).optional(),
  })
  .strict();

/** One candidate review decision. */
export type CandidateDecision = z.infer<typeof CandidateDecision>;
