// The result contract (`intyy.result/1.0`): tells the caller what happened, in one shape,
// whatever happened. Follows design section 3 §5 (the result contract, all).
import { z } from "zod";
import { AppCapabilityName, ContractValue, StaffId } from "./common.js";
import { Semver } from "./artifact/identity.js";
import { SnakeId } from "./artifact/shared.js";
import { RunId } from "./ids.js";
import { RequestId } from "./request.js";

/** The six statuses a result may carry (section 3 §5.2). */
export const Status = z.enum([
  "success",
  "business_outcome",
  "failed",
  "rejected",
  "running",
  "escalated",
]);

/** One result status. */
export type Status = z.infer<typeof Status>;

/** The resolved capability a result answers for. `version` and `patch_revision` are `null`
 * when the run was rejected before the resolver chose (section 3 §5.1). */
const ResultCapability = z
  .object({
    name: AppCapabilityName,
    version: Semver.nullable(),
    patch_revision: z.number().int().nonnegative().nullable(),
  })
  .strict();

/** Start, end, duration, and human time (section 3 §5.1). `ended_at` is `null` while the
 * status is not final. */
const Timing = z
  .object({
    started_at: z.iso.datetime(),
    ended_at: z.iso.datetime().nullable(),
    duration_ms: z.number().int().nonnegative(),
    human_ms: z.number().int().nonnegative(),
  })
  .strict();

/** One commit state for the run's one irreversible action (section 3 §5.8). */
export const CommitState = z.enum([
  "not_sent",
  "refused",
  "confirmed",
  "uncertain",
  "found_by_check",
  "absent_by_check",
]);

/** One commit state. */
export type CommitState = z.infer<typeof CommitState>;

/** Who or what decided a code: plain code, the jev checker, or a human (section 3 §5.4, §5.8). */
const DecidedBy = z.enum(["code", "jev", "human"]);

/** `effect` (section 3 §5.8): what is known about the one irreversible action. Present only on
 * a non-rejected result of a `commits` capability; a business rule outside this wire schema. */
const EffectBlock = z
  .object({
    commit: CommitState,
    performed_by: z.enum(["bot", "human"]).nullable(),
    sent_at: z.iso.datetime().nullable(),
    check: z
      .object({ run_id: RunId, decided_by: DecidedBy, staff_id: StaffId.nullable() })
      .strict()
      .optional(),
    attempts: z.array(z.object({ run_id: RunId, commit: CommitState }).strict()),
  })
  .strict();

/** The `effect` block. */
export type EffectBlock = z.infer<typeof EffectBlock>;

/** One coded warning (section 3 §5.9). */
const Warning = z
  .object({
    code: z.enum([
      "duplicate_request",
      "major_version_deprecated",
      "outputs_masked",
      "effect_updated",
    ]),
    message: z.string().min(1),
  })
  .strict();

/** One automatic recovery used along the way (section 3 §5.10). */
const Recovery = z
  .object({
    step: SnakeId,
    rung: z.union([z.literal(1), z.literal(2), z.literal(3)]).nullable(),
    via: z.enum(["handler", "retry", "reviewer", "reconciliation"]),
    ref: z.string().min(1),
    resumed_at: SnakeId,
    at: z.iso.datetime(),
  })
  .strict();

/** Every kind of human decision a run may need, across all escalation kinds (section 3 §5.7). */
const InterventionKind = z.enum([
  "start_confirmation",
  "approval",
  "takeover",
  "reconciliation_decision",
  "retry_decision",
]);

/** Every reason a run may stop for a human, across all kinds (section 3 §5.7). Which reason
 * fits which kind is a business rule, not a constraint of this wire schema. */
const InterventionReason = z.enum([
  "supervised_mode",
  "no_authorization",
  "authorization_expired",
  "bank_requires_approval",
  "discovery_irreversible",
  "stuck",
  "unsafe_state",
  "needs_human_handler",
  "unexpected_human_input",
  "reconciliation_unclear",
  "reconciliation_waived",
  "retry_needs_approval",
]);

/** Every decision word a human may record, across all kinds (section 3 §5.11). */
const InterventionDecision = z.enum([
  "approved",
  "declined",
  "handed_back",
  "ended_run",
  "set_outcome",
  "found",
  "not_found",
  "retry",
  "no_retry",
]);

/** One resolved human decision (section 3 §5.11). */
const Intervention = z
  .object({
    kind: InterventionKind,
    reason: InterventionReason,
    step: SnakeId.nullable(),
    staff_id: StaffId,
    decision: InterventionDecision,
    requested_at: z.iso.datetime(),
    resolved_at: z.iso.datetime(),
    human_actions: z.number().int().nonnegative(),
    resumed_at_step: SnakeId.nullable(),
  })
  .strict();

/** `outputs` (section 3 §5.3): the plain map from output name to value. */
const Outputs = z.record(SnakeId, ContractValue);

/** `outcome` (section 3 §5.4): a real answer, not a crash. */
const Outcome = z
  .object({
    code: SnakeId,
    description: z.string().min(1),
    step: SnakeId,
    decided_by: DecidedBy,
    set_by: StaffId.nullable(),
  })
  .strict();

/** Every failure code format 1 defines (section 3 §5.5). A new code is a minor format change. */
export const FailureCode = z.enum([
  "app_unreachable",
  "session_lost",
  "precondition_failed",
  "target_not_found",
  "target_ambiguous",
  "action_blocked",
  "action_failed",
  "checkpoint_timeout",
  "app_error",
  "output_parse_failed",
  "run_timeout",
  "escalation_timeout",
  "ended_by_operator",
  "evidence_write_failed",
  "internal_error",
  "secret_unavailable",
  "permission_denied",
  "undeclared_outcome",
  "handler_set_invalid",
  "outputs_unavailable",
  "discovery_limit",
  "model_unavailable",
]);

/** One failure code. */
export type FailureCode = z.infer<typeof FailureCode>;

/** Where in a step a failure happened (section 3 §5.5). */
const Phase = z.enum([
  "start",
  "precondition",
  "target",
  "gate",
  "action",
  "checkpoint",
  "extract",
  "escalation",
  "run",
]);

/** One leaf check in `observed.checks` (section 3 §5.5). */
const ObservedCheck = z
  .object({
    path: z.string().min(1),
    check: z.string().min(1),
    passed: z.boolean(),
    observed: z.string().min(1),
  })
  .strict();

/** `failure` (section 3 §5.5): a hard failure during the run. */
const Failure = z
  .object({
    code: FailureCode,
    message: z.string().min(1),
    step: SnakeId.nullable(),
    phase: Phase,
    expected: z.object({ condition: z.string().min(1), description: z.string().min(1) }).strict(),
    observed: z.object({ location: z.string().min(1), checks: z.array(ObservedCheck) }).strict(),
    attempts: z.number().int().nonnegative(),
    ladder: z
      .object({
        rung: z.number().int().nonnegative(),
        verdict: z.string().min(1),
        ref: z.string().min(1),
      })
      .strict(),
    transient: z.boolean(),
    safe_to_retry: z.boolean(),
    files: z.array(z.string().min(1)),
  })
  .strict();

/** Every rejection code format 1 defines (section 3 §5.6). */
export const RejectionCode = z.enum([
  "invalid_request",
  "request_id_reused",
  "capability_not_found",
  "no_version_for_context",
  "invalid_input",
  "context_not_approved",
  "reconciliation_not_approved",
  "authorization_invalid",
  "policy_denied",
]);

/** One rejection code. */
export type RejectionCode = z.infer<typeof RejectionCode>;

/** One rejection error (section 3 §5.6). `field` and `reason` fit only some codes; which ones
 * is a business rule, not a constraint of this wire schema. */
const RejectionError = z
  .object({
    code: RejectionCode,
    field: z.string().min(1).optional(),
    reason: z.string().min(1).optional(),
    message: z.string().min(1),
  })
  .strict();

/** `rejection` (section 3 §5.6): the request broke a rule. Nothing ran. */
const Rejection = z.object({ errors: z.array(RejectionError).min(1) }).strict();

/** `escalation` (section 3 §5.7): a human is needed, or is working. */
const Escalation = z
  .object({
    kind: InterventionKind,
    reason: InterventionReason,
    step: SnakeId.nullable(),
    waiting_since: z.iso.datetime(),
    deadline: z.iso.datetime(),
    handled_by: StaffId.nullable(),
    poll_after_ms: z.number().int().nonnegative(),
  })
  .strict();

/** Fields every result shares (section 3 §5.1), besides `status` and its own block. */
const Envelope = {
  schema: z.literal("intyy.result/1.0"),
  run_id: RunId,
  request_id: RequestId.nullable(),
  capability: ResultCapability,
  /** Present only on a non-rejected result of a `commits` capability (section 3 §5.8). */
  effect: EffectBlock.optional(),
  warnings: z.array(Warning),
  recoveries: z.array(Recovery),
  interventions: z.array(Intervention),
  timing: Timing,
  evidence: z.string().min(1),
};

/**
 * The result contract (`intyy.result/1.0`, section 3 §5): one shape, whatever happened. A
 * union on `status`; each status allows exactly its own block (§5.15).
 */
export const Result = z.discriminatedUnion("status", [
  z.object({ ...Envelope, status: z.literal("success"), outputs: Outputs }).strict(),
  z.object({ ...Envelope, status: z.literal("business_outcome"), outcome: Outcome }).strict(),
  z.object({ ...Envelope, status: z.literal("failed"), failure: Failure }).strict(),
  z.object({ ...Envelope, status: z.literal("rejected"), rejection: Rejection }).strict(),
  z.object({ ...Envelope, status: z.literal("running") }).strict(),
  z.object({ ...Envelope, status: z.literal("escalated"), escalation: Escalation }).strict(),
]);

/** One result. */
export type Result = z.infer<typeof Result>;
