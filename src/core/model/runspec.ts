// The run spec file (`intyy.runspec/1.0`): exactly what one discovery run must do.
// Follows design section 6 §6.1 (fields), §6.2 (limits), §6.3 (example), and section 2 §12.2 to
// §12.4 (input types and constraints). Rules beyond the shape live in `core/discovery/spec-checks.ts`.
import { z } from "zod";
import { AppId, PathPattern, StaffId, TenantId } from "./common.js";

/** A name used in `{input.name}` or `{output.name}`. Example: `member_id`. */
const FieldName = z.string().regex(/^[a-z][a-z0-9_]*$/, "a lower-case name like member_id");

/** A capability name, verb first (section 6 §6.1). Example: `open_share_subaccount`. */
export const CapabilityName = z
  .string()
  .regex(/^[a-z][a-z0-9_]*$/, "a lower-case name like open_share_subaccount");

/** Value types (section 2 §12.3). `money` is a decimal string; `date` is `YYYY-MM-DD`. */
export const ValueType = z.enum([
  "string",
  "integer",
  "decimal",
  "money",
  "date",
  "boolean",
  "enum",
]);

/** One value type. */
export type ValueType = z.infer<typeof ValueType>;

/** Input sensitivity labels (section 4 §9.2). */
export const Sensitivity = z.enum(["pii", "financial", "none"]);

/** A bound in a range: a number, or a string for money, decimal, and date. */
const RangeEnd = z.union([z.number(), z.string().min(1)]);

/** Optional input limits (section 2 §12.4). */
const Constraints = z
  .object({
    length: z
      .object({ min: z.number().int().nonnegative(), max: z.number().int().positive() })
      .strict()
      .optional(),
    range: z.object({ min: RangeEnd.optional(), max: RangeEnd.optional() }).strict().optional(),
    values: z.array(z.string().min(1)).min(1).optional(),
    format: z.enum(["digits", "letters", "alphanumeric"]).optional(),
  })
  .strict();

/** One input. `example` is a fake value for test apps (section 6 §6, section 4 §10.6). */
export const SpecInput = z
  .object({
    name: FieldName,
    type: ValueType,
    description: z.string().min(1),
    sensitivity: Sensitivity,
    example: z.string().min(1),
    constraints: Constraints.optional(),
  })
  .strict();

/** One input of a run spec. */
export type SpecInput = z.infer<typeof SpecInput>;

/** One output the operator declares. The LLM may read only these (section 6 §9.3). */
export const SpecOutput = z
  .object({ name: FieldName, type: ValueType, description: z.string().min(1) })
  .strict();

/** Run limits (section 6 §6.2). Every field is optional; defaults fill the gaps. */
export const Limits = z
  .object({
    max_steps: z.number().int().positive().optional(),
    max_minutes: z.number().int().positive().optional(),
    max_blocked: z.number().int().positive().optional(),
    max_invalid: z.number().int().positive().optional(),
    max_repeat: z.number().int().positive().optional(),
  })
  .strict();

/** Every limit, filled in. */
export type FullLimits = Required<z.infer<typeof Limits>>;

/** The defaults of section 6 §6.2. */
export const DEFAULT_LIMITS: FullLimits = {
  max_steps: 40,
  max_minutes: 20,
  max_blocked: 5,
  max_invalid: 3,
  max_repeat: 3,
};

/** The run spec file. */
export const RunSpec = z
  .object({
    schema: z.literal("intyy.runspec/1.0"),
    kind: z.enum(["discovery", "negative_discovery"]),
    caller: z.object({ tenant: TenantId, agent_id: StaffId }).strict(),
    app: AppId,
    capability: CapabilityName,
    goal: z.string().min(1),
    inputs: z.array(SpecInput),
    outputs: z.array(SpecOutput),
    expected_effect: z.enum(["read_only", "commits"]),
    expected_outcome: z
      .object({ code: FieldName, description: z.string().min(1) })
      .strict()
      .optional(),
    correlation: z.enum(["notes", "none"]).optional(),
    /** A session capability link, `app/capability@major`, or null for the session itself (§5.5). */
    session: z
      .string()
      .regex(/^[a-z][a-z0-9_-]*\/[a-z][a-z0-9_]*@[1-9]\d*$/, "a link like kvfcu/sign_in@1")
      .nullable(),
    entry: PathPattern,
    limits: Limits.optional(),
    model: z.string().min(1),
    prompt: z.string().regex(/^discovery@\d+\.\d+$/, "a prompt version like discovery@1.0"),
    derived_from: z.string().min(1).nullable().optional(),
  })
  .strict();

/** A run spec. */
export type RunSpec = z.infer<typeof RunSpec>;

/** The spec's limits with the defaults filled in. */
export function fullLimits(spec: RunSpec): FullLimits {
  return { ...DEFAULT_LIMITS, ...spec.limits };
}
