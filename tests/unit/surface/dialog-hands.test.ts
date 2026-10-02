// Proves the Playwright hands answer a native box once: the box state clears however the answer
// ends, a throw from Playwright still reports dispatched true, and only a lost connection stays
// unknown. Runs on a fake Playwright page and box, in memory; no browser starts.
// Design section 9 §5.2 (dispatched is a value); section 7 §7.2, §9.1; owner's real run, 2026-09-30.
import type { Dialog, Page } from "playwright";
import { describe, expect, test, vi } from "vitest";
import { PlaywrightHands } from "../../../src/adapters/playwright/hands.js";
import { BrowserState, STEP_TIMEOUT_MS } from "../../../src/adapters/playwright/state.js";
import { EventHub } from "../../../src/core/events/hub.js";
import type { SurfaceEvent } from "../../../src/ports/surface.js";

/** A hands object over a state that holds one fake box. `answer` runs when the box is answered. */
function setup(answer: () => Promise<void>) {
  const hub = new EventHub<SurfaceEvent>();
  const s = new BrowserState(hub, { width: 1280, height: 800 });
  s.pages.push({ isClosed: () => false } as unknown as Page);
  s.dialog = { accept: answer, dismiss: answer } as unknown as Dialog;
  const events = hub.subscribe()[Symbol.asyncIterator]();
  const hands = new PlaywrightHands(s);
  const click = (part: "accept" | "dismiss") =>
    hands.act({ type: "click", target: s.dialogRef(part) });
  return { s, click, events };
}

/** The kinds of the events queued so far. */
async function kinds(it: AsyncIterator<SurfaceEvent>, n: number): Promise<string[]> {
  const out: string[] = [];
  for (let i = 0; i < n; i += 1) {
    const next = await it.next();
    out.push(next.done === true ? "end" : next.value.kind);
  }
  return out;
}

describe("answering a native box", () => {
  test("a clean accept clears the box, announces it, and reports dispatched", async () => {
    const { s, click, events } = setup(() => Promise.resolve());
    const before = s.generation;
    expect(await click("accept")).toEqual({ ok: true, value: { dispatched: true } });
    expect(s.dialog).toBeNull();
    expect(s.generation).toBe(before + 1);
    expect(await kinds(events, 2)).toEqual(["dialog_closed", "page_changed"]);
  });

  test("accept or dismiss throws as the page jumps away: the box still clears and counts as dispatched", async () => {
    for (const part of ["accept", "dismiss"] as const) {
      const { s, click, events } = setup(() =>
        Promise.reject(new Error("Dialog.accept: Cannot accept dialog which is already handled!")),
      );
      expect(await click(part), part).toEqual({ ok: true, value: { dispatched: true } });
      expect(s.dialog, part).toBeNull();
      expect(await kinds(events, 2), part).toEqual(["dialog_closed", "page_changed"]);
    }
  });

  test("a lost connection stays unknown, and the box still clears", async () => {
    const { s, click, events } = setup(() => Promise.reject(new Error("Target page has been closed")));
    expect(await click("accept")).toEqual({
      ok: true,
      value: { dispatched: "unknown", transport: "connection_closed" },
    });
    expect(s.dialog).toBeNull();
    expect(await kinds(events, 2)).toEqual(["dialog_closed", "page_changed"]);
  });

  test("a stale box whose answer never returns: unknown after the step cap, and the box clears", async () => {
    vi.useFakeTimers();
    try {
      const { s, click } = setup(() => new Promise<void>(() => undefined));
      const answered = click("accept");
      await vi.advanceTimersByTimeAsync(STEP_TIMEOUT_MS);
      expect(await answered).toEqual({ ok: true, value: { dispatched: "unknown", transport: "navigation_timeout" } });
      expect(s.dialog).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  test("answering twice: the old ref is stale, and the box is never in view again", async () => {
    const { s, click } = setup(() => Promise.resolve());
    await click("accept");
    expect(await click("accept")).toMatchObject({ ok: false, failure: "stale_element" });
    expect(s.dialog).toBeNull();
  });
});
