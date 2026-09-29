// The `provenance` block: where every part came from, and who approved it.
// Follows design section 2 §17.
import { z } from "zod";
import { StaffId } from "../common.js";
import { RunId } from "../ids.js";
import { Approval } from "../store-index.js";
import { SnakeId } from "./shared.js";

/** A source run's kind (section 2 §17.2). `replay` and `certify` are patch files only. */
export const RunKind = z.enum(["discovery", "negative_discovery", "replay", "certify"]);

/** One source run's kind. */
export type RunKind = z.infer<typeof RunKind>;

/** One `provenance.runs` entry (section 2 §17.2). `goal` stores input names, not values. */
export const ProvenanceRun = z
  .object({
    run_id: RunId,
    kind: RunKind,
    goal: z.string().min(1),
    expected_outcome: SnakeId.optional(),
    model: z.string().min(1),
    recorder_version: z.string().min(1),
  })
  .strict();

/** One source run. */
export type ProvenanceRun = z.infer<typeof ProvenanceRun>;

/** How the discovery LLM tagged one raw action (section 2 §17.3). */
export const LlmTag = z.enum(["flow_step", "incidental", "correction", "exploration"]);

/**
 * What one raw action became (section 2 §17.3): a step, a handler draft, or nothing (`dropped`).
 */
const Became = z.string().regex(
  /^(step:[a-z][a-z0-9_]*|handler_draft:[a-z][a-z0-9_]*|dropped)$/,
  "step:<id>, handler_draft:<id>, or dropped",
);

/**
 * One `provenance.actions` entry (section 2 §17.3): one raw action, and its fate. `human_tag`
 * and `decided_by` are `null` until a reviewer tags the action; an undecided tag is a blocking
 * review issue (section 6 §14.15), not part of the sealed file's shape.
 */
export const ProvenanceAction = z
  .object({
    run_id: RunId,
    seq: z.number().int().nonnegative(),
    llm_tag: LlmTag,
    human_tag: LlmTag.nullable(),
    decided_by: StaffId.nullable(),
    became: Became,
  })
  .strict();

/** One raw action's record. */
export type ProvenanceAction = z.infer<typeof ProvenanceAction>;

/** What a human decision covers (section 2 §17.4). */
export const DecisionWhat = z.enum([
  "risk",
  "sensitivity",
  "outcome_name",
  "waiver",
  "refusal",
  "edit",
  "patch",
  "risk_second_look",
]);

/** What one decision covers. */
export type DecisionWhat = z.infer<typeof DecisionWhat>;

/**
 * One `provenance.decisions` entry (section 2 §17.4): a human decision, kept forever. Nothing
 * is deleted; the last decision on a subject wins (section 2 §6.4).
 */
export const Decision = z
  .object({
    what: DecisionWhat,
    subject: z.string().min(1),
    value: z.string().min(1),
    by: StaffId,
    at: z.iso.datetime(),
  })
  .strict();

/** One recorded human decision. */
export type Decision = z.infer<typeof Decision>;

/**
 * `provenance` (section 2 §17): source runs, the previous version, raw actions, decisions, and
 * who sealed the file. `sealed` is `null` in a candidate (owner decision, 2026-09-29).
 */
export const Provenance = z
  .object({
    runs: z.array(ProvenanceRun).min(1),
    derived_from: z.string().min(1).nullable(),
    actions: z.array(ProvenanceAction),
    decisions: z.array(Decision),
    sealed: Approval.nullable(),
  })
  .strict();

/** The artifact's `provenance` block. */
export type Provenance = z.infer<typeof Provenance>;
