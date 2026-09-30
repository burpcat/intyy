// The lock port: run, instance, and score locks, with order and stale rules.
// Follows design section 9 §5.8 (last point) and §12.
import type { Outcome } from "./outcome.js";

/** The three locks, in the order they must be taken (section 9 §12.3). */
export type LockKind = "instance" | "run" | "score";

/** What a lock file holds (`intyy.lock/1.0`, section 9 §12.1). */
export type LockInfo = {
  schema: "intyy.lock/1.0";
  /** A run ID or batch ID. */
  owner: string;
  pid: number;
  host: string;
  command: string;
  staff: string | null;
  started_at: string;
};

/** A request to take a lock. */
export type LockRequest = {
  /** The run ID or batch ID that will hold it. */
  owner: string;
  command: string;
  staff: string | null;
  /** A child run passes when this names the current holder (section 9 §12.2). */
  parent?: string;
  /** 0 fails fast. Otherwise wait up to this many milliseconds. Example: 30 000 for replay. */
  waitMs: number;
};

/** A taken lock. */
export type LockHold = {
  kind: LockKind;
  key: string;
  owner: string;
  /** True when the parent holds it. Releasing a shared hold leaves the parent's lock in place. */
  shared: boolean;
  /** The stale lock this take removed, if any. The caller logs `stale_lock_cleared`. */
  cleared: LockInfo | null;
};

/**
 * The lock port. `busy` means another holder has it; `detail` names its command, staff ID, and
 * start time. Taking a lock out of order is a bug, so it throws (section 9 §12.3).
 */
export interface Locks {
  /** Takes a lock by exclusive create. Key examples: a run ID, `http_127.0.0.1_8080`, `keystone`. */
  acquire(
    kind: LockKind,
    key: string,
    req: LockRequest,
    signal?: AbortSignal,
  ): Promise<Outcome<LockHold, "busy">>;
  /** Releases a hold. A shared hold releases nothing. */
  release(hold: LockHold): Promise<void>;
  /** Reads a lock without taking it. */
  inspect(kind: LockKind, key: string, signal?: AbortSignal): Promise<LockInfo | null>;
  /**
   * Removes a lock unconditionally: held from another machine, or unreadable, not just stale on
   * this one (section 9 §10.7, `run sweep --force-unlock`, operator role). Returns the removed
   * lock, or `null` when none was held. The caller logs the reason; this port takes none.
   */
  forceRelease(kind: LockKind, key: string, signal?: AbortSignal): Promise<LockInfo | null>;
}
