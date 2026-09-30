// Canonical JSON and SHA-256 hashes: the same content always gives the same hash.
// Follows design section 4 §4.5 (canonical JSON), §5.5, §8.11 (the request index's keyed
// hash), and section 9 §6.4.
import { createHash, createHmac } from "node:crypto";
import { z } from "zod";

/** A `sha256:` hex digest, lower case (section 9 §6.4, section 3 §7.3 file hashes). */
export const Sha256Hash = z.string().regex(/^sha256:[0-9a-f]{64}$/, "sha256:<64 hex characters>");

/** Canonical JSON: keys sorted at every level, no spaces (section 4 §4.5). */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

/** Copies plain objects with their keys sorted. Arrays keep their order. */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(entries.map(([k, v]) => [k, sortKeys(v)]));
  }
  return value;
}

/** The lowercase hex SHA-256 of text or bytes. `run.json` file lists use this form. */
export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** `sha256:` plus hex, over canonical JSON. The form index lines and run logs record. */
export function hashJson(value: unknown): string {
  return `sha256:${sha256Hex(canonicalJson(value))}`;
}

/**
 * The lowercase hex HMAC-SHA-256 of text or bytes, under `key` (section 4 §8.11). A keyed hash:
 * unlike `sha256Hex`, nobody without `key` can guess it, even for a small value like a member
 * ID. The request index is the only caller; `key` never leaves memory.
 */
export function hmacSha256Hex(key: string, data: string | Uint8Array): string {
  return createHmac("sha256", key).update(data).digest("hex");
}
