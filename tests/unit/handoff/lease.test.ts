// Proves the control lease: the section 12.2 transitions in order, a new token per bot grant, the
// stale token never matching, no human-to-bot shortcut, and what human input does to it.
// Design section 7 §12.1 to §12.4; section 4 §3.3. M07 task 1.
import { describe, expect, test } from "vitest";
import { Lease, type LeaseChange } from "../../../src/core/handoff/lease.js";
import { SteppingClock } from "../../../src/fakes/clock.js";
import { SeededIds } from "../../../src/fakes/ids.js";

type Seen = { change: LeaseChange; by: "engine" | "human" };

/** A lease on seeded IDs, and every change it told the log. */
function make(): { lease: Lease; seen: Seen[] } {
  const seen: Seen[] = [];
  const lease = new Lease(new SeededIds(new SteppingClock(), 3), (change, by) => seen.push({ change, by }));
  return { lease, seen };
}

const reasons = (seen: Seen[]): string[] => seen.map((s) => s.change.reason);

describe("the transitions (section 7 §12.2)", () => {
  test("the lease transitions follow the table, keep tokens apart, and throw only for a bug", () => {
    // start, takeover, claim, handback, reverify give the table's changes in order
    {
      const { lease, seen } = make();
      expect(lease.start().ok).toBe(true);
      expect(lease.requestTakeover().ok).toBe(true);
      expect(lease.claim("op_1").ok).toBe(true);
      expect(lease.handBack().ok).toBe(true);
      expect(lease.reverified().ok).toBe(true);

      expect(seen.map((s) => [s.change.from, s.change.to, s.change.reason, s.by])).toEqual([
        ["nobody", "bot", "run_start", "engine"],
        ["bot", "nobody", "takeover_requested", "engine"],
        ["nobody", "human", "claimed", "human"],
        ["human", "nobody", "handed_back", "human"],
        ["nobody", "bot", "reverified", "engine"],
      ]);
      expect(seen[2]?.change).toMatchObject({ staff_id: "op_1", implicit: false });
      expect(seen[3]?.change).toMatchObject({ staff_id: "op_1" });
    }
    // an approval wait keeps the bot's token and marks the lease waiting
    {
      const { lease, seen } = make();
      lease.start();
      const token = lease.botToken();
      expect(lease.awaitDecision().ok).toBe(true);
      expect(lease.waiting).toBe(true);
      expect(lease.holder).toBe("bot");
      expect(lease.current()).toBe(token);
      expect(lease.decided().ok).toBe(true);
      expect(lease.waiting).toBe(false);
      expect(lease.current()).toBe(token);
      expect(reasons(seen)).toEqual(["run_start", "awaiting_decision", "decided"]);
      // Not waiting: `decided` has nothing to decide. A second wait cannot nest.
      expect(lease.decided().ok).toBe(false);
      lease.awaitDecision();
      expect(lease.awaitDecision().ok).toBe(false);
    }
    // a failed reverify keeps nobody and logs reverify_failed
    {
      const { lease, seen } = make();
      lease.start();
      lease.requestTakeover();
      expect(lease.reverifyFailed().ok).toBe(true);
      expect(lease.holder).toBe("nobody");
      expect(seen.at(-1)?.change).toMatchObject({ from: "nobody", to: "nobody", reason: "reverify_failed" });
    }
    // bot tokens differ across grants; current() is null while nobody or a human holds it
    {
      const { lease } = make();
      lease.start();
      const first = lease.botToken();
      expect(lease.current()).toBe(first);

      lease.requestTakeover();
      expect(lease.current()).toBeNull();
      lease.claim("op_1");
      expect(lease.current()).toBeNull();
      lease.handBack();
      expect(lease.current()).toBeNull();

      lease.reverified();
      const second = lease.botToken();
      expect(second).not.toBe(first);
      expect(lease.current()).toBe(second);
      // The stale token (from before the takeover) never equals the live one.
      expect(lease.current()).not.toBe(first);
    }
    // a throw only for a bug: botToken before start throws
    {
      const { lease } = make();
      expect(() => lease.botToken()).toThrow();
    }
  });
});

describe("no human-to-bot shortcut (section 7 §12.2)", () => {
  test("the lease allows no human-to-bot shortcut and ends cleanly", () => {
    // from a human, reverified and start are not allowed
    {
      const { lease, seen } = make();
      lease.start();
      lease.requestTakeover();
      lease.claim("op_1");
      const before = seen.length;
      expect(lease.reverified()).toMatchObject({ ok: false, failure: "not_allowed" });
      expect(lease.start()).toMatchObject({ ok: false, failure: "not_allowed" });
      expect(lease.holder).toBe("human");
      expect(lease.current()).toBeNull();
      expect(seen).toHaveLength(before);
    }
    // from the bot, claim is not allowed
    {
      const { lease } = make();
      lease.start();
      expect(lease.claim("op_1")).toMatchObject({ ok: false, failure: "not_allowed" });
      expect(lease.holder).toBe("bot");
    }
    // a handback needs a human, and a takeover needs the bot
    {
      const { lease } = make();
      lease.start();
      expect(lease.handBack().ok).toBe(false);
      lease.requestTakeover();
      expect(lease.requestTakeover().ok).toBe(false);
    }
    // after end() every move is not_allowed, and end() twice logs one run_end
    {
      const { lease, seen } = make();
      lease.start();
      lease.end();
      lease.end();
      expect(seen.filter((s) => s.change.reason === "run_end")).toHaveLength(1);
      expect(seen.at(-1)?.change).toMatchObject({ from: "bot", to: "nobody", reason: "run_end" });
      expect(lease.holder).toBe("nobody");
      expect(lease.current()).toBeNull();

      const moves = [
        lease.start(),
        lease.awaitDecision(),
        lease.decided(),
        lease.requestTakeover(),
        lease.claim("op_1"),
        lease.handBack(),
        lease.reverified(),
        lease.reverifyFailed(),
      ];
      for (const m of moves) expect(m).toMatchObject({ ok: false, failure: "not_allowed" });
      expect(seen).toHaveLength(2);
    }
    // end() from a human logs the holder it left
    {
      const { lease, seen } = make();
      lease.start();
      lease.requestTakeover();
      lease.claim("op_1");
      lease.end();
      expect(seen.at(-1)?.change).toMatchObject({ from: "human", to: "nobody", reason: "run_end" });
    }
    // end() on a lease that never started logs nothing
    {
      const { lease, seen } = make();
      lease.end();
      expect(seen).toHaveLength(0);
    }
  });
});

describe("human input (section 7 §12.4)", () => {
  test("human input while the bot drives, waits, or nobody holds it", () => {
    // while the bot drives: a takeover is pending, the lease is nobody, the bot's token is stale
    {
      const { lease, seen } = make();
      lease.start();
      const token = lease.botToken();
      expect(lease.takeoverPending()).toBe(false);

      expect(lease.humanInput("op_9")).toEqual({ kind: "takeover", wasWaiting: false });
      expect(lease.takeoverPending()).toBe(true);
      expect(lease.holder).toBe("nobody");
      expect(lease.current()).toBeNull();
      expect(lease.current()).not.toBe(token);
      expect(seen.at(-1)?.change).toMatchObject({ reason: "takeover_requested", implicit: false });

      expect(lease.takePending()).toBe("unexpected_human_input");
      expect(lease.takeoverPending()).toBe(false);
      expect(lease.takePending()).toBeNull();
    }
    // while the bot waits for an approval: wasWaiting is true
    {
      const { lease } = make();
      lease.start();
      lease.awaitDecision();
      expect(lease.humanInput(null)).toEqual({ kind: "takeover", wasWaiting: true });
      expect(lease.waiting).toBe(false);
    }
    // while nobody holds it, with a staff ID: an implicit claim, logged implicit: true
    {
      const { lease, seen } = make();
      lease.start();
      lease.requestTakeover();
      expect(lease.humanInput("op_9")).toEqual({ kind: "implicit_claim", staff: "op_9" });
      expect(lease.holder).toBe("human");
      expect(lease.staffId).toBe("op_9");
      expect(seen.at(-1)).toEqual({
        change: { from: "nobody", to: "human", reason: "claimed", staff_id: "op_9", implicit: true },
        by: "human",
      });
    }
    // while nobody holds it, with no staff ID: no claim, and the lease stays nobody
    {
      const { lease, seen } = make();
      lease.start();
      lease.requestTakeover();
      const before = seen.length;
      expect(lease.humanInput(null)).toEqual({ kind: "no_claim" });
      expect(lease.holder).toBe("nobody");
      expect(seen).toHaveLength(before);
    }
    // while a human holds it: held, nothing changes
    {
      const { lease, seen } = make();
      lease.start();
      lease.requestTakeover();
      lease.claim("op_1");
      const before = seen.length;
      expect(lease.humanInput("op_9")).toEqual({ kind: "held" });
      expect(lease.staffId).toBe("op_1");
      expect(seen).toHaveLength(before);
    }
    // after the run ends: no claim, even with a staff ID
    {
      const { lease } = make();
      lease.start();
      lease.end();
      expect(lease.humanInput("op_9")).toEqual({ kind: "no_claim" });
      expect(lease.holder).toBe("nobody");
    }
  });
});
