// Proves the truth checks of section 8 §8.2's table: commit truth (every row, including the
// double-commit case), output truth (against the oracle, and against the baseline), and outcome
// truth. Design section 8 §8.2; docs/decisions.md, M06 ("output truth matches an oracle field of
// the same name, else unavailable"). M06 task 8.
import { describe, expect, test } from "vitest";
import {
  commitTruth,
  notesQueryFor,
  outcomeTruth,
  outputTruthAgainstBaseline,
  outputTruthAgainstOracle,
} from "../../../src/core/certify/truth.js";
import type { OracleAccount } from "../../../src/ports/harness.js";

describe("commitTruth", () => {
  test("two or more accounts is always a mismatch: a double commit", () => {
    expect(commitTruth("confirmed", 2)).toEqual({ match: false, note: "the oracle found more than one account" });
    expect(commitTruth("uncertain", 3)).toMatchObject({ match: false });
  });

  test("uncertain claims nothing, whatever the oracle found (below 2)", () => {
    expect(commitTruth("uncertain", 0)).toEqual({ match: true, note: "uncertain claims nothing" });
    expect(commitTruth("uncertain", 1)).toEqual({ match: true, note: "uncertain claims nothing" });
  });

  test("confirmed or found_by_check matches exactly one account", () => {
    expect(commitTruth("confirmed", 1)).toEqual({ match: true });
    expect(commitTruth("found_by_check", 1)).toEqual({ match: true });
    expect(commitTruth("confirmed", 0)).toEqual({ match: false });
    expect(commitTruth("found_by_check", 0)).toEqual({ match: false });
  });

  test("every other commit state (not_sent, absent_by_check) matches zero accounts", () => {
    expect(commitTruth("not_sent", 0)).toEqual({ match: true });
    expect(commitTruth("absent_by_check", 0)).toEqual({ match: true });
    expect(commitTruth("not_sent", 1)).toEqual({ match: false });
  });
});

describe("notesQueryFor", () => {
  test("no notes input: commit truth cannot run at all", () => {
    expect(notesQueryFor({}, "run_2026-01-15_0000000001")).toBeNull();
  });

  test("fills {system.run_id} into the notes text", () => {
    expect(notesQueryFor({ notes: "opened via {system.run_id}" }, "run_2026-01-15_0000000001")).toBe(
      "opened via run_2026-01-15_0000000001",
    );
  });

  test("a non-string notes value is stringified first", () => {
    expect(notesQueryFor({ notes: 42 }, "r1")).toBe("42");
  });
});

const ORACLE: OracleAccount = { account_number: "400100000159", status: "OPEN", confirmation_number: "KV10000001" };

describe("outputTruthAgainstOracle", () => {
  test("no oracle account to compare: unavailable", () => {
    expect(outputTruthAgainstOracle({ account_number: "400100000159" }, undefined)).toEqual({
      match: null,
      note: "the oracle found no account to compare",
    });
  });

  test("no reported output shares a name with an oracle field: unavailable", () => {
    expect(outputTruthAgainstOracle({ some_other_field: "x" }, ORACLE)).toEqual({
      match: null,
      note: "unavailable: no oracle field of the same name",
    });
  });

  test("a matching same-name field: match", () => {
    expect(outputTruthAgainstOracle({ account_number: "400100000159" }, ORACLE)).toEqual({ match: true });
  });

  test("a mismatching same-name field: no match", () => {
    expect(outputTruthAgainstOracle({ account_number: "999999999999" }, ORACLE)).toEqual({ match: false });
  });

  test("one matching and one unknown field: match still counts only the compared ones", () => {
    expect(outputTruthAgainstOracle({ account_number: "400100000159", nickname: "x" }, ORACLE)).toEqual({
      match: true,
    });
  });
});

describe("outputTruthAgainstBaseline", () => {
  test("no outputs to compare", () => {
    expect(outputTruthAgainstBaseline({}, {})).toEqual({ match: null, note: "no outputs to compare" });
  });

  test("every output matches the baseline", () => {
    expect(outputTruthAgainstBaseline({ balance: "100.00" }, { balance: "100.00" })).toEqual({ match: true });
  });

  test("one output differs from the baseline", () => {
    expect(outputTruthAgainstBaseline({ balance: "100.00" }, { balance: "50.00" })).toEqual({ match: false });
  });
});

describe("outcomeTruth", () => {
  test("the class does not expect a business outcome at all", () => {
    expect(outcomeTruth("member_not_found", { status: "success" })).toEqual({
      match: false,
      note: "the class expects success, not business_outcome",
    });
  });

  test("the reported code matches the class's expected outcome", () => {
    expect(outcomeTruth("member_not_found", { status: "business_outcome", outcome: "member_not_found" })).toEqual({
      match: true,
    });
  });

  test("the reported code does not match", () => {
    expect(outcomeTruth("member_not_found", { status: "business_outcome", outcome: "something_else" })).toEqual({
      match: false,
    });
  });
});
