// The shared lookup behind the table classifier and the table reviewer. A table is a list of
// rows. A row says when it matches (step, fault style, or input hash) and what it answers.
// Follows design section 5 §10.9 (the CI fake), section 9 §5.3 (model call order) and §5.9.
import { createHash } from "node:crypto";
import type { z } from "zod";
import type { CallFailure, CallRecorder, ModelFailure } from "../ports/models.js";
import { fail, ok, type Outcome } from "../ports/outcome.js";

/** When a row matches. Every key given must match. An empty `when` matches every call. */
export type When = {
  /** The failed step's ID (for a reconciliation call: the commit step's ID). */
  step?: string;
  /** The fault style on screen, as the test reports it through `styleOf`. */
  style?: string;
  /** The input's hash, from {@link inputHash}. Pins one exact screen. */
  hash?: string;
};

/** What a row answers: a canned answer, a model failure, or raw output that must pass the schema. */
export type Reply<R> = { answer: R } | { failure: ModelFailure } | { raw: unknown };

/** One table row. `times` caps how often it answers; without it, it answers every matching call. */
export type Row<R> = { when: When; reply: Reply<R>; times?: number };

/** The request bytes the fake records for an input: the input as JSON (what the adapter would send). */
export function requestBytes(input: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(input));
}

/** The hash a row's `when.hash` names: SHA-256 of the request bytes, as `sha256:<hex>`. */
export function inputHash(input: unknown): string {
  return `sha256:${createHash("sha256").update(requestBytes(input)).digest("hex")}`;
}

/** An ordered table of rows for one call kind. */
export class Table<R> {
  readonly #rows: Row<R>[];
  readonly #left: (number | undefined)[];

  constructor(
    rows: readonly Row<R>[],
    private readonly what: string,
  ) {
    this.#rows = [...rows];
    this.#left = rows.map((r) => r.times);
  }

  /**
   * Records the request, then answers from the first matching row. A call no row matches throws:
   * a test must never quietly depend on a model (section 5 §10.9).
   */
  async call(
    input: unknown,
    step: string,
    style: string | undefined,
    record: CallRecorder,
    schema: z.ZodType<R>,
  ): Promise<Outcome<R, CallFailure>> {
    // Why: section 9 §5.3, the stored copy is the sent copy, so the write comes first.
    if (!(await record("request", requestBytes(input)))) return fail("write_failed");
    const hash = inputHash(input);
    const i = this.#rows.findIndex((r, k) => {
      const { when } = r;
      return (
        (this.#left[k] ?? 1) > 0 &&
        (when.step === undefined || when.step === step) &&
        (when.style === undefined || when.style === style) &&
        (when.hash === undefined || when.hash === hash)
      );
    });
    const row = this.#rows[i];
    if (row === undefined)
      throw new Error(
        `unscripted ${this.what} call: step ${step}, style ${style ?? "none"}, ${hash}`,
      );
    const left = this.#left[i];
    if (left !== undefined) this.#left[i] = left - 1;
    const reply = row.reply;
    if ("failure" in reply) return fail(reply.failure);
    // Why: a real adapter checks the provider's output against the core's schema and reports
    // `invalid_output` (section 9 §5.3). The twin does the same, so bad output is testable.
    const checked = schema.safeParse("answer" in reply ? reply.answer : reply.raw);
    if (!checked.success) return fail("invalid_output");
    if (!(await record("reply", requestBytes(checked.data)))) return fail("write_failed");
    return ok(checked.data);
  }
}
