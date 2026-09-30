// The fake operator port: answers from a script, in memory. Follows design section 9 §5.4
// (adapters: mailbox, scripted, fake for unit tests) and §5.9 (fake twins).
import type { Masked } from "../ports/masked.js";
import type { Handle, Intervention, OperatorEvent, OperatorPort } from "../ports/operator.js";
import { fail, ok, type Outcome } from "../ports/outcome.js";

/** One scripted answer: a decision word, or `silent` to wait until the deadline or the run's end. */
export type FakeAnswer = { staff: string; decision: string } | "silent";

/** Answers requests in order. Past the end of the script, the operator ends the run. */
export class FakeOperator implements OperatorPort {
  /** Every request it was sent, in order. */
  readonly requests: Masked<Intervention>[] = [];
  /** How each request closed, by index. */
  readonly closed: string[] = [];
  #next = 0;

  constructor(private readonly answers: readonly FakeAnswer[] = []) {}

  open(req: Masked<Intervention>): Promise<Outcome<Handle, "write_failed">> {
    this.requests.push(req);
    // Why a cast: the Handle brand has no runtime form.
    return Promise.resolve(ok(String(this.requests.length - 1) as unknown as Handle));
  }

  next(h: Handle, signal?: AbortSignal): Promise<Outcome<OperatorEvent, "closed">> {
    const a = this.answers[this.#next] ?? this.#fallback(h);
    this.#next += 1;
    if (a !== "silent") return Promise.resolve(ok({ kind: "decided", ...a }));
    return new Promise((resolve) => {
      signal?.addEventListener(
        "abort",
        () => {
          resolve(fail("closed"));
        },
        { once: true },
      );
    });
  }

  close(h: Handle, how: "resolved" | "timed_out" | "run_ended"): Promise<void> {
    this.closed[Number(h)] = how;
    return Promise.resolve();
  }

  /** Past the end of the script: every kind still ends the run, except a `start_confirmation`
   * (section 7 §4 step 6, M05), which a test that scripts nothing for it still wants to run, not
   * decline unscripted. A test that wants a declined or timed-out confirmation scripts it.
   * `retry_decision` and `reconciliation_decision` (docs/decisions.md, M06) take their own safe
   * word, since `end_run` is not one of their allowed decisions. */
  #fallback(h: Handle): FakeAnswer {
    const req = this.requests[Number(h)];
    if (req?.kind === "start_confirmation") return { staff: "op_017", decision: "approved" };
    if (req?.kind === "retry_decision") return { staff: "op_017", decision: "no_retry" };
    if (req?.kind === "reconciliation_decision") return { staff: "op_017", decision: "not_found" };
    return { staff: "op_017", decision: "end_run" };
  }
}
