// Proves settling stops when it can wait no longer (design section 7 §5.1; section 6 §10.4; section
// 9 §5.7): an abort, or a stream that closes, ends `settleAfterAction` at once and without a throw.
// Before the fix, a stream that ended on abort read as a timeout and the quiet loop spun forever
// on a frozen clock. The timeouts here are short, so a hang fails fast. Regression cases keep the
// normal settle and the timeout paths as they were.
import { describe, expect, test, vi } from "vitest";
import { EventHub } from "../../../src/core/events/hub.js";
import { NAV_GRACE_MS, QUIET_MS, settleAfterAction } from "../../../src/core/replay/settle.js";
import { ManualClock } from "../../../src/fakes/clock.js";
import type { SurfaceEvent } from "../../../src/ports/surface.js";

/** Lets every already-queued microtask run, so a promise chain a few `.then`s deep settles. */
async function flush(): Promise<void> {
  for (let i = 0; i < 30; i += 1) await Promise.resolve();
}

/** Starts a settle, on a clock the test moves by hand, and reports when it resolves. */
function start(
  events: AsyncIterable<SurfaceEvent>,
  clock: ManualClock,
  signal?: AbortSignal,
): { settled: () => boolean; promise: Promise<void> } {
  let done = false;
  const promise = settleAfterAction(events, clock, 5_000, signal).then(() => {
    done = true;
  });
  return { settled: () => done, promise };
}

const FAST = 2_000;

describe("settleAfterAction ends on abort or a closed stream", () => {
  test("an abort during the grace wait resolves on a frozen clock; the clock never advanced", async () => {
    const hub = new EventHub<SurfaceEvent>();
    const clock = new ManualClock();
    const begin = clock.now().getTime();
    const ctl = new AbortController();
    const r = start(hub.subscribe(ctl.signal), clock, ctl.signal);

    await flush();
    expect(r.settled()).toBe(false);
    ctl.abort();
    await r.promise;
    expect(clock.now().getTime()).toBe(begin);
    expect(clock.waiting).toBe(0);
  }, FAST);

  test("an abort while a navigation is loading resolves on a frozen clock", async () => {
    const hub = new EventHub<SurfaceEvent>();
    const clock = new ManualClock();
    const begin = clock.now().getTime();
    const ctl = new AbortController();
    const r = start(hub.subscribe(ctl.signal), clock, ctl.signal);

    await flush();
    hub.emit({ kind: "navigation_started", url: "/next" });
    await flush();
    expect(r.settled()).toBe(false);
    ctl.abort();
    await r.promise;
    expect(clock.now().getTime()).toBe(begin);
  }, FAST);

  test("an abort while waiting out network quiet resolves without another clock advance", async () => {
    const hub = new EventHub<SurfaceEvent>();
    const clock = new ManualClock();
    const ctl = new AbortController();
    const r = start(hub.subscribe(ctl.signal), clock, ctl.signal);

    await flush();
    clock.advance(NAV_GRACE_MS);
    const afterGrace = clock.now().getTime();
    await flush();
    hub.emit({ kind: "request_started", url: "/x", resource: "data" });
    await flush();
    expect(r.settled()).toBe(false);
    ctl.abort();
    await r.promise;
    expect(clock.now().getTime()).toBe(afterGrace);
  }, FAST);

  test("an abort resolves even when the stream itself does not end", async () => {
    const hub = new EventHub<SurfaceEvent>();
    const clock = new ManualClock();
    const ctl = new AbortController();
    // No signal given to `subscribe`: only `settleAfterAction` sees the abort.
    const r = start(hub.subscribe(), clock, ctl.signal);

    await flush();
    ctl.abort();
    await r.promise;
    expect(r.settled()).toBe(true);
  }, FAST);

  test("a signal already aborted before the call resolves at once and reads no event", async () => {
    const clock = new ManualClock();
    const ctl = new AbortController();
    ctl.abort();
    // A stream that never yields and counts its reads: the settle must not wait on it.
    const next = vi.fn(() => new Promise<IteratorResult<SurfaceEvent>>(() => undefined));
    const never: AsyncIterable<SurfaceEvent> = { [Symbol.asyncIterator]: () => ({ next }) };
    const r = start(never, clock, ctl.signal);

    await r.promise;
    expect(clock.waiting).toBe(0);
    // At most the one priming read the settle opens up front; never a second.
    expect(next.mock.calls.length).toBeLessThanOrEqual(1);
  }, FAST);

  test("a stream that closes mid-wait, with no abort, resolves instead of spinning", async () => {
    const hub = new EventHub<SurfaceEvent>();
    const clock = new ManualClock();
    const begin = clock.now().getTime();
    const r = start(hub.subscribe(), clock);

    await flush();
    expect(r.settled()).toBe(false);
    hub.end();
    await r.promise;
    expect(clock.now().getTime()).toBe(begin);
  }, FAST);

  test("a stream that closes while waiting out network quiet resolves", async () => {
    const hub = new EventHub<SurfaceEvent>();
    const clock = new ManualClock();
    const r = start(hub.subscribe(), clock);

    await flush();
    clock.advance(NAV_GRACE_MS);
    await flush();
    hub.emit({ kind: "request_started", url: "/x", resource: "data" });
    await flush();
    hub.end();
    await r.promise;
    expect(r.settled()).toBe(true);
  }, FAST);
});

describe("settleAfterAction regressions with a live signal", () => {
  test("a navigation and then quiet still settles", async () => {
    const hub = new EventHub<SurfaceEvent>();
    const clock = new ManualClock();
    const ctl = new AbortController();
    const r = start(hub.subscribe(ctl.signal), clock, ctl.signal);

    await flush();
    hub.emit({ kind: "navigation_started", url: "/next" });
    await flush();
    hub.emit({ kind: "navigation_done", url: "/next" });
    await flush();
    expect(r.settled()).toBe(false); // the quiet gap is still to wait out
    clock.advance(QUIET_MS);
    await flush();
    expect(r.settled()).toBe(true);
  }, FAST);

  test("the grace wait still ends on its timeout", async () => {
    const hub = new EventHub<SurfaceEvent>();
    const clock = new ManualClock();
    const ctl = new AbortController();
    const r = start(hub.subscribe(ctl.signal), clock, ctl.signal);

    await flush();
    clock.advance(NAV_GRACE_MS);
    await flush();
    expect(r.settled()).toBe(false); // the grace passed; the quiet gap is next
    clock.advance(QUIET_MS);
    await flush();
    expect(r.settled()).toBe(true);
  }, FAST);

  test("a load that never finishes still ends at the step timeout", async () => {
    const hub = new EventHub<SurfaceEvent>();
    const clock = new ManualClock();
    const ctl = new AbortController();
    const r = start(hub.subscribe(ctl.signal), clock, ctl.signal);

    await flush();
    hub.emit({ kind: "navigation_started", url: "/slow" });
    await flush();
    clock.advance(5_000); // the step timeout: the load wait gives up
    await flush();
    clock.advance(QUIET_MS);
    await flush();
    expect(r.settled()).toBe(true);
  }, FAST);
});
