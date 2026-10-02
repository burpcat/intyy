// Proves the run ID format and the fake clock. Design section 3 §7.2 and section 9 §5.7.
import { describe, expect, test } from "vitest";
import { SystemClock } from "../../src/adapters/system/clock.js";
import { SystemIds } from "../../src/adapters/system/ids.js";
import { formatId, RunId } from "../../src/core/model/ids.js";
import { ManualClock } from "../../src/fakes/clock.js";
import { SeededIds } from "../../src/fakes/ids.js";

const RUN_ID = /^run_\d{4}-\d{2}-\d{2}_[0-9a-hjkmnp-tv-z]{10}$/;

describe("run IDs", () => {
  test("run IDs follow the section 3 shape, the seed, and the byte mapping", () => {
    // system IDs follow section 3 §7.2
    {
      const ids = new SystemIds(new SystemClock());
      for (let i = 0; i < 200; i++) {
        const id = ids.runId();
        expect(id).toMatch(RUN_ID);
        expect(id).toHaveLength(25);
        expect(id.slice(15)).not.toMatch(/[ilou]/);
        expect(RunId.safeParse(id).success).toBe(true);
      }
    }
    // the date is the clock's UTC date
    {
      const clock = new ManualClock("2026-09-24T23:30:00.000-05:00");
      expect(new SeededIds(clock).runId().slice(0, 15)).toBe("run_2026-09-25_");
    }
    // other kinds share the shape with their own prefix
    {
      const ids = new SeededIds(new ManualClock());
      expect(ids.batchId()).toMatch(/^batch_2026-01-15_[0-9a-hjkmnp-tv-z]{10}$/);
      expect(ids.leaseToken()).toMatch(/^lease_2026-01-15_[0-9a-hjkmnp-tv-z]{10}$/);
      expect(ids.alertId()).toMatch(/^alert_2026-01-15_[0-9a-hjkmnp-tv-z]{10}$/);
    }
    // the same seed gives the same IDs; another seed differs
    {
      const a = new SeededIds(new ManualClock(), 7);
      const b = new SeededIds(new ManualClock(), 7);
      const c = new SeededIds(new ManualClock(), 8);
      const first = [a.runId(), a.runId()];
      expect([b.runId(), b.runId()]).toEqual(first);
      expect(c.runId()).not.toBe(first[0]);
      expect(first[0]).not.toBe(first[1]);
    }
    // RunId rejects bad shapes
    for (const bad of [
      "run_2026-09-24_7kq2m9x4t",
      "run_2026-09-24_7kq2m9x4tl",
      "RUN_2026-09-24_7kq2m9x4tb",
      "a1f3",
    ]) {
      expect(RunId.safeParse(bad).success).toBe(false);
    }
    // formatId maps each byte's low 5 bits to one character
    {
      const bytes = Uint8Array.from([0, 1, 9, 10, 17, 18, 31, 32, 255, 64]);
      expect(formatId("run", new Date("2026-01-15T00:00:00Z"), bytes)).toBe(
        "run_2026-01-15_019ahjz0z0",
      );
    }
  });
});

describe("ManualClock", () => {
  test("moves only on advance and fires due timers in order", async () => {
    const clock = new ManualClock("2026-01-15T09:00:00.000Z");
    const fired: string[] = [];
    const late = clock.after(200).then(() => fired.push("late"));
    const early = clock.after(100).then(() => fired.push("early"));
    expect(clock.waiting).toBe(2);

    clock.advance(99);
    await Promise.resolve();
    expect(fired).toEqual([]);

    clock.advance(101);
    await Promise.all([early, late]);
    expect(fired).toEqual(["early", "late"]);
    expect(clock.now().toISOString()).toBe("2026-01-15T09:00:00.200Z");
  });

  test("an aborted wait rejects and stops waiting", async () => {
    const clock = new ManualClock();
    const ac = new AbortController();
    const wait = clock.after(1000, ac.signal);
    ac.abort(new Error("stop"));
    await expect(wait).rejects.toThrow("stop");
    expect(clock.waiting).toBe(0);
  });
});
