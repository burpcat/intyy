// Settling after a replay action: wait for a navigation, then for network quiet.
// Follows design section 7 §2.1 (wait for state, never for time), §5.1 (settle after an action).
import type { Clock } from "../../ports/clock.js";
import type { SurfaceEvent } from "../../ports/surface.js";

/** A `request_started` or `request_done` event, tagged by resource kind (section 7 §5.1). */
type RequestEvent = Extract<SurfaceEvent, { kind: "request_started" | "request_done" }>;

/** No data request in flight for this long counts as quiet (section 7 §5.1). */
export const QUIET_MS = 500;
/** Quiet never waits past this, even if a request never finishes (section 7 §5.1). */
export const QUIET_CAP_MS = 3_000;
/** How long after the action a navigation may still start and count (section 7 §5.1). */
export const NAV_GRACE_MS = 500;

/**
 * Waits for one event or a clock deadline, whichever comes first (section 7 §2.1: no fixed
 * sleeps). Keeps exactly one `iter.next()` outstanding across calls, so no event is skipped:
 * a call that times out leaves that same pending read for the next call to pick up.
 */
function nextOrDeadline(
  iter: AsyncIterator<SurfaceEvent>,
  pending: { next: Promise<IteratorResult<SurfaceEvent>> },
  deadlineMs: number,
  clock: Clock,
  signal: AbortSignal | undefined,
): Promise<SurfaceEvent | "timeout"> {
  const remaining = Math.max(0, deadlineMs - clock.now().getTime());
  const ctrl = new AbortController();
  const onAbort = (): void => {
    ctrl.abort();
  };
  signal?.addEventListener("abort", onAbort);
  const timer = clock.after(remaining, ctrl.signal).then(
    () => "timeout" as const,
    () => "timeout" as const,
  );
  const ev = pending.next.then((r) => (r.done === true ? "timeout" as const : r.value));
  return Promise.race([ev, timer]).then((first) => {
    ctrl.abort();
    signal?.removeEventListener("abort", onAbort);
    if (first !== "timeout") pending.next = iter.next();
    return first;
  });
}

/** Tracks `data` requests in flight, and when one last started or finished. A `static` request
 * never counts (section 4 §6.8, docs/decisions.md M05). */
class RequestTracker {
  inFlight = 0;
  lastActivity: number;

  constructor(now: number) {
    this.lastActivity = now;
  }

  see(e: RequestEvent, now: number): void {
    if (e.resource !== "data") return;
    this.lastActivity = now;
    this.inFlight = Math.max(0, this.inFlight + (e.kind === "request_started" ? 1 : -1));
  }
}

/**
 * Settles after a replay action (section 7 §5.1). `events` must already be subscribed from
 * before the action dispatched, so no early event is lost. This call always keeps one read of
 * `events` outstanding, waiting on a real event that may never come; it never closes the
 * subscription itself, so the caller's own signal, or the session closing, must end it.
 * 1. If a navigation starts within {@link NAV_GRACE_MS}, waits for it to finish, up to
 *    `stepTimeoutMs`. A finished navigation drops any request the old page had open.
 * 2. Then waits for network quiet: no `data` request in flight for {@link QUIET_MS}, capped at
 *    {@link QUIET_CAP_MS}.
 */
export async function settleAfterAction(
  events: AsyncIterable<SurfaceEvent>,
  clock: Clock,
  stepTimeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  const iter = events[Symbol.asyncIterator]();
  const pending = { next: iter.next() };
  const next = (deadlineMs: number): Promise<SurfaceEvent | "timeout"> =>
    nextOrDeadline(iter, pending, deadlineMs, clock, signal);
  let requests = new RequestTracker(clock.now().getTime());
  const see = (e: SurfaceEvent): void => {
    if (e.kind === "request_started" || e.kind === "request_done") requests.see(e, clock.now().getTime());
  };

  // 1. A navigation starting within the grace window.
  const graceEnd = clock.now().getTime() + NAV_GRACE_MS;
  let navigating = false;
  for (;;) {
    const e = await next(graceEnd);
    if (e === "timeout") break;
    see(e);
    if (e.kind === "navigation_started") {
      navigating = true;
      break;
    }
  }
  if (navigating) {
    const loadDeadline = clock.now().getTime() + stepTimeoutMs;
    for (;;) {
      const e = await next(loadDeadline);
      if (e === "timeout") break;
      see(e);
      if (e.kind === "navigation_done") break;
    }
    // Why: a fresh page starts its own requests; the old page's are moot.
    requests = new RequestTracker(clock.now().getTime());
  }
  // Why: the quiet gap counts from here, not from before the action. With nothing in flight,
  // "quiet" must still hold for the full gap from this moment on.
  if (requests.inFlight === 0) requests.lastActivity = clock.now().getTime();

  // 2. Quiet: no `data` request in flight for QUIET_MS, capped at QUIET_CAP_MS.
  const cap = clock.now().getTime() + QUIET_CAP_MS;
  for (;;) {
    const now = clock.now().getTime();
    if (now >= cap) break;
    const quiet = requests.inFlight === 0 && now >= requests.lastActivity + QUIET_MS;
    if (quiet) break;
    const deadline = requests.inFlight === 0 ? Math.min(cap, requests.lastActivity + QUIET_MS) : cap;
    const e = await next(deadline);
    if (e !== "timeout") see(e);
  }
}
