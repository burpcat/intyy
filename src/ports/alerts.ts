// The alert store port: one small file per alert, at `state/trust/alerts/<id>.json`.
// Follows design section 8 §13.1 (alert format) and section 9 §6.3 (`state/trust/`).
import type { Outcome } from "./outcome.js";

/**
 * Alerts by ID. `A` is the alert type. An alert changes in place (open, then acted or dismissed),
 * so `put` replaces the whole file. Readers never lock: alerts are advice, never a gate.
 */
export interface AlertStore<A> {
  /** Writes or replaces one alert atomically. */
  put(id: string, alert: A, signal?: AbortSignal): Promise<Outcome<void, "write_failed">>;
  /** Reads one alert. */
  get(id: string, signal?: AbortSignal): Promise<Outcome<A, "not_found" | "invalid">>;
  /** Reads every alert, sorted by ID (oldest first, since an ID starts with its date). */
  list(signal?: AbortSignal): Promise<Outcome<A[], "invalid">>;
}
