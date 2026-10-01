// Test helper: wraps the snapshot fake to count open event subscriptions, to script when the
// page's events and screen change after a click, and to record when each look happens.
// Design section 6 §10.1 step 1; section 7 §5.1 (settle after an action).
import { EventHub } from "../../../src/core/events/hub.js";
import { snapshotFactory, type FakeSite } from "../../../src/fakes/snapshot-surface/index.js";
import { fromFactory, toFactory, type ActResult, type Hands, type ResolvedAction } from "../../../src/ports/hands.js";
import type { Clock } from "../../../src/ports/clock.js";
import type { Outcome } from "../../../src/ports/outcome.js";
import { ok } from "../../../src/ports/outcome.js";
import type { LeaseToken, SurfaceEvent, SurfaceFactory } from "../../../src/ports/surface.js";

/** What the wrapper saw. */
export type Spy = {
  /** The signal of every `events(signal)` call that passed one. The gate's own call has none. */
  signals: AbortSignal[];
  /** How many of those were still open just before each call. */
  openBefore: number[];
  /** How many were open when each hands action ran. */
  openAtAct: number[];
  /** `clock.now()` in ms at each hands action, and at each look. Empty without a clock. */
  actAt: number[];
  lookAt: number[];
  /** The count open now: subscribed, and not yet aborted. */
  open: () => number;
};

/** What a test scripts. */
export type Script = {
  /** Replaces the hands. `inner` is the fake's own. Left out, the fake acts at once. */
  onAct?: (a: ResolvedAction, lease: LeaseToken, inner: Hands) => Promise<Outcome<ActResult, "stale_element">>;
  /** Event stream to serve instead of the fake's own, which are dropped. */
  events?: EventHub<SurfaceEvent>;
  /** Time source for `actAt` and `lookAt`. */
  clock?: Clock;
};

/** The snapshot fake over `site`, wrapped. Returns the factory and what it saw. */
export function spying(site: FakeSite, script: Script = {}): { factory: SurfaceFactory; spy: Spy } {
  const spy: Spy = {
    signals: [],
    openBefore: [],
    openAtAct: [],
    actAt: [],
    lookAt: [],
    open: () => spy.signals.filter((s) => !s.aborted).length,
  };
  const inner = fromFactory(snapshotFactory(site));
  const now = (): number => script.clock?.now().getTime() ?? 0;
  const factory = toFactory({
    close: () => inner.close(),
    open: async (cfg, signal) => {
      const opened = await inner.open(cfg, signal);
      if (!opened.ok) return opened;
      const { eyes: real, hands: realHands } = opened.value;
      const eyes = {
        observe: (s?: AbortSignal) => {
          if (script.clock !== undefined) spy.lookAt.push(now());
          return real.observe(s);
        },
        screenshot: (m: Parameters<typeof real.screenshot>[0], s?: AbortSignal) => real.screenshot(m, s),
        snapshots: (s?: AbortSignal) => real.snapshots(s),
        crop: (e: Parameters<typeof real.crop>[0], s?: AbortSignal) => real.crop(e, s),
        events: (s?: AbortSignal) => {
          if (s !== undefined) {
            spy.openBefore.push(spy.open());
            spy.signals.push(s);
          }
          return script.events === undefined ? real.events(s) : script.events.subscribe(s);
        },
      };
      const hands: Hands = {
        act: (a, lease, s) => {
          spy.openAtAct.push(spy.open());
          if (script.clock !== undefined) spy.actAt.push(now());
          return script.onAct === undefined ? realHands.act(a, lease, s) : script.onAct(a, lease, realHands);
        },
      };
      return ok({ eyes, hands });
    },
  });
  return { factory, spy };
}
