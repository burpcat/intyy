// A small fan-out queue for surface events. The Playwright adapter and the snapshot fake share it,
// so `events()` behaves the same on both. Follows design section 9 §5.2 (`Eyes.events`) and §5.9.

/** A listener's queue and the promise it waits on. */
type Listener<E> = { queue: E[]; wake: (() => void) | null };

/**
 * Sends each event to every listener. A listener sees events from the moment it subscribes.
 * ponytail: queues are unbounded; a listener that never reads keeps every event until `end`.
 */
export class EventHub<E> {
  readonly #listeners = new Set<Listener<E>>();
  #ended = false;

  /** Sends one event to every listener. */
  emit(event: E): void {
    for (const l of this.#listeners) {
      l.queue.push(event);
      l.wake?.();
      l.wake = null;
    }
  }

  /** Ends every listener, as when the session closes. */
  end(): void {
    this.#ended = true;
    for (const l of this.#listeners) {
      l.wake?.();
      l.wake = null;
    }
  }

  /** Starts listening now. The loop ends when the hub ends or `signal` aborts. */
  subscribe(signal?: AbortSignal): AsyncIterable<E> {
    // Why: register now, not on the first read, so no event between the call and the read is lost.
    const l: Listener<E> = { queue: [], wake: null };
    this.#listeners.add(l);
    const stop = (): void => {
      l.wake?.();
      l.wake = null;
    };
    signal?.addEventListener("abort", stop);
    const listeners = this.#listeners;
    const isEnded = (): boolean => this.#ended;
    async function* read(): AsyncGenerator<E> {
      try {
        for (;;) {
          const next = l.queue.shift();
          if (next !== undefined) {
            yield next;
            continue;
          }
          if (isEnded() || signal?.aborted === true) return;
          await new Promise<void>((resolve) => {
            l.wake = resolve;
          });
        }
      } finally {
        listeners.delete(l);
        signal?.removeEventListener("abort", stop);
      }
    }
    return read();
  }
}
