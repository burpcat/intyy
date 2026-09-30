// The ID format shared by the system adapter and the seeded fake.
// Follows design section 3 §7.2 (run ID format) and section 9 §5.7.
import { z } from "zod";

/** Lowercase Crockford base32: digits and letters, minus `i`, `l`, `o`, `u` (section 3 §7.2). */
export const CROCKFORD = "0123456789abcdefghjkmnpqrstvwxyz";

/** How many random characters follow the date. */
export const ID_RANDOM_CHARS = 10;

/** The prefix of each ID kind. Only the run ID is in the design; the rest share its shape (docs/decisions.md). */
export type IdKind = "run" | "batch" | "lease" | "alert" | "cand";

/**
 * Builds an ID: kind, UTC date, and 10 Crockford characters. Example: `run_2026-09-24_7kq2m9x4tb`.
 * `random` needs at least 10 bytes. Each byte's low 5 bits pick one character.
 */
export function formatId(kind: IdKind, date: Date, random: Uint8Array): string {
  if (random.length < ID_RANDOM_CHARS)
    throw new Error(`formatId needs ${String(ID_RANDOM_CHARS)} random bytes`);
  // Why: 256 is a multiple of 32, so the low 5 bits of a uniform byte are uniform.
  const chars = Array.from(random.subarray(0, ID_RANDOM_CHARS), (b) =>
    CROCKFORD.charAt(b & 31),
  ).join("");
  return `${kind}_${date.toISOString().slice(0, 10)}_${chars}`;
}

/** A valid run ID. 25 characters. */
export const RunId = z.string().regex(/^run_\d{4}-\d{2}-\d{2}_[0-9a-hjkmnp-tv-z]{10}$/);

/** A valid candidate ID: `cand_` plus the run ID shape (docs/decisions.md, M04). */
export const CandidateId = z.string().regex(/^cand_\d{4}-\d{2}-\d{2}_[0-9a-hjkmnp-tv-z]{10}$/);

/** A valid batch ID: `batch_` plus the run ID shape (docs/decisions.md, M01). */
export const BatchId = z.string().regex(/^batch_\d{4}-\d{2}-\d{2}_[0-9a-hjkmnp-tv-z]{10}$/);
