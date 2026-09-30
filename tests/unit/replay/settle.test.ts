// Proves settling after a replay action (design section 7 §5.1): waits end on state, the quiet
// cap holds, static requests never count, and no wait is a fixed sleep. M05 task 4.
import { describe, expect, test } from "vitest";
import { EventHub } from "../../../src/core/events/hub.js";
import {
  NAV_GRACE_MS,
  QUIET_CAP_MS,
  QUIET_MS,
  settleAfterAction,
} from "../../../src/core/replay/settle.js";
import { ManualClock } from "../../../src/fakes/clock.js";
import type { SurfaceEvent } from "../../../src/ports/surface.js";

/** Lets every already-queued microtask run, so a promise chain a few `.then`s deep settles. */
async function flush(): Promise<void> {
  for (let i = 0; i < 30; i += 1) await Promise.resolve();
}

/** Runs `settleAfterAction`, reporting whether it has resolved yet. */
function run(
  events: EventHub<SurfaceEvent>,
  clock: ManualClock,
  stepTimeoutMs = 5_000,
): { settled: () => boolean; promise: Promise<void> } {
  let done = false;
  const promise = settleAfterAction(events.subscribe(), clock, stepTimeoutMs).then(() => {
    done = true;
  });
  return { settled: () => done, promise };
}

describe("settleAfterAction (section 7 §5.1)", () => {
  test("with no navigation and no requests, it waits the grace, then the quiet gap", async () => {
    const hub = new EventHub<SurfaceEvent>();
    const clock = new ManualClock();
    const r = run(hub, clock);

    await flush();
    expect(r.settled()).toBe(false);
    clock.advance(NAV_GRACE_MS);
    await flush();
    expect(r.settled()).toBe(false); // the grace passed; now waiting out the quiet gap
    clock.advance(QUIET_MS);
    await flush();
    expect(r.settled()).toBe(true);
  });

  test("a data request in flight keeps it not quiet; finishing it starts the quiet gap over", async () => {
    const hub = new EventHub<SurfaceEvent>();
    const clock = new ManualClock();
    const r = run(hub, clock);

    await flush();
    clock.advance(NAV_GRACE_MS);
    await flush(); // now waiting out the quiet gap
    hub.emit({ kind: "request_started", url: "/x", resource: "data" });
    await flush(); // now waiting on the cap instead, since a request is open
    // Why: longer than the original quiet gap would have needed, but well under the cap.
    clock.advance(QUIET_MS);
    await flush();
    expect(r.settled()).toBe(false);
    hub.emit({ kind: "request_done", url: "/x", resource: "data" });
    await flush();
    expect(r.settled()).toBe(false); // the quiet gap starts fresh from here
    clock.advance(QUIET_MS);
    await flush();
    expect(r.settled()).toBe(true);
  });

  test("a static request never counts toward quiet", async () => {
    const hub = new EventHub<SurfaceEvent>();
    const clock = new ManualClock();
    const r = run(hub, clock);

    await flush();
    clock.advance(NAV_GRACE_MS);
    await flush();
    hub.emit({ kind: "request_started", url: "/img.png", resource: "static" });
    await flush();
    clock.advance(QUIET_MS);
    await flush();
    expect(r.settled()).toBe(true);
  });

  test("quiet is capped: a data request that never finishes does not wait forever", async () => {
    const hub = new EventHub<SurfaceEvent>();
    const clock = new ManualClock();
    const r = run(hub, clock);

    await flush();
    clock.advance(NAV_GRACE_MS);
    await flush();
    hub.emit({ kind: "request_started", url: "/x", resource: "data" });
    await flush();
    clock.advance(QUIET_CAP_MS);
    await flush();
    expect(r.settled()).toBe(true);
  });

  test("a navigation starting within the grace window is waited out before the quiet gap", async () => {
    const hub = new EventHub<SurfaceEvent>();
    const clock = new ManualClock();
    const r = run(hub, clock);

    await flush();
    hub.emit({ kind: "navigation_started", url: "/next" });
    await flush();
    clock.advance(1_000); // the page is still loading; the wait does not give up early
    await flush();
    expect(r.settled()).toBe(false);
    hub.emit({ kind: "navigation_done", url: "/next" });
    await flush();
    clock.advance(QUIET_MS);
    await flush();
    expect(r.settled()).toBe(true);
  });

  test("no wait is a fixed sleep: nothing resolves while the clock never advances", async () => {
    const hub = new EventHub<SurfaceEvent>();
    const clock = new ManualClock();
    const r = run(hub, clock, 60_000);
    await flush();
    expect(r.settled()).toBe(false);
    expect(clock.waiting).toBeGreaterThan(0);
  });
});
