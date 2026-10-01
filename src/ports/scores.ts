// The score store port: per key, an append-only history, a rebuilt record, and a key listing.
// Follows design section 8 §5.2 (three files per key) and section 9 §6.3 (`state/trust/scores/`).
import type { Outcome } from "./outcome.js";

/**
 * Score files by key path. A key path is `<tenant>/<app>/<capability>@<version>/<app_version>/<patch>`,
 * with `<patch>` `base` or `p3` (section 9 §6.3); core builds it. `H` is a history line, `R` the record.
 * Live lines (`live.jsonl`) join this port in M11. Readers never lock; a writer takes the score lock first.
 */
export interface ScoreStore<H, R> {
  /** Appends one line to `history.jsonl`. */
  append(path: string, line: H, signal?: AbortSignal): Promise<Outcome<void, "write_failed">>;
  /** Reads every history line, in order. An absent log is empty. */
  history(path: string, signal?: AbortSignal): Promise<Outcome<H[], "invalid">>;
  /** Replaces `record.json` whole and atomically, staged in `state/var/tmp`. */
  putRecord(path: string, record: R, signal?: AbortSignal): Promise<Outcome<void, "write_failed">>;
  /** Reads `record.json`. */
  getRecord(path: string, signal?: AbortSignal): Promise<Outcome<R, "not_found" | "invalid">>;
  /** Every key path of one tenant that holds any score file, sorted. */
  paths(tenant: string, signal?: AbortSignal): Promise<string[]>;
}
