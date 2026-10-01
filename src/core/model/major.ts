// The major record (`intyy.major/1.0`): one capability major is deprecated, with a successor and a date.
// Follows design section 8 §11.9 (the record, the retire date) and section 9 §6.2 (`library/majors/`).
import { z } from "zod";
import { AppId, StaffId } from "./common.js";
import { Approval } from "./store-index.js";

/** A capability name without its app, like `open_share_subaccount`. */
const CapabilityName = z.string().regex(/^[a-z][a-z0-9_]*$/, "a capability name like open_share_subaccount");

/**
 * The record for one capability major (section 8 §11.9). An approver sets it, once per major, and it
 * applies to every bank. A newer revision replaces the older one. Dates are UTC days, `YYYY-MM-DD`.
 */
export const Major = z
  .object({
    schema: z.literal("intyy.major/1.0"),
    app: AppId,
    capability: CapabilityName,
    /** The major being deprecated. Example: `1` for `@1`. */
    major: z.number().int().positive(),
    revision: z.number().int().positive(),
    /** The day an approver deprecated it. */
    deprecated_on: z.iso.date(),
    /** The major callers should move to. */
    successor: z.number().int().positive(),
    /** The earliest retire day, in any context. */
    retires_on: z.iso.date(),
    by: StaffId,
    reason: z.string().min(1),
    approved: Approval.optional(),
  })
  .strict();

/** A major record. */
export type Major = z.infer<typeof Major>;

/** The store ID: `<app>/<capability>@<major>` (section 9 §6.2 path `majors/<app>/<cap>@<n>/<rev>.json`). */
export function majorId(doc: Pick<Major, "app" | "capability" | "major">): string {
  return `${doc.app}/${doc.capability}@${String(doc.major)}`;
}

/** Loader checks beyond the schema: the successor is a later major, and the retire day is not before the deprecation day. */
export function checkMajor(doc: Major): string[] {
  const errors: string[] = [];
  if (doc.successor <= doc.major) errors.push(`successor: ${String(doc.successor)} is not later than major ${String(doc.major)}`);
  if (doc.retires_on < doc.deprecated_on) errors.push(`retires_on: ${doc.retires_on} is before deprecated_on ${doc.deprecated_on}`);
  return errors;
}
