// The clock and ID ports. Core reads time and randomness only through these.
// Follows design section 9 §5.7 and section 3 §7.2 (run ID format).

/** The clock. Waits still end on state (section 7 §2.1); timers serve polls and deadlines only. */
export interface Clock {
  /** The current time. */
  now(): Date;
  /** Resolves after `ms` milliseconds, or rejects when `signal` aborts. */
  after(ms: number, signal?: AbortSignal): Promise<void>;
}

/** New IDs. Example run ID: `run_2026-09-24_7kq2m9x4tb` (section 3 §7.2). */
export interface Ids {
  /** A run ID: `run_` + UTC date + `_` + 10 Crockford base32 characters. */
  runId(): string;
  /** A batch ID, same shape with `batch_`. */
  batchId(): string;
  /** A lease token, same shape with `lease_`. */
  leaseToken(): string;
  /** An alert ID, same shape with `alert_`. */
  alertId(): string;
  /** A candidate ID, same shape with `cand_` (docs/decisions.md, M04). */
  candidateId(): string;
}
