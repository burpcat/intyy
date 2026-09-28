// The fake clock: time moves only when a test says so.
// Follows design section 9 §5.7 and §5.9 (fake twins).
import type { Clock } from "../ports/clock.js";

/** One waiting `after` call. */
type Timer = { due: number; resolve: () => void };

/** A clock that moves only on `advance`. Golden tests need it (section 9 §5.7). */
export class ManualClock implements Clock {
  #now: number;
  #timers: Timer[] = [];

  /** Starts at `start`. The default is the bank app's fixed date (build plan §10.3). */
  constructor(start = "2026-01-15T09:00:00.000Z") {
    this.#now = Date.parse(start);
  }

  /** The fake time. */
  now(): Date {
    return new Date(this.#now);
  }

  /** Resolves when `advance` moves the clock `ms` past now. Rejects when `signal` aborts. */
  after(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(signal.reason as Error);
    return new Promise((resolve, reject) => {
      const timer: Timer = { due: this.#now + ms, resolve };
      this.#timers.push(timer);
      signal?.addEventListener(
        "abort",
        () => {
          this.#timers = this.#timers.filter((t) => t !== timer);
          reject(signal.reason as Error);
        },
        { once: true },
      );
    });
  }

  /** Moves time forward and fires every timer now due, earliest first. */
  advance(ms: number): void {
    this.#now += ms;
    const due = this.#timers.filter((t) => t.due <= this.#now).sort((a, b) => a.due - b.due);
    this.#timers = this.#timers.filter((t) => t.due > this.#now);
    for (const t of due) t.resolve();
  }

  /** How many `after` calls are waiting. Tests use it to know a waiter has started. */
  get waiting(): number {
    return this.#timers.length;
  }
}

/** A clock whose waits end at once and move time forward. Loop tests need waits that finish. */
export class SteppingClock implements Clock {
  #now: number;

  /** Starts at `start`. */
  constructor(start = "2026-01-15T09:00:00.000Z") {
    this.#now = Date.parse(start);
  }

  /** The fake time. */
  now(): Date {
    return new Date(this.#now);
  }

  /** Moves time `ms` forward and resolves. Rejects when `signal` has aborted. */
  after(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(signal.reason as Error);
    this.#now += ms;
    return Promise.resolve();
  }

  /** Moves time forward, as if a human took this long. */
  advance(ms: number): void {
    this.#now += ms;
  }
}
