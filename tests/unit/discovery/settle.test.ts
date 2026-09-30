// Proves settling: two agreeing looks end it; failed looks mid-navigation are waited out; a page
// that never answers is page_gone at the 10 s cap. Design section 6 §10.1 step 1; M03 task 6.
import { describe, expect, test } from "vitest";
import { settle } from "../../../src/core/discovery/settle.js";
import { SteppingClock } from "../../../src/fakes/clock.js";
import { fail, ok, type Outcome } from "../../../src/ports/outcome.js";
import type { Eyes, Observation } from "../../../src/ports/surface.js";
import { el, screen } from "./kit.js";

/** Eyes that answer each look from a list, repeating the last. */
function eyes(looks: Outcome<Observation, "page_gone">[]): Eyes & { calls: number } {
  const e = {
    calls: 0,
    observe: () =>
      Promise.resolve(looks[Math.min(e.calls++, looks.length - 1)] ?? fail("page_gone")),
  };
  return e as unknown as Eyes & { calls: number };
}

const a = screen([el("x", { clues: { path: "p", text: "Loading" } })], {
  url: "http://127.0.0.1:8080/login.do",
});
const b = screen([el("y", { clues: { path: "p", text: "Welcome" } })], {
  url: "http://127.0.0.1:8080/lastLogin.do",
});

describe("settle (section 6 §10.1 step 1)", () => {
  test("two agreeing looks end the wait", async () => {
    const r = await settle(eyes([ok(a), ok(b), ok(b)]), new SteppingClock());
    expect(r).toEqual({ ok: true, value: b });
  });

  test("failed looks mid-navigation are waited out", async () => {
    const r = await settle(
      eyes([fail("page_gone"), fail("page_gone"), ok(b), ok(b)]),
      new SteppingClock(),
    );
    expect(r).toEqual({ ok: true, value: b });
  });

  test("a page that never answers is page_gone at the cap", async () => {
    const e = eyes([fail("page_gone")]);
    expect(await settle(e, new SteppingClock())).toMatchObject({ ok: false, failure: "page_gone" });
    expect(e.calls).toBeGreaterThan(30);
  });

  test("two zero-element looks agree but never settle: it returns only at the cap, newest look", async () => {
    const empty = screen([], { url: "http://127.0.0.1:8080/main.do" });
    const e = eyes([ok(empty)]);
    expect(await settle(e, new SteppingClock())).toEqual({ ok: true, value: empty });
    // Same cap as a page that never answers: many looks, not the usual two.
    expect(e.calls).toBeGreaterThan(30);
  });

  test("elements that appear after empty looks settle normally, on two agreeing looks", async () => {
    const empty = screen([], { url: "http://127.0.0.1:8080/main.do" });
    const e = eyes([ok(empty), ok(empty), ok(b), ok(b)]);
    expect(await settle(e, new SteppingClock())).toEqual({ ok: true, value: b });
    expect(e.calls).toBe(4);
  });
});
