// Proves how one jev answer becomes a ladder verdict, and that the jev and reviewer schemas accept
// the design's examples and reject extras. Pure: no model, no clock. Design section 5 §8.7
// (bucket table), §10.2, §10.3, §10.4 (thresholds), §10.5, §10.7 (jev fails), §11.2.
import { describe, expect, test } from "vitest";
import {
  JevReconcileInput,
  JevReconcileOutput,
  JevTroubleInput,
  JevTroubleOutput,
} from "../../../src/core/model/jev.js";
import { ReviewerInput, ReviewerOutput } from "../../../src/core/model/reviewer.js";
import {
  effectiveThreshold,
  reconcileVerdict,
  troubleVerdict,
} from "../../../src/core/replay/jev-verdict.js";
import type {
  CallFailure,
  JevReconcileOutput as ReconcileOut,
  JevTroubleOutput as TroubleOut,
} from "../../../src/ports/models.js";
import { fail, ok } from "../../../src/ports/outcome.js";

const choices = { outcomes: ["x"], handlers: ["kyc_reminder"] };
const cutoffs = { handler_min: 0.8, outcome_min: 0.95, reconciliation_min: 0.9 };

/** A trouble answer. */
function answer(over: Partial<TroubleOut>): TroubleOut {
  return { bucket: "needs_review", handler: null, outcome: null, confidence: 0.5, ...over };
}
const trouble = (a: TroubleOut) => troubleVerdict(ok(a), choices, cutoffs);
const reconcile = (v: ReconcileOut["verdict"], confidence: number) =>
  reconcileVerdict(ok({ verdict: v, confidence }), cutoffs);

describe("troubleVerdict: thresholds", () => {
  test("handler, outcome, unsafe, and needs_review answers follow their cutoffs", () => {
    const h = { bucket: "handler", handler: "kyc_reminder" } as const;
    expect(trouble(answer({ ...h, confidence: 0.8 }))).toEqual({
      kind: "handler",
      handler: "kyc_reminder",
      confidence: 0.8,
    });
    expect(trouble(answer({ ...h, confidence: 0.79 }))).toEqual({
      kind: "needs_review",
      confidence: 0.79,
    });

    const o = { bucket: "outcome", outcome: "x" } as const;
    expect(trouble(answer({ ...o, confidence: 0.95 }))).toEqual({
      kind: "outcome",
      code: "x",
      confidence: 0.95,
    });
    expect(trouble(answer({ ...o, confidence: 0.94 }))).toEqual({
      kind: "needs_review",
      confidence: 0.94,
    });

    for (const confidence of [0, 1]) {
      expect(trouble(answer({ bucket: "unsafe", confidence }))).toEqual({
        kind: "unsafe",
        confidence,
      });
    }

    expect(trouble(answer({ bucket: "needs_review", confidence: 0.71 }))).toEqual({
      kind: "needs_review",
      confidence: 0.71,
    });
  });
});

describe("troubleVerdict: jev fails (section 5 §10.7)", () => {
  const invalid = { kind: "needs_review", confidence: 0, warning: "classifier_invalid_output" };

  test("bad names, failures, and off-schema values give invalid or no answer", () => {
    expect(trouble(answer({ bucket: "handler", handler: "nope", confidence: 1 }))).toEqual(invalid);
    expect(trouble(answer({ bucket: "outcome", outcome: "nope", confidence: 1 }))).toEqual(invalid);
    expect(trouble(answer({ bucket: "handler", handler: null, confidence: 1 }))).toEqual(invalid);
    expect(trouble(answer({ bucket: "outcome", outcome: null, confidence: 1 }))).toEqual(invalid);
    for (const failure of ["timeout", "unavailable", "refused", "write_failed"] as const) {
      expect(troubleVerdict(fail<CallFailure>(failure), choices, cutoffs), failure).toEqual({
        kind: "needs_review",
        confidence: 0,
        warning: "classifier_unavailable",
      });
    }
    expect(troubleVerdict(fail<CallFailure>("invalid_output"), choices, cutoffs)).toEqual(invalid);
    const bad = [
      { ...answer({ bucket: "unsafe" }), confidence: 1.5 },
      { ...answer({ bucket: "unsafe" }), extra: true },
    ] as unknown as TroubleOut[];
    for (const b of bad) expect(trouble(b)).toEqual(invalid);
  });
});

describe("reconcileVerdict (section 5 §10.5)", () => {
  test("found and not_found follow the cutoff", () => {
    expect(reconcile("found", 0.9)).toEqual({ verdict: "found", confidence: 0.9 });
    expect(reconcile("found", 0.89)).toEqual({ verdict: "unclear", confidence: 0.89 });
    expect(reconcile("not_found", 0.9)).toEqual({ verdict: "not_found", confidence: 0.9 });
    expect(reconcile("not_found", 0.89)).toEqual({ verdict: "unclear", confidence: 0.89 });
  });

  test("unclear passes through, and any failure is unclear with confidence 0 and the right warning", () => {
    expect(reconcile("unclear", 0.3)).toEqual({ verdict: "unclear", confidence: 0.3 });
    for (const failure of ["timeout", "unavailable", "refused", "write_failed"] as const) {
      expect(reconcileVerdict(fail<CallFailure>(failure), cutoffs), failure).toEqual({
        verdict: "unclear",
        confidence: 0,
        warning: "classifier_unavailable",
      });
    }
    expect(reconcileVerdict(fail<CallFailure>("invalid_output"), cutoffs)).toEqual({
      verdict: "unclear",
      confidence: 0,
      warning: "classifier_invalid_output",
    });
    const bad = { verdict: "found", confidence: 2 } as unknown as ReconcileOut;
    expect(reconcileVerdict(ok(bad), cutoffs)).toEqual({
      verdict: "unclear",
      confidence: 0,
      warning: "classifier_invalid_output",
    });
  });
});

describe("jev never claims refused", () => {
  test("no verdict names refused, and the schemas reject it", () => {
    const seen = new Set<string>();
    for (const bucket of ["outcome", "handler", "needs_review", "unsafe"] as const) {
      const v = trouble(answer({ bucket, handler: "kyc_reminder", outcome: "x", confidence: 1 }));
      seen.add(v.kind);
    }
    for (const verdict of ["found", "not_found", "unclear"] as const) {
      seen.add(reconcile(verdict, 1).verdict);
    }
    expect(seen.has("refused")).toBe(false);
    expect(JevTroubleOutput.safeParse({ ...answer({}), bucket: "refused" }).success).toBe(false);
    expect(JevReconcileOutput.safeParse({ verdict: "refused", confidence: 1 }).success).toBe(false);
  });
});

describe("effectiveThreshold (section 5 §10.4)", () => {
  test("is the higher of the app value and a tightening", () => {
    expect(effectiveThreshold(0.8, undefined)).toBe(0.8);
    expect(effectiveThreshold(0.8, 0.9)).toBe(0.9);
    expect(effectiveThreshold(0.95, 0.9)).toBe(0.95);
  });
});

describe("schemas accept the design examples and reject extra fields", () => {
  const troubleIn = {
    schema: "intyy.jev.step/1.0",
    step: {
      id: "open_account_form",
      intent: "Open the new account form",
      action: "click",
      risk: "idempotent",
      phase: "checkpoint",
    },
    expected: {
      condition: "account_form_shown",
      description: "The new account form is showing",
      trace: [{ path: "account_form_shown", check: "element_visible", passed: false }],
    },
    last_good: { step: "open_member", location: "/members/{input.member_id}" },
    screen: {
      location: "/accounts/new",
      truncated: false,
      elements: [
        { role: "heading", name: "Notice" },
        { role: "text", name: "Branch profile review is pending." },
        { role: "button", name: "Close" },
      ],
    },
    outcomes: [],
    handlers: [
      {
        id: "kyc_reminder",
        class: "recoverable",
        description: "The app interrupts with a request to update member KYC details.",
      },
      {
        id: "session_expired",
        class: "recoverable",
        description: "The app says the session has expired.",
      },
    ],
    tied: [],
  };
  const reconcileIn = {
    schema: "intyy.jev.reconcile/1.0",
    parent: {
      capability: "kvfcu/open_share_subaccount@1",
      commit_step: { id: "click_confirm", intent: "Confirm and open the sub-account" },
      correlation: "notes",
      last_screen: {
        location: "/accounts/new",
        elements: [{ role: "heading", name: "500 Internal Server Error" }],
      },
    },
    check: {
      capability: "kvfcu/find_account_by_reference@1",
      status: "failed",
      outcome: null,
      failure: {
        code: "checkpoint_timeout",
        step: "read_account_number",
        phase: "checkpoint",
        trace: [{ path: "account_detail_shown", check: "element_visible", passed: false }],
      },
      final_screen: {
        location: "/members/{input.member_id}/accounts",
        elements: [{ role: "row", name: "[account#1] Share Savings OPEN {input.reference}" }],
      },
    },
    not_found_outcomes: ["not_found"],
  };
  const reviewerIn = {
    schema: "intyy.reviewer.step/1.0",
    step: troubleIn.step,
    expected: troubleIn.expected,
    last_good: troubleIn.last_good,
    screen: {
      location: "/accounts/new",
      truncated: false,
      elements: [{ id: "e4", role: "button", name: "Close" }],
    },
    jev: { bucket: "needs_review", confidence: 0.71 },
    inputs: ["member_id"],
    allowed: { actions: ["click", "press"], keys: ["Tab", "Escape"], paths: ["/accounts/new"] },
    commit: "not_sent",
    screenshot: null,
  };

  const examples = [
    ["JevTroubleInput", JevTroubleInput, troubleIn],
    ["JevReconcileInput", JevReconcileInput, reconcileIn],
    ["ReviewerInput", ReviewerInput, reviewerIn],
    [
      "JevTroubleOutput",
      JevTroubleOutput,
      { bucket: "needs_review", handler: null, outcome: null, confidence: 0.71 },
    ],
    ["JevReconcileOutput", JevReconcileOutput, { verdict: "found", confidence: 0.93 }],
    [
      "ReviewerOutput action",
      ReviewerOutput,
      {
        action: { type: "click", element: "e4" },
        reason: "A notice covers the page. Close should dismiss it.",
        expected: "The new account form shows.",
      },
    ],
    [
      "ReviewerOutput give_up",
      ReviewerOutput,
      { give_up: true, reason: "The screen asks for an approval I cannot give." },
    ],
  ] as const;

  test("each schema accepts its example and rejects an extra field, and input rules hold", () => {
    for (const [name, schema, example] of examples) {
      expect(schema.safeParse(example).success, name).toBe(true);
      expect(schema.safeParse({ ...example, extra: 1 }).success, name).toBe(false);
    }
    // The optional screenshot field is accepted on jev's input.
    expect(JevTroubleInput.safeParse({ ...troubleIn, screenshot: "aGk=" }).success).toBe(true);
    // An input with the wrong schema string is rejected.
    expect(JevTroubleInput.safeParse({ ...troubleIn, schema: "intyy.jev.step/2.0" }).success).toBe(
      false,
    );
  });
});
