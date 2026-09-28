// Small record kinds for the store contract suites. Design section 9 §5.8 (typed per record kind).
import { z } from "zod";
import type { Masked } from "../../src/ports/masked.js";
import type { DocKind } from "../../src/core/model/sealing.js";
import { Approval } from "../../src/core/model/store-index.js";

/** A document kind shaped like policy: a schema tag, a revision, and an optional approval. */
export const TestDoc = z
  .object({
    schema: z.literal("test.doc/1.0"),
    revision: z.number().int().positive(),
    body: z.string(),
    tags: z.array(z.string()).optional(),
    approved: Approval.optional(),
  })
  .strict();

/** A test document. */
export type TestDoc = z.infer<typeof TestDoc>;

/** The test kind the document store suite uses. */
export const testKind: DocKind<TestDoc> = {
  name: "test",
  schema: TestDoc,
  revOf: (d) => String(d.revision),
};

/** Makes a test document. */
export function doc(revision: number, body = "hello"): TestDoc {
  return { schema: "test.doc/1.0", revision, body };
}

/** A candidate folder's files, for the candidate store suite. */
export const CandidateFiles = {
  "runs.json": z.object({ runs: z.array(z.string()) }).strict(),
  "candidate.json": z.object({ steps: z.number().int() }).strict(),
};

/** The candidate files' types. */
export type CandidateFiles = {
  [K in keyof typeof CandidateFiles]: z.infer<(typeof CandidateFiles)[K]>;
};

/** One review decision. */
export const Decision = z.object({ by: z.string(), decision: z.string() }).strict();

/** A review decision. */
export type Decision = z.infer<typeof Decision>;

/** One log line, for the log store suite. */
export const LogLine = z.object({ n: z.number().int() }).strict();

/** A log line. */
export type LogLine = z.infer<typeof LogLine>;

/** One rebuilt record. */
export const LogRecord = z.object({ total: z.number().int() }).strict();

/** A rebuilt record. */
export type LogRecord = z.infer<typeof LogRecord>;

/** Marks test data as masked. Why a cast: tests stand in for the redaction module. */
export function masked<T>(value: T): Masked<T> {
  return value as Masked<T>;
}
