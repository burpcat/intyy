// Proves the trust state machine (design section 8 §4.2 transitions, §10.1 roles): every legal
// move reaches its state, every other (state, move) pair is `illegal_move`, nothing moves a key
// up without a staff ID, only the right system actors degrade or retire, and `decide` adds the
// role rules, with `role` ahead of `illegal_move`. Tables below are written from the §4.2 table,
// not from the code. M10 task 2.
import { describe, expect, test } from "vitest";
import type { Role } from "../../../src/core/model/staff.js";
import type { TrustState } from "../../../src/core/model/score.js";
import { decide, isStaffActor, transition, type Move } from "../../../src/core/trust/state.js";

const STATES: TrustState[] = ["draft", "approved", "degraded", "retired"];
const MOVES: Move[] = ["approve", "restore", "reinstate", "degrade", "retire"];
const STAFF = "op_022";

/** Section 8 §4.2, by a staff ID: where each legal move starts, and where it ends. */
const LEGAL: Record<string, TrustState> = {
  "draft approve": "approved",
  "approved approve": "approved",
  "degraded restore": "approved",
  "retired reinstate": "draft",
  "approved degrade": "degraded",
  "draft retire": "retired",
  "approved retire": "retired",
  "degraded retire": "retired",
};

const PAIRS = STATES.flatMap((s) => MOVES.map((m) => [s, m] as const));

describe("transition by a staff ID", () => {
  test("every (state, move) pair reaches its state or is illegal_move; exactly the eight legal pairs pass", () => {
    for (const [from, move] of PAIRS) {
      const expected = LEGAL[`${from} ${move}`];
      const r = transition(from, move, STAFF);
      if (expected === undefined) {
        expect(r, `${from} then ${move}`).toMatchObject({ ok: false, failure: "illegal_move" });
      } else {
        expect(r, `${from} then ${move}`).toEqual({ ok: true, value: expected });
      }
    }
    const legal = PAIRS.filter(([s, m]) => transition(s, m, STAFF).ok);
    expect(legal).toHaveLength(Object.keys(LEGAL).length);
  });
});

describe("nothing moves a key up without a staff ID", () => {
  const nonStaff = ["certify", "system", "live_score", ""];

  test("isStaffActor, and approve, restore, and reinstate by a non-staff actor need a staff ID", () => {
    for (const by of nonStaff) expect(isStaffActor(by)).toBe(false);
    expect(isStaffActor("op_017")).toBe(true);
    for (const by of nonStaff) {
      for (const [from, move] of [
        ["draft", "approve"],
        ["approved", "approve"],
        ["degraded", "restore"],
        ["retired", "reinstate"],
      ] as const) {
        expect(transition(from, move, by), `${by} ${from} ${move}`).toMatchObject({ ok: false, failure: "needs_staff" });
      }
    }
    // a missing staff ID is reported before a bad state
    expect(transition("retired", "approve", "certify")).toMatchObject({ failure: "needs_staff" });
    expect(transition("draft", "restore", "system")).toMatchObject({ failure: "needs_staff" });
  });

  test("degrade and retire accept only the right system actors; a person can retire a draft", () => {
    // degrade: live_score, certify, or staff only
    expect(transition("approved", "degrade", "live_score")).toEqual({ ok: true, value: "degraded" });
    expect(transition("approved", "degrade", "certify")).toEqual({ ok: true, value: "degraded" });
    expect(transition("approved", "degrade", "op_017")).toEqual({ ok: true, value: "degraded" });
    expect(transition("approved", "degrade", "system")).toMatchObject({ failure: "needs_staff" });
    expect(transition("approved", "degrade", "")).toMatchObject({ failure: "needs_staff" });
    // retire: system or staff only
    expect(transition("approved", "retire", "system")).toEqual({ ok: true, value: "retired" });
    expect(transition("degraded", "retire", "system")).toEqual({ ok: true, value: "retired" });
    expect(transition("approved", "retire", "op_017")).toEqual({ ok: true, value: "retired" });
    expect(transition("approved", "retire", "live_score")).toMatchObject({ failure: "needs_staff" });
    expect(transition("approved", "retire", "certify")).toMatchObject({ failure: "needs_staff" });
    expect(transition("approved", "retire", "")).toMatchObject({ failure: "needs_staff" });
    // Why: section 8 §4.2 gives the system "approved, degraded -> retired" only; "any" is a person.
    expect(transition("draft", "retire", "system")).toMatchObject({ failure: "illegal_move" });
    expect(transition("draft", "retire", "op_017")).toEqual({ ok: true, value: "retired" });
  });
});

describe("decide: roles on top of the moves", () => {
  const operator: Role[] = ["operator"];
  const approver: Role[] = ["approver"];
  const reviewer: Role[] = ["reviewer"];

  test("an operator cannot approve, restore, or reinstate; an approver can; both may degrade or retire", () => {
    for (const [from, move] of [
      ["draft", "approve"],
      ["degraded", "restore"],
      ["retired", "reinstate"],
    ] as const) {
      const label = `${from} then ${move}`;
      expect(decide(from, move, STAFF, operator), label).toMatchObject({ ok: false, failure: "role" });
      expect(decide(from, move, STAFF, approver), label).toMatchObject({ ok: true });
      expect(decide(from, move, STAFF, [...operator, ...approver]), label).toMatchObject({ ok: true });
    }
    for (const [from, move] of [
      ["approved", "degrade"],
      ["approved", "retire"],
      ["draft", "retire"],
    ] as const) {
      const label = `${from} then ${move}`;
      expect(decide(from, move, STAFF, operator), label).toMatchObject({ ok: true });
      expect(decide(from, move, STAFF, approver), label).toMatchObject({ ok: true });
    }
  });

  test("a reviewer, or a person with no role, may make no move", () => {
    for (const roles of [reviewer, []]) {
      expect(decide("approved", "degrade", STAFF, roles)).toMatchObject({ failure: "role" });
      expect(decide("approved", "retire", STAFF, roles)).toMatchObject({ failure: "role" });
      expect(decide("draft", "approve", STAFF, roles)).toMatchObject({ failure: "role" });
    }
  });

  test("role outranks illegal_move", () => {
    // An operator who may not approve learns nothing about the state.
    expect(decide("retired", "approve", STAFF, operator)).toMatchObject({ failure: "role" });
    expect(decide("draft", "degrade", STAFF, reviewer)).toMatchObject({ failure: "role" });
    // With the role, the same move is an illegal move.
    expect(decide("retired", "approve", STAFF, approver)).toMatchObject({ failure: "illegal_move" });
    expect(decide("draft", "degrade", STAFF, operator)).toMatchObject({ failure: "illegal_move" });
  });

  test("a system actor needs no role, and still needs a staff ID to move up", () => {
    expect(decide("approved", "degrade", "certify", [])).toEqual({ ok: true, value: "degraded" });
    expect(decide("approved", "degrade", "live_score", [])).toEqual({ ok: true, value: "degraded" });
    expect(decide("draft", "approve", "certify", approver)).toMatchObject({ failure: "needs_staff" });
  });

  test("every decide result for an approver matches transition", () => {
    for (const [s, m] of PAIRS) {
      expect(decide(s, m, STAFF, approver)).toEqual(transition(s, m, STAFF));
    }
  });
});
