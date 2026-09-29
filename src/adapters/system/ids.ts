// The real ID source: the clock's date plus secure random bytes.
// Follows design section 3 §7.2 and section 9 §5.7.
import { randomBytes } from "node:crypto";
import { formatId, ID_RANDOM_CHARS, type IdKind } from "../../core/model/ids.js";
import type { Clock, Ids } from "../../ports/clock.js";

/** IDs from `crypto.randomBytes`. The date comes from the clock, in UTC. */
export class SystemIds implements Ids {
  readonly #clock: Clock;

  /** Uses `clock` for the date part. */
  constructor(clock: Clock) {
    this.#clock = clock;
  }

  /** A new run ID, like `run_2026-09-24_7kq2m9x4tb`. */
  runId(): string {
    return this.#make("run");
  }

  /** A new batch ID. */
  batchId(): string {
    return this.#make("batch");
  }

  /** A new lease token. */
  leaseToken(): string {
    return this.#make("lease");
  }

  /** A new alert ID. */
  alertId(): string {
    return this.#make("alert");
  }

  /** A new candidate ID. */
  candidateId(): string {
    return this.#make("cand");
  }

  #make(kind: IdKind): string {
    return formatId(kind, this.#clock.now(), randomBytes(ID_RANDOM_CHARS));
  }
}
