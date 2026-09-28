// The run log writer: numbers each line, stamps its time and run ID, and masks it before the
// write. Follows design section 3 §6.1 (one JSON line each), §6.4 (event types), §6.5 (the first
// line), §6.6 (durable writes), and §6.7 (the redactor sits inside the log writer).
import type { Clock } from "../../ports/clock.js";
import type { RunFolder } from "../../ports/stores.js";
import { fact, type Redactor } from "../safety/redaction/redactor.js";

/** Who wrote a line. */
export type By = "engine" | "gate" | "llm" | "human" | "handler" | "reviewer";

/** One log line before its header. `data` may hold raw text; the writer masks it. */
export type LogLine = {
  event: string;
  step: string | null;
  by: By;
  why?: unknown;
  data: unknown;
};

/** Writes the run's `events.jsonl`. A failed write is sticky: every later write fails too. */
export class RunLog {
  #seq = 0;
  #failed = false;
  /** Why a chain: the gate logs without waiting, so writes must still land in `seq` order. */
  #chain: Promise<boolean> = Promise.resolve(true);

  constructor(
    private readonly folder: RunFolder,
    private readonly redactor: Redactor,
    private readonly clock: Clock,
  ) {}

  /** The number the next line gets. Capture file names use it (section 3 §7.4). */
  get nextSeq(): number {
    return this.#seq + 1;
  }

  /** True once any write failed. The run must stop: `evidence_write_failed`. */
  get failed(): boolean {
    return this.#failed;
  }

  /**
   * Appends one line. Every string passes the redactor, so a value in a reason or a path leaves
   * as its reference or token (section 3 §6.7). Returns false when the write failed.
   */
  append(line: LogLine, durable = false): Promise<boolean> {
    this.#seq += 1;
    const full = {
      seq: this.#seq,
      at: fact(this.clock.now().toISOString()),
      run_id: fact(this.folder.runId),
      ...line,
    };
    const masked = this.redactor.value(full);
    this.#chain = this.#chain.then(async () => {
      if (this.#failed) return false;
      const w = await this.folder.appendEvent(masked, durable ? { durable } : {});
      if (!w.ok) this.#failed = true;
      return w.ok;
    });
    return this.#chain;
  }
}
