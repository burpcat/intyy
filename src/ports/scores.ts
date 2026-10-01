// The score store port: per key, an append-only history, a rebuilt record, and a key listing.
// Follows design section 8 §5.2 (three files per key) and section 9 §6.3 (`state/trust/scores/`).
import type { Outcome } from "./outcome.js";

/**
 * Score files by key path. A key path is `<tenant>/<app>/<capability>@<version>/<app_version>/<patch>`,
 * with `<patch>` `base` or `p3` (section 9 §6.3); core builds it. `H` is a history line, `R` the record.
 * `L` is a live line (`live.jsonl`, section 8 §5.5): one line per real run, append only.
 * Readers never lock; a writer takes the score lock first.
 */
export interface ScoreStore<H, R, L = unknown> {
  /** Appends one line to `history.jsonl`. */
  append(path: string, line: H, signal?: AbortSignal): Promise<Outcome<void, "write_failed">>;
  /** Reads every history line, in order. An absent log is empty. */
  history(path: string, signal?: AbortSignal): Promise<Outcome<H[], "invalid">>;
  /** Appends one line to `live.jsonl`. */
  appendLive(path: string, line: L, signal?: AbortSignal): Promise<Outcome<void, "write_failed">>;
  /** Reads every live line, in order. An absent log is empty. */
  liveLines(path: string, signal?: AbortSignal): Promise<Outcome<L[], "invalid">>;
  /**
   * Replaces `live.jsonl` whole and atomically, staged in `state/var/tmp`. Only `trust rebuild
   * --from-evidence` uses it (section 9 §9.8); every run appends.
   */
  putLive(path: string, lines: readonly L[], signal?: AbortSignal): Promise<Outcome<void, "write_failed">>;
  /** Replaces `record.json` whole and atomically, staged in `state/var/tmp`. */
  putRecord(path: string, record: R, signal?: AbortSignal): Promise<Outcome<void, "write_failed">>;
  /** Reads `record.json`. */
  getRecord(path: string, signal?: AbortSignal): Promise<Outcome<R, "not_found" | "invalid">>;
  /** Every key path of one tenant that holds any score file, sorted. */
  paths(tenant: string, signal?: AbortSignal): Promise<string[]>;
}
