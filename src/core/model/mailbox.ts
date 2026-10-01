// The mailbox file formats: `request.json` (`intyy.intervention/1.0`), `decision.json`
// (`intyy.decision/1.0`), and `closed.json` (`intyy.closed/1.0`). Follows design section 7 §13.1
// (request fields), §13.4 (the operator port in the build), and section 9 §10.5 (mailbox records).
// M03 builds the approval and stuck-takeover kinds. M07 adds claims, releases, and dialogs.
import { z } from "zod";
import { RunId } from "./ids.js";
import { StaffId, TenantId } from "./common.js";

/** The four discovery approval answers (section 4 §7.7; docs/decisions.md, M03). */
export const APPROVAL_DECISIONS = [
  "approve_irreversible",
  "approve_reversible",
  "approve_idempotent",
  "decline",
] as const;

/** One intervention request (section 7 §13.1). Every text is masked. */
export const Intervention = z
  .object({
    schema: z.literal("intyy.intervention/1.0"),
    run_id: RunId,
    tenant: TenantId,
    capability: z.string().min(1),
    // Why `start_confirmation`: docs/decisions.md, M05. Section 7 §4 step 6, replay's own
    // supervised-mode pause: the run waits at this same mailbox before its first task step.
    // Why `reconciliation_decision`/`retry_decision`: docs/decisions.md, M06. The ladder's rung
    // 4 (section 5 §8.9) and the commit path's after-the-fact decisions (section 7 §13.2).
    kind: z.enum([
      "approval",
      "takeover",
      "start_confirmation",
      "reconciliation_decision",
      "retry_decision",
    ]),
    // Why `no_authorization`: docs/decisions.md, M05. A supervised replay commit with no valid
    // authorization opens this same mailbox, answered `approved` or `declined` (section 3 §5.7).
    // Why `supervised_mode`: the one reason a `start_confirmation` ever opens (section 3 §5.7).
    // Why `needs_human_handler`/`reconciliation_unclear`/`reconciliation_waived`/`retry_needs_approval`: docs/decisions.md,
    // M06 (section 3 §5.7's kinds-and-reasons table).
    reason: z.enum([
      "discovery_irreversible",
      "stuck",
      "no_authorization",
      "supervised_mode",
      "needs_human_handler",
      "reconciliation_unclear",
      "reconciliation_waived",
      "retry_needs_approval",
      // Why: docs/decisions.md, M07. Section 7 §12.4, human input while the bot drives.
      "unexpected_human_input",
    ]),
    step: z.object({ id: z.string().min(1), intent: z.string().nullable() }).strict(),
    trouble: z.object({ phase: z.string(), detail: z.string() }).strict().nullable(),
    ladder: z.array(z.unknown()),
    // `notice` is the fixed text every takeover carries while the commit is in flight
    // (section 5 §8.2: "Do not submit again"); `null` otherwise (docs/decisions.md, M06).
    // Optional: a request with no notice at all (every M03/M05 kind) still fits.
    commit: z.object({ state: z.string(), notice: z.string().nullable().optional() }).strict(),
    operator_note: z.string().nullable(),
    approval: z
      .object({
        words: z.string().nullable(),
        risk: z.literal("irreversible"),
        authorization: z.string(),
        // The gate's own facts for this action (section 4 §7.7): what a human must see before
        // approving. Optional, so a request from before this change still fits.
        action: z.string().optional(),
        rule: z.string().optional(),
        path: z.string().nullable().optional(),
        detail: z.string().nullable().optional(),
      })
      .strict()
      .nullable(),
    /** The masked screenshot, as a path inside the run folder. */
    screenshot: z.string().nullable(),
    decisions: z.array(z.string().min(1)).min(1),
    outcomes: z.array(z.string()),
    deadline: z.iso.datetime().nullable(),
    lease: z.string().nullable(),
    on_handback: z.string().nullable(),
    opened_at: z.iso.datetime(),
  })
  .strict();

/** One intervention request. */
export type Intervention = z.infer<typeof Intervention>;

/** One operator decision (section 9 §10.5). */
export const DecisionFile = z
  .object({
    schema: z.literal("intyy.decision/1.0"),
    staff_id: StaffId,
    at: z.iso.datetime(),
    decision: z.string().min(1),
    outcome: z.string().nullable(),
    note: z.string().nullable(),
  })
  .strict();

/** One operator decision. */
export type DecisionFile = z.infer<typeof DecisionFile>;

/** How a request closed (section 9 §10.5). */
export const ClosedFile = z
  .object({
    schema: z.literal("intyy.closed/1.0"),
    how: z.enum(["resolved", "timed_out", "run_ended"]),
    at: z.iso.datetime(),
  })
  .strict();

/** How a request closed. */
export type ClosedFile = z.infer<typeof ClosedFile>;

/** One claim of a takeover (`claim.json`, section 9 §10.5). `implicit`: the engine wrote it for
 * human input from the replay's own staff ID (section 7 §12.4). */
export const ClaimFile = z
  .object({
    schema: z.literal("intyy.claim/1.0"),
    staff_id: StaffId,
    at: z.iso.datetime(),
    implicit: z.boolean(),
  })
  .strict();

/** One claim. */
export type ClaimFile = z.infer<typeof ClaimFile>;

/** One handback (`release.json`, section 9 §10.5). The note passed the text rules. */
export const ReleaseFile = z
  .object({
    schema: z.literal("intyy.release/1.0"),
    staff_id: StaffId,
    at: z.iso.datetime(),
    note: z.string().nullable(),
  })
  .strict();

/** One handback. */
export type ReleaseFile = z.infer<typeof ReleaseFile>;

/**
 * One native-dialog answer, one line of `dialogs.jsonl` (section 9 §10.5). Not a registered
 * format: only a whole file carries a `schema` field, and a log line does not (docs/decisions.md,
 * M07).
 */
export const DialogLine = z
  .object({
    staff_id: StaffId,
    at: z.iso.datetime(),
    answer: z.enum(["accept", "dismiss"]),
  })
  .strict();

/** One dialog answer. */
export type DialogLine = z.infer<typeof DialogLine>;
