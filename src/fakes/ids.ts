// The fake ID source: the same seed gives the same IDs.
// Follows design section 9 §5.7 and §5.9 (fake twins).
import { formatId, ID_RANDOM_CHARS, type IdKind } from "../core/model/ids.js";
import type { Clock, Ids } from "../ports/clock.js";

/** IDs from a seeded generator, so golden tests get the same bytes every run. */
export class SeededIds implements Ids {
  readonly #clock: Clock;
  #state: number;

  /** Uses `clock` for the date part and `seed` for the characters. */
  constructor(clock: Clock, seed = 1) {
    this.#clock = clock;
    this.#state = seed >>> 0;
  }

  /** The next run ID. */
  runId(): string {
    return this.#make("run");
  }

  /** The next batch ID. */
  batchId(): string {
    return this.#make("batch");
  }

  /** The next lease token. */
  leaseToken(): string {
    return this.#make("lease");
  }

  /** The next alert ID. */
  alertId(): string {
    return this.#make("alert");
  }

  #make(kind: IdKind): string {
    const bytes = Uint8Array.from({ length: ID_RANDOM_CHARS }, () => this.#nextByte());
    return formatId(kind, this.#clock.now(), bytes);
  }

  // Why: mulberry32, a tiny well-known generator. Test IDs need repeatable, not secure.
  #nextByte(): number {
    this.#state = (this.#state + 0x6d2b79f5) >>> 0;
    let t = this.#state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) & 0xff;
  }
}
