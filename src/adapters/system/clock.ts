// The real clock: system time and Node timers.
// Follows design section 9 §5.7.
import { setTimeout as sleep } from "node:timers/promises";
import type { Clock } from "../../ports/clock.js";

/** The system clock. */
export class SystemClock implements Clock {
  /** The current system time. */
  now(): Date {
    return new Date();
  }

  /** Resolves after `ms`, or rejects when `signal` aborts. */
  async after(ms: number, signal?: AbortSignal): Promise<void> {
    await sleep(ms, undefined, signal ? { signal } : {});
  }
}
