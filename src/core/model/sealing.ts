// The sealing rules every document store applies, whatever holds the bytes.
// Follows design section 9 §5.8 and §6.4: hash without `approved`, four eyes, approve once.
import type { z } from "zod";
import { fail, ok, type Outcome } from "../../ports/outcome.js";
import { hashJson } from "./canonical.js";
import type { IndexLine } from "./store-index.js";

/** What a document store needs to know about one record kind. */
export type DocKind<T> = {
  /** The index line's `kind`. Examples: `policy`, `settings`. */
  name: string;
  /** The record's schema. */
  schema: z.ZodType<T>;
  /** The revision a document declares. Example: policy `revision: 3` gives `"3"`. */
  revOf(doc: T): string;
};

/** The seal hash: canonical JSON of the document without its top-level `approved` block. */
export function sealHash(doc: unknown): string {
  if (doc !== null && typeof doc === "object" && !Array.isArray(doc) && "approved" in doc) {
    const rest: Record<string, unknown> = { ...doc };
    delete rest.approved;
    return hashJson(rest);
  }
  return hashJson(doc);
}

/** The document's `approved` block, if it has one. */
export function approvedBlock(doc: unknown): unknown {
  return doc !== null && typeof doc === "object" && "approved" in doc ? doc.approved : undefined;
}

/**
 * Checks a sealed file against its index lines. The hash must match, and an `approved` block
 * must match its `approved` index line. Why: the hash skips `approved`, so a hand-added
 * approval is caught only here.
 */
export function checkSealed(
  doc: unknown,
  sealed: IndexLine,
  approvedLine: IndexLine | undefined,
): Outcome<{ by: string; at: string } | null, "hash_mismatch"> {
  if (sealHash(doc) !== sealed.hash)
    return fail("hash_mismatch", `${sealed.path} changed after sealing`);
  const block = approvedBlock(doc);
  if (block === undefined && approvedLine === undefined) return ok(null);
  if (
    approvedLine !== undefined &&
    block !== null &&
    typeof block === "object" &&
    "by" in block &&
    "at" in block &&
    block.by === approvedLine.by &&
    block.at === approvedLine.at
  ) {
    return ok({ by: approvedLine.by, at: approvedLine.at });
  }
  return fail("hash_mismatch", `${sealed.path} approval does not match the index`);
}

/** Checks a document is fit to be a candidate: it passes its schema and carries no approval. */
export function checkCandidate<T>(kind: DocKind<T>, doc: unknown): Outcome<T, "invalid"> {
  const parsed = kind.schema.safeParse(doc);
  if (!parsed.success)
    return fail(
      "invalid",
      parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
    );
  if (approvedBlock(doc) !== undefined) return fail("invalid", "a candidate has no approved block");
  return ok(parsed.data);
}

/** Checks one approval: once only, and never by the sealer (section 9 §6.4, four eyes). */
export function checkApprove(
  sealedBy: string,
  staff: string,
  approved: unknown,
): Outcome<void, "rule"> {
  if (approved !== null) return fail("rule", "already_approved");
  if (staff === sealedBy) return fail("rule", "four_eyes");
  return ok(undefined);
}

/** Finds the last index line for one event on one revision. */
export function findLine(
  lines: readonly IndexLine[],
  event: IndexLine["event"],
  id: string,
  rev: string,
): IndexLine | undefined {
  return lines.findLast((l) => l.event === event && l.id === id && l.rev === rev);
}
