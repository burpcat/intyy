// Shared helpers for the handoff tests: a clock whose operator deadlines never end by themselves.
// Not a test file. Follows design section 7 §12 to §15 (the run the helpers drive).
import { SteppingClock } from "../../../src/fakes/clock.js";

/**
 * A stepping clock whose long waits (an operator deadline, one minute or more) never end on their
 * own, only when aborted. The fake operator's `silent` request would otherwise time out at once.
 * Short waits (a poll, the watcher's one second) yield to the event loop first, then step the
 * time. Why: the watcher loops on `after`, and a wait that resolves in a microtask would starve
 * the test's own timers.
 */
export class HoldingClock extends SteppingClock {
  override async after(ms: number, signal?: AbortSignal): Promise<void> {
    if (ms >= 60_000) {
      return new Promise((_resolve, reject) => {
        if (signal?.aborted === true) reject(signal.reason as Error);
        signal?.addEventListener(
          "abort",
          () => {
            reject(signal.reason as Error);
          },
          { once: true },
        );
      });
    }
    await new Promise<void>((r) => setImmediate(r));
    return super.after(ms, signal);
  }
}
