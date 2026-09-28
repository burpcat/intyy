// Canonical JSON and SHA-256 hashes: the same content always gives the same hash.
// Follows design section 4 §4.5 (canonical JSON), §5.5, and section 9 §6.4.
import { createHash } from "node:crypto";

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
