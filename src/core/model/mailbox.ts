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
    kind: z.enum(["approval", "takeover", "start_confirmation"]),
    // Why `no_authorization`: docs/decisions.md, M05. A supervised replay commit with no valid
    // authorization opens this same mailbox, answered `approved` or `declined` (section 3 §5.7).
    // Why `supervised_mode`: the one reason a `start_confirmation` ever opens (section 3 §5.7).
    reason: z.enum(["discovery_irreversible", "stuck", "no_authorization", "supervised_mode"]),
    step: z.object({ id: z.string().min(1), intent: z.string().nullable() }).strict(),
    trouble: z.object({ phase: z.string(), detail: z.string() }).strict().nullable(),
    ladder: z.array(z.unknown()),
    commit: z.object({ state: z.string() }).strict(),
    operator_note: z.string().nullable(),
    approval: z
      .object({
        words: z.string().nullable(),
        risk: z.literal("irreversible"),
        authorization: z.string(),
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
