// Proves the verdict rules of section 8 §8.1, §8.3: `judgeCase`'s priority order, the
// fault-profile `expect` rule matches, and a suite extra case's own `expect` match.
// Design section 8 §6.3, §8.1, §8.3. M06 task 8.
import { describe, expect, test } from "vitest";
import { judgeCase, matchesExpectRule, matchesExtraExpect } from "../../../src/core/certify/verdicts.js";
import type { ResultClass } from "../../../src/core/certify/verdicts.js";

describe("judgeCase", () => {
  test("void wins over everything else", () => {
    expect(
      judgeCase({ classMatches: false, truth: { commit: false }, unexpectedHelp: true, void: true }),
    ).toBe("void");
  });

  test("a failed truth check always wins, even when the class matches", () => {
    expect(judgeCase({ classMatches: true, truth: { commit: false } })).toBe("wrong");
    expect(judgeCase({ classMatches: true, truth: { output: false, outcome: null } })).toBe("wrong");
  });

  test("truth clean (null/true only), class does not match: unexplained", () => {
    expect(judgeCase({ classMatches: false, truth: { commit: null, output: true } })).toBe("unexplained");
  });

  test("class matches, unexpected help happened: assisted", () => {
    expect(judgeCase({ classMatches: true, truth: {}, unexpectedHelp: true })).toBe("assisted");
  });

  test("class matches, no unexpected help, truth clean: pass", () => {
    expect(judgeCase({ classMatches: true, truth: { commit: true, output: null } })).toBe("pass");
  });

  test("no truth checks at all still passes when the class matches", () => {
    expect(judgeCase({ classMatches: true, truth: {} })).toBe("pass");
  });
});

const SUCCESS: ResultClass = { status: "success", detail: null };
const FAILED_APP_ERROR: ResultClass = { status: "failed", detail: "app_error" };
const ESCALATED: ResultClass = { status: "escalated", detail: "takeover/stuck/click_confirm" };
const BUSINESS_OUTCOME: ResultClass = { status: "business_outcome", detail: "member_not_found" };

describe("matchesExpectRule", () => {
  const successExpect = { status: "success" };
  const outcomeExpect = { status: "business_outcome", outcome: "member_not_found" };

  test("recovers: matches the class's own plain expectation", () => {
    expect(matchesExpectRule("recovers", SUCCESS, successExpect, null)).toBe(true);
    expect(matchesExpectRule("recovers", FAILED_APP_ERROR, successExpect, null)).toBe(false);
    expect(matchesExpectRule("recovers", BUSINESS_OUTCOME, outcomeExpect, null)).toBe(true);
    expect(matchesExpectRule("recovers", BUSINESS_OUTCOME, successExpect, null)).toBe(false);
  });

  test("recovers_or_escalates: escalated always matches too", () => {
    expect(matchesExpectRule("recovers_or_escalates", ESCALATED, successExpect, null)).toBe(true);
    expect(matchesExpectRule("recovers_or_escalates", SUCCESS, successExpect, null)).toBe(true);
    expect(matchesExpectRule("recovers_or_escalates", FAILED_APP_ERROR, successExpect, null)).toBe(false);
  });

  test("fails:<code>: the failure code must match exactly", () => {
    expect(matchesExpectRule("fails:app_error", FAILED_APP_ERROR, successExpect, null)).toBe(true);
    expect(matchesExpectRule("fails:permission_denied", FAILED_APP_ERROR, successExpect, null)).toBe(false);
    expect(matchesExpectRule("fails:app_error", SUCCESS, successExpect, null)).toBe(false);
  });

  test("reconciles_found: success with commit found_by_check", () => {
    expect(matchesExpectRule("reconciles_found", SUCCESS, successExpect, "found_by_check")).toBe(true);
    expect(matchesExpectRule("reconciles_found", SUCCESS, successExpect, "confirmed")).toBe(false);
    expect(matchesExpectRule("reconciles_found", FAILED_APP_ERROR, successExpect, "found_by_check")).toBe(false);
  });

  test("reconciles_absent: success with commit confirmed", () => {
    expect(matchesExpectRule("reconciles_absent", SUCCESS, successExpect, "confirmed")).toBe(true);
    expect(matchesExpectRule("reconciles_absent", SUCCESS, successExpect, "found_by_check")).toBe(false);
  });
});

describe("matchesExtraExpect", () => {
  test("status mismatch: no match", () => {
    expect(matchesExtraExpect(SUCCESS, { status: "failed" })).toBe(false);
  });

  test("business_outcome: the outcome code must match", () => {
    expect(matchesExtraExpect(BUSINESS_OUTCOME, { status: "business_outcome", outcome: "member_not_found" })).toBe(
      true,
    );
    expect(matchesExtraExpect(BUSINESS_OUTCOME, { status: "business_outcome", outcome: "other" })).toBe(false);
  });

  test("escalated: kind, reason, and step must match exactly, joined by /", () => {
    expect(
      matchesExtraExpect(ESCALATED, { status: "escalated", kind: "takeover", reason: "stuck", step: "click_confirm" }),
    ).toBe(true);
    expect(
      matchesExtraExpect(ESCALATED, { status: "escalated", kind: "takeover", reason: "stuck", step: "click_search" }),
    ).toBe(false);
  });

  test("every other status matches on status alone", () => {
    expect(matchesExtraExpect(SUCCESS, { status: "success" })).toBe(true);
    expect(matchesExtraExpect(FAILED_APP_ERROR, { status: "failed" })).toBe(true);
  });
});
