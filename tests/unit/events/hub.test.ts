// Proves the event hub frees a subscription when its signal aborts, even if it was never read,
// and that a normal subscription still gets events sent before its first read.
// The hub has no public listener count, so the tests read the iterator: an aborted one finishes
// at once and holds no events sent after the abort. Design section 9 §5.2 (`Eyes.events`).
import { describe, expect, test } from "vitest";
import { EventHub } from "../../../src/core/events/hub.js";

describe("EventHub.subscribe", () => {
  test("an unread subscription that aborts drops later events and finishes at once", async () => {
    const hub = new EventHub<number>();
    const ctrl = new AbortController();
    const events = hub.subscribe(ctrl.signal)[Symbol.asyncIterator]();
    ctrl.abort();
    hub.emit(1);
    hub.emit(2);
    hub.emit(3);
    expect(await events.next()).toEqual({ done: true, value: undefined });
  });

  test("a signal already aborted at subscribe time registers nothing", async () => {
    const hub = new EventHub<number>();
    const ctrl = new AbortController();
    ctrl.abort();
    const events = hub.subscribe(ctrl.signal)[Symbol.asyncIterator]();
    hub.emit(1);
    expect(await events.next()).toEqual({ done: true, value: undefined });
  });

  test("a normal subscription gets events sent between subscribe and the first read", async () => {
    const hub = new EventHub<number>();
    const events = hub.subscribe()[Symbol.asyncIterator]();
    hub.emit(1);
    hub.emit(2);
    expect(await events.next()).toEqual({ done: false, value: 1 });
    expect(await events.next()).toEqual({ done: false, value: 2 });
    hub.end();
    expect(await events.next()).toEqual({ done: true, value: undefined });
  });
});
