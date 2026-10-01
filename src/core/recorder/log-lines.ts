// Parses one masked run-log line (`events.jsonl`) into the shape the recorder needs.
// Follows design section 3 §6.4 (event types) and section 6 §13.1 (the fingerprint fields on an
// `action` line). Not a registered file format: one line is not a whole file, and only its
// `run_start` event carries a `schema` field. These schemas are the recorder's own parsing
// concern, so they live here rather than in `src/core/model/`.
import { z } from "zod";
import { Intervention } from "../model/mailbox.js";

/** One acted control's fingerprint, as the log already masked it (section 6 §13.1). */
export const Fingerprint = z
  .object({
    role: z.string(),
    name: z.string().nullable(),
    label: z.string().nullable(),
    text: z.string().nullable(),
    region: z
      .object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() })
      .strict()
      .nullable(),
    crop: z.string().nullable(),
    crop_dropped: z.string().nullable(),
    path: z.string(),
    within: z.string().nullable(),
    max_length: z.number().nullable(),
    field_kind: z.enum(["text", "password", "choice", "check"]).nullable(),
    uniqueness: z.number(),
  })
  .strict();

/** One fingerprint. */
export type Fingerprint = z.infer<typeof Fingerprint>;

/** Every fields common to a log line, before its `event`-specific `data` (section 3 §6.1). */
const BaseLine = z
  .object({
    seq: z.number().int().positive(),
    at: z.string(),
    run_id: z.string(),
    step: z.string().nullable(),
    by: z.string(),
  })
  .loose();

/** A screen tool that sends a request and dispatches through the gate (section 6 §9.1). */
export const ActionTool = z.enum([
  "click",
  "type",
  "select",
  "set_checked",
  "press",
  "navigate",
  "scroll",
  // Why: section 6 §14.7, "each `read` becomes a `read` step". The loop logs it as an `action`
  // line (tool `read`) so it carries a fingerprint and a tag like every other kept action.
  "read",
]);

/** One screen tool. */
export type ActionTool = z.infer<typeof ActionTool>;

/** One action's tag at the time it ran (section 6 §12.1). */
export const ActionTag = z.enum(["flow_step", "incidental", "correction", "exploration"]);

/** One action tag. */
export type ActionTag = z.infer<typeof ActionTag>;

/** One `action` line's `data` (loop.ts `afterGate`). */
const ActionData = z
  .object({
    type: ActionTool,
    target: z.string().nullable(),
    value: z.string().nullable(),
    format: z.string().nullable(),
    /** The chosen option's words, for `select`. `null` for every other tool. Absent entirely on
     * a line an older run logged before this field existed (docs/decisions.md, M04); the
     * recorder then treats a `select` with no `option` as a blocking issue, never a guess. */
    option: z.string().nullable().optional(),
    /** The requested checked state, for `set_checked`. Same absent-on-old-logs rule as `option`. */
    checked: z.boolean().nullable().optional(),
    /** The pressed key, for `press`. Same absent-on-old-logs rule as `option`. */
    key: z.string().nullable().optional(),
    /** The output a `read` fills, its `source`, and the LLM's own `pattern`. Only a `read` line
     * carries them; absent on every other tool's line and on a log from before M05's fix. */
    output: z.string().nullable().optional(),
    source: z.enum(["text", "value"]).nullable().optional(),
    pattern: z.string().nullable().optional(),
    result: z.enum(["ok", "failed"]),
    dispatched: z.union([z.boolean(), z.literal("unknown")]),
    transport: z.string().nullable(),
    tag: ActionTag,
    reason: z.string(),
    expected: z.string(),
    corrects: z.number().nullable(),
    fingerprint: Fingerprint.nullable(),
  })
  .strict();

/** One `action` line. */
export const ActionLine = BaseLine.extend({ event: z.literal("action"), data: ActionData });

/** One `action` line. */
export type ActionLine = z.infer<typeof ActionLine>;

/** One `observation` line's `data` (loop.ts `observe`). */
const ObservationData = z
  .object({
    location: z.string(),
    title: z.string(),
    elements: z.number(),
    files: z.array(z.string()),
    marked: z.boolean(),
  })
  .strict();

/** One `observation` line. */
export const ObservationLine = BaseLine.extend({
  event: z.literal("observation"),
  data: ObservationData,
});

/** One `observation` line. */
export type ObservationLine = z.infer<typeof ObservationLine>;

/** One `extract` line's `data` (loop.ts `doRead`). */
const ExtractData = z
  .object({ output: z.string(), raw: z.string(), value: z.string() })
  .strict();

/** One `extract` line. */
export const ExtractLine = BaseLine.extend({ event: z.literal("extract"), data: ExtractData });

/** One `extract` line. */
export type ExtractLine = z.infer<typeof ExtractLine>;

/** One `escalation` line's `data` (loop.ts `approval`, `stuck`). Only `approval` carries `risk_hint`. */
const EscalationData = z
  .object({
    // Why: the executor also logs start_confirmation, reconciliation_decision, retry_decision.
    kind: Intervention.shape.kind,
    reason: z.string(),
    state: z.string(),
    decision: z.string().nullable().optional(),
    risk_hint: z.enum(["irreversible", "reversible", "idempotent"]).nullable().optional(),
    label: z.string().nullable().optional(),
    staff_id: z.string().optional(),
    detail: z.string().optional(),
  })
  .loose();

/** One `escalation` line. */
export const EscalationLine = BaseLine.extend({
  event: z.literal("escalation"),
  data: EscalationData,
});

/** One `escalation` line. */
export type EscalationLine = z.infer<typeof EscalationLine>;

/** The rules' risk class (section 4 §7), never `null` here: `#decide` in
 * `src/core/safety/gate/gate.ts` only omits `data.risk` for the early checks (lease, actor,
 * page, value) that run before risk is classified at all. */
export const RiskClass = z.enum(["idempotent", "reversible", "irreversible"]);

/** One risk class. */
export type RiskClass = z.infer<typeof RiskClass>;

/** One `gate` line's `data` (section 4 §3.7, `gate.ts`'s `GateLine`). */
const GateData = z
  .object({
    actor: z.string(),
    action: z.string(),
    decision: z.enum(["allowed", "blocked", "needs_approval", "observed"]),
    risk: RiskClass.optional(),
    label: z.string().optional(),
    path: z.string().optional(),
  })
  .strict();

/** One `gate` line. */
export const GateLogLine = BaseLine.extend({ event: z.literal("gate"), data: GateData });

/** One `gate` line. */
export type GateLogLine = z.infer<typeof GateLogLine>;

/** One `lease` line's `data` (section 3 §6.4; `src/core/handoff/lease.ts`). */
const LeaseData = z
  .object({
    from: z.enum(["bot", "human", "nobody"]),
    to: z.enum(["bot", "human", "nobody"]),
    reason: z.enum([
      "run_start",
      "awaiting_decision",
      "decided",
      "takeover_requested",
      "claimed",
      "handed_back",
      "reverified",
      "reverify_failed",
      "run_end",
    ]),
    staff_id: z.string().nullable(),
    implicit: z.boolean(),
  })
  .strict();

/** One `lease` line: control changed hands (section 7 §12.2). */
export const LeaseLine = BaseLine.extend({ event: z.literal("lease"), data: LeaseData });

/** One `lease` line. */
export type LeaseLine = z.infer<typeof LeaseLine>;

/** Every line kind the recorder reads. An event this module does not list is `other`. */
export type ParsedLine =
  | ({ kind: "action" } & ActionLine)
  | ({ kind: "observation" } & ObservationLine)
  | ({ kind: "extract" } & ExtractLine)
  | ({ kind: "escalation" } & EscalationLine)
  | ({ kind: "gate" } & GateLogLine)
  | ({ kind: "lease" } & LeaseLine)
  | { kind: "other" };

/** Parses one already-JSON-parsed log line. Throws on a line that fails its own schema: a
 * masked run log is data the run itself wrote, so a line that claims to be `action` but does
 * not fit is a bug, not an expected trouble (CLAUDE.md: only bugs throw). */
export function parseLine(raw: unknown): ParsedLine {
  if (typeof raw !== "object" || raw === null || !("event" in raw)) return { kind: "other" };
  switch (raw.event) {
    case "action":
      return { kind: "action", ...ActionLine.parse(raw) };
    case "observation":
      return { kind: "observation", ...ObservationLine.parse(raw) };
    case "extract":
      return { kind: "extract", ...ExtractLine.parse(raw) };
    case "escalation":
      return { kind: "escalation", ...EscalationLine.parse(raw) };
    case "gate":
      return { kind: "gate", ...GateLogLine.parse(raw) };
    case "lease":
      return { kind: "lease", ...LeaseLine.parse(raw) };
    default:
      return { kind: "other" };
  }
}
