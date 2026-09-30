// The caller's request (`intyy.request/1.0`): everything needed to run one capability, once.
// Follows design section 3 §4 (the request, all).
import { z } from "zod";
import { ContractValue, StaffId } from "./common.js";
import { MajorCapabilityLink, SnakeId } from "./artifact/shared.js";

/**
 * The caller's own ID for one request, and its idempotency key (section 3 §4.4). The field is
 * required, but a caller with no ID of its own sends `null`; the result then echoes `null`
 * back (owner decision, 2026-09-29).
 */
export const RequestId = z
  .string()
  .regex(/^[A-Za-z0-9_-]{8,64}$/, "8 to 64 letters, digits, - or _");

/** One caller request ID. */
export type RequestId = z.infer<typeof RequestId>;

/** How a run starts, and where its escalations go (section 3 §4.5). */
export const Mode = z.enum(["supervised", "unattended"]);

/** One run mode. */
export type Mode = z.infer<typeof Mode>;

/**
 * Proof that a member or staff member agreed to the irreversible step (section 3 §4.6). The
 * calling agent collects it; intyy only checks and logs it.
 */
export const Authorization = z
  .object({
    consent_ref: z.string().min(1),
    granted_by: z.enum(["member", "staff"]),
    staff_id: StaffId.optional(),
    granted_at: z.iso.datetime(),
    expires_at: z.iso.datetime(),
    capability: MajorCapabilityLink,
  })
  .strict();

/** One authorization block. */
export type Authorization = z.infer<typeof Authorization>;

/**
 * The request contract (`intyy.request/1.0`, section 3 §4.1). No tenant field: the caller's
 * identity supplies it (§4.2). No minor or patch version: the resolver picks them (§4.3). No
 * test fields: fault profiles and seeds live in the internal run spec only (§4.9).
 */
export const Request = z
  .object({
    schema: z.literal("intyy.request/1.0"),
    request_id: RequestId.nullable(),
    capability: MajorCapabilityLink,
    inputs: z.record(SnakeId, ContractValue),
    mode: Mode,
    authorization: Authorization.optional(),
    /** Milliseconds to wait for a final status before returning. Default 30000; range 0 to
     * 120000 (section 3 §4.7). The default and range are enforced where a request is built,
     * not in this wire schema. */
    wait_ms: z.number().int().min(0).max(120_000).optional(),
  })
  .strict();

/** One caller request. */
export type Request = z.infer<typeof Request>;
