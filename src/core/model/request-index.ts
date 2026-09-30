// The request index line: one tenant's append-only log of keyed hashes, so a repeated
// request ID is told apart from a reused one, with no content stored (section 3 §4.4,
// section 4 §8.11). Not evidence, and not versioned like a released file format (section 3
// §7.1: "the request index is not evidence"); it lives at `state/var/request-index/<tenant>`,
// so it carries no `schema` literal and is not registered in `scripts/schema-formats.ts`.
import { z } from "zod";
import { RunId } from "./ids.js";

/** One HMAC-SHA-256 value, tagged with the key ID that made it (section 4 §8.11). Example:
 * `hmac-sha256:k2:9f3a…` (64 hex characters after the key ID). */
export const KeyedHash = z
  .string()
  .regex(/^hmac-sha256:[a-z][a-z0-9]*:[0-9a-f]{64}$/, "hmac-sha256:<key id>:<64 hex characters>");

/** One keyed hash. */
export type KeyedHash = z.infer<typeof KeyedHash>;

/**
 * One request index entry (section 3 §4.4). `lookup` finds a repeat; `content` tells a true
 * repeat from a reuse with different content (section 4 §8.11). Never the request's inputs,
 * capability, or raw request ID.
 */
export const RequestIndexLine = z
  .object({
    lookup: KeyedHash,
    content: KeyedHash,
    run_id: RunId,
    at: z.iso.datetime(),
  })
  .strict();

/** One request index line. */
export type RequestIndexLine = z.infer<typeof RequestIndexLine>;
