// In-memory lock slots, the fake twin of the lock files.
// Follows design section 9 §5.9 (stores and locks: in memory).
import type { LockSlots } from "../core/locks/manager.js";
import type { LockInfo, LockKind } from "../ports/locks.js";

/** Lock records in a map. Share one instance between two managers to act as two processes. */
export class MemoryLockSlots implements LockSlots {
  readonly #locks = new Map<string, LockInfo>();

  /** Creates the lock only if absent. */
  create(kind: LockKind, key: string, info: LockInfo): Promise<boolean> {
    const k = `${kind}/${key}`;
    if (this.#locks.has(k)) return Promise.resolve(false);
    this.#locks.set(k, { ...info });
    return Promise.resolve(true);
  }

  /** Reads a lock. */
  read(kind: LockKind, key: string): Promise<LockInfo | null> {
    const info = this.#locks.get(`${kind}/${key}`);
    return Promise.resolve(info ? { ...info } : null);
  }

  /** Removes a lock. */
  remove(kind: LockKind, key: string): Promise<void> {
    this.#locks.delete(`${kind}/${key}`);
    return Promise.resolve();
  }
}
