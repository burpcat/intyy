// The lock rules: exclusive create, order, parent sharing, stale locks, and bounded waits.
// Follows design section 9 §12. Storage is a small slot interface, so files and memory share one rule set.
import type { Clock } from "../../ports/clock.js";
import type { LockHold, LockInfo, LockKind, LockRequest, Locks } from "../../ports/locks.js";
import { fail, ok, type Outcome } from "../../ports/outcome.js";

/** Where lock records live. A file folder in the build; memory in tests. */
export interface LockSlots {
  /** Creates the lock only if it is absent. False when another record is there. Never half-written. */
  create(kind: LockKind, key: string, info: LockInfo): Promise<boolean>;
  /** Reads a lock. `null` when absent; `unreadable` when the record does not parse. */
  read(kind: LockKind, key: string): Promise<LockInfo | "unreadable" | null>;
  /** Removes a lock. Absent is fine. */
  remove(kind: LockKind, key: string): Promise<void>;
}

/** Facts about this process that stale checks need. */
export type LockEnv = {
  host: string;
  pid: number;
  /** True when process `pid` on this host still runs. */
  isAlive(pid: number): boolean;
};

/** How often a waiting taker looks again. */
export const LOCK_POLL_MS = 200;

/** Lock order: instance, then run, then score (section 9 §12.3). */
const ORDER: Record<LockKind, number> = { instance: 0, run: 1, score: 2 };

/** The lock port over any slot storage. One manager per process. */
export class LockManager implements Locks {
  readonly #slots: LockSlots;
  readonly #clock: Clock;
  readonly #env: LockEnv;
  #held: LockHold[] = [];

  /** A manager for this process. */
  constructor(slots: LockSlots, clock: Clock, env: LockEnv) {
    this.#slots = slots;
    this.#clock = clock;
    this.#env = env;
  }

  /**
   * Takes a lock, or returns `busy` after `waitMs`. Throws when the order rule is broken: that is
   * a bug, and no deadlock can form while the rule holds (section 9 §12.3).
   */
  async acquire(
    kind: LockKind,
    key: string,
    req: LockRequest,
    signal?: AbortSignal,
  ): Promise<Outcome<LockHold, "busy">> {
    this.#checkOrder(kind);
    const deadline = this.#clock.now().getTime() + req.waitMs;
    let cleared: LockInfo | null = null;
    for (;;) {
      if (await this.#slots.create(kind, key, this.#info(req)))
        return ok(this.#hold({ kind, key, owner: req.owner, shared: false, cleared }));
      const holder = await this.#slots.read(kind, key);
      if (holder === null) continue; // Why: released between our create and our read. Try again at once.
      if (holder !== "unreadable") {
        if (req.parent !== undefined && holder.owner === req.parent) {
          return ok(this.#hold({ kind, key, owner: req.owner, shared: true, cleared }));
        }
        if (holder.host === this.#env.host && !this.#env.isAlive(holder.pid)) {
          await this.#slots.remove(kind, key);
          cleared = holder;
          continue;
        }
      }
      const left = deadline - this.#clock.now().getTime();
      if (left <= 0) return fail("busy", describe(holder));
      await this.#clock.after(Math.min(LOCK_POLL_MS, left), signal);
    }
  }

  /** Releases a hold. A shared hold leaves the parent's lock in place. */
  async release(hold: LockHold): Promise<void> {
    this.#held = this.#held.filter((h) => h !== hold);
    if (hold.shared) return;
    const current = await this.#slots.read(hold.kind, hold.key);
    // Why: never remove a lock someone else took after a stale clear.
    if (
      current !== null &&
      current !== "unreadable" &&
      current.owner === hold.owner &&
      current.pid === this.#env.pid
    ) {
      await this.#slots.remove(hold.kind, hold.key);
    }
  }

  /** Reads a lock without taking it. An unreadable record reads as absent here. */
  async inspect(kind: LockKind, key: string): Promise<LockInfo | null> {
    const info = await this.#slots.read(kind, key);
    return info === "unreadable" ? null : info;
  }

  /** Removes a lock unconditionally, whatever host or process holds it (section 9 §10.7). */
  async forceRelease(kind: LockKind, key: string): Promise<LockInfo | null> {
    const info = await this.#slots.read(kind, key);
    if (info === null) return null;
    await this.#slots.remove(kind, key);
    return info === "unreadable" ? null : info;
  }

  #checkOrder(kind: LockKind): void {
    for (const h of this.#held) {
      if (h.kind === "score")
        throw new Error("lock order: the score lock never waits on another lock");
      if (ORDER[h.kind] > ORDER[kind]) throw new Error(`lock order: ${kind} after ${h.kind}`);
    }
  }

  #info(req: LockRequest): LockInfo {
    return {
      schema: "intyy.lock/1.0",
      owner: req.owner,
      pid: this.#env.pid,
      host: this.#env.host,
      command: req.command,
      staff: req.staff,
      started_at: this.#clock.now().toISOString(),
    };
  }

  #hold(h: LockHold): LockHold {
    this.#held.push(h);
    return h;
  }
}

/** Names the holder for standard error: command, staff ID, and start time (section 9 §12.2). */
function describe(holder: LockInfo | "unreadable"): string {
  if (holder === "unreadable") return "held; the lock file is unreadable";
  return `held by ${holder.command}, staff ${holder.staff ?? "none"}, since ${holder.started_at} (${holder.owner} on ${holder.host})`;
}
