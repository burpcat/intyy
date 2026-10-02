// Contract suite for locks: the six section 9 §16 cases, plus order and release.
// Runs against memory slots and file slots. Design section 9 §12.
import { describe, expect, test, vi } from "vitest";
import {
  LOCK_POLL_MS,
  LockManager,
  type LockEnv,
  type LockSlots,
} from "../../src/core/locks/manager.js";
import { ManualClock } from "../../src/fakes/clock.js";
import type { LockInfo, LockRequest } from "../../src/ports/locks.js";

const RUN = "run_2026-01-15_7kq2m9x4tb";
const ORIGIN = "http_127.0.0.1_8080";

/** A request with defaults. */
function req(owner: string, extra: Partial<LockRequest> = {}): LockRequest {
  return { owner, command: "replay", staff: "op_017", waitMs: 0, ...extra };
}

/** Two simulated processes on one host, sharing one slot store. */
function world(slots: LockSlots) {
  const clock = new ManualClock("2026-01-15T09:00:00.000Z");
  const alive = new Set([1001, 1002]);
  const env = (pid: number): LockEnv => ({ host: "host-a", pid, isAlive: (p) => alive.has(p) });
  return {
    clock,
    alive,
    a: new LockManager(slots, clock, env(1001)),
    b: new LockManager(slots, clock, env(1002)),
    /** Writes a lock record directly, as another process would have. */
    plant: (info: Partial<LockInfo>) =>
      slots.create("instance", ORIGIN, {
        schema: "intyy.lock/1.0",
        owner: "batch_2026-01-15_aaaaaaaaaa",
        pid: 999,
        host: "host-a",
        command: "certify",
        staff: "op_017",
        started_at: "2026-01-15T08:00:00.000Z",
        ...info,
      }),
  };
}

/** Runs the lock contract against one slot store. */
export function locksContract(label: string, makeSlots: () => Promise<LockSlots>): void {
  describe(`Locks contract: ${label}`, () => {
    test("busy: a held lock refuses another taker and names the holder; waitMs 0 does not wait", async () => {
      const w = world(await makeSlots());
      // fail fast: waitMs 0 answers busy without waiting (instance first: the lock order)
      await w.a.acquire(
        "instance",
        ORIGIN,
        req("batch_2026-01-15_aaaaaaaaaa", { command: "certify" }),
      );
      const fast = await w.b.acquire("instance", ORIGIN, req(RUN, { command: "discover" }));
      expect(fast).toMatchObject({ ok: false, failure: "busy" });
      expect(w.clock.waiting).toBe(0);

      const held = await w.a.acquire("run", RUN, req(RUN, { command: "replay", staff: "op_017" }));
      expect(held.ok).toBe(true);
      const second = await w.b.acquire("run", RUN, req("run_2026-01-15_bbbbbbbbbb"));
      expect(second).toMatchObject({ ok: false, failure: "busy" });
      expect(second.ok ? "" : second.detail).toContain(
        "held by replay, staff op_017, since 2026-01-15T09:00:00.000Z",
      );
    });

    test("bounded wait: a waiter gets the lock once the holder releases", async () => {
      const w = world(await makeSlots());
      const first = await w.a.acquire("instance", ORIGIN, req(RUN));
      if (!first.ok) throw new Error("first acquire failed");
      const waiting = w.b.acquire(
        "instance",
        ORIGIN,
        req("run_2026-01-15_bbbbbbbbbb", { waitMs: 30_000 }),
      );
      await vi.waitFor(() => {
        expect(w.clock.waiting).toBe(1);
      });
      await w.a.release(first.value);
      w.clock.advance(LOCK_POLL_MS);
      expect(await waiting).toMatchObject({
        ok: true,
        value: { owner: "run_2026-01-15_bbbbbbbbbb", shared: false },
      });
    });

    test("bounded wait: a waiter gives up busy after waitMs", async () => {
      const w = world(await makeSlots());
      await w.a.acquire("instance", ORIGIN, req(RUN));
      const waiting = w.b.acquire(
        "instance",
        ORIGIN,
        req("run_2026-01-15_bbbbbbbbbb", { waitMs: 30_000 }),
      );
      await vi.waitFor(() => {
        expect(w.clock.waiting).toBe(1);
      });
      w.clock.advance(29_000);
      await vi.waitFor(() => {
        expect(w.clock.waiting).toBe(1);
      });
      w.clock.advance(1_000);
      expect(await waiting).toMatchObject({ ok: false, failure: "busy" });
      expect(w.clock.waiting).toBe(0);
    });

    test("a child run shares its parent's hold and keeps the lock on release; a wrong parent is busy", async () => {
      const w = world(await makeSlots());
      const batch = "batch_2026-01-15_aaaaaaaaaa";
      const parent = await w.a.acquire("instance", ORIGIN, req(batch, { command: "certify" }));
      expect(parent.ok).toBe(true);
      // a child naming the wrong parent is busy
      const wrong = await w.b.acquire(
        "instance",
        ORIGIN,
        req(RUN, { parent: "batch_2026-01-15_zzzzzzzzzz" }),
      );
      expect(wrong).toMatchObject({ ok: false, failure: "busy" });
      const child = await w.b.acquire("instance", ORIGIN, req(RUN, { parent: batch }));
      expect(child).toMatchObject({ ok: true, value: { shared: true, owner: RUN } });
      if (child.ok) await w.b.release(child.value);
      expect(await w.a.inspect("instance", ORIGIN)).toMatchObject({ owner: batch });
    });

    test("stale on this host: a dead holder's lock is cleared and reported", async () => {
      const w = world(await makeSlots());
      await w.plant({ host: "host-a", pid: 999 });
      const got = await w.b.acquire("instance", ORIGIN, req(RUN));
      expect(got).toMatchObject({
        ok: true,
        value: { shared: false, cleared: { owner: "batch_2026-01-15_aaaaaaaaaa", pid: 999 } },
      });
      expect(await w.b.inspect("instance", ORIGIN)).toMatchObject({ owner: RUN, pid: 1002 });
    });

    test("a live holder on this host is not stale", async () => {
      const w = world(await makeSlots());
      w.alive.add(999);
      await w.plant({ host: "host-a", pid: 999 });
      expect(await w.b.acquire("instance", ORIGIN, req(RUN))).toMatchObject({
        ok: false,
        failure: "busy",
      });
    });

    test("another host's lock is always held, even with a dead process ID", async () => {
      const w = world(await makeSlots());
      await w.plant({ host: "host-b", pid: 999 });
      const got = await w.b.acquire("instance", ORIGIN, req(RUN));
      expect(got).toMatchObject({ ok: false, failure: "busy" });
      expect(got.ok ? "" : got.detail).toContain("on host-b");
    });

    test("order: instance, then run, then score; out of order throws", async () => {
      const w = world(await makeSlots());
      expect((await w.a.acquire("instance", ORIGIN, req(RUN))).ok).toBe(true);
      expect((await w.a.acquire("run", RUN, req(RUN))).ok).toBe(true);
      await expect(w.a.acquire("instance", "http_127.0.0.1_9090", req(RUN))).rejects.toThrow(
        "lock order",
      );
      expect((await w.a.acquire("score", "keystone", req(RUN))).ok).toBe(true);
      await expect(w.a.acquire("score", "lakeshore", req(RUN))).rejects.toThrow(
        "score lock never waits",
      );
    });

    test("release frees the lock; a released hold no longer counts for order", async () => {
      const w = world(await makeSlots());
      const score = await w.a.acquire("score", "keystone", req(RUN));
      if (!score.ok) throw new Error("acquire failed");
      await w.a.release(score.value);
      expect(await w.a.inspect("score", "keystone")).toBeNull();
      expect((await w.a.acquire("run", RUN, req(RUN))).ok).toBe(true);
    });

    test("release never removes a lock another process took", async () => {
      const w = world(await makeSlots());
      const mine = await w.a.acquire("run", RUN, req(RUN));
      if (!mine.ok) throw new Error("acquire failed");
      w.alive.delete(1001);
      const theirs = await w.b.acquire("run", RUN, req(RUN));
      expect(theirs.ok && theirs.value.cleared?.pid).toBe(1001);
      await w.a.release(mine.value);
      expect(await w.b.inspect("run", RUN)).toMatchObject({ pid: 1002 });
    });
  });
}
