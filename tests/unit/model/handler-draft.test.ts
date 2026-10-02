// Proves the handler draft schema accepts a minimal draft and rejects a bad source, and that
// `handler` is now the real pack Handler shape (docs/decisions.md, M04: M06 defines it), not
// the old placeholder `{id, class}` alone. Design section 5 §12.2. M06 task 1.
import { describe, expect, test } from "vitest";
import { HandlerDraft } from "../../../src/core/model/handler-draft.js";

function draft(): Record<string, unknown> {
  return {
    schema: "intyy.handler_draft/1.0",
    id: "kyc_reminder",
    app: "kvfcu",
    source: {
      kind: "recorder",
      run_id: "run_2026-09-24_7kq2m9x4tb",
      seq: [9],
      tenant: "keystone",
      app_version: "8.4",
    },
    suggested_scope: "tenant",
    targets: [],
    conditions: [{ id: "kyc_popup_shown", check: "text_visible", description: "KYC popup shown", text: "KYC", match: "contains" }],
    handler: {
      id: "kyc_reminder",
      description: "The app interrupts with a KYC reminder.",
      class: "needs_human",
      detector: "kyc_popup_shown",
      operator_note: "Review this drafted handler.",
      fixtures: { fire: ["kyc_reminder_fire"], no_fire: [] },
    },
    risk_hints: [{ subject: "click_remind_later", class: "idempotent", source: "rules" }],
    fixtures: { fire: "kyc_reminder_fire", no_fire: [] },
  };
}

describe("HandlerDraft", () => {
  test("HandlerDraft accepts a minimal draft and rejects bad ones", () => {
    // accepts a minimal recorder draft
    expect(HandlerDraft.safeParse(draft()).success).toBe(true);
    // rejects a source with no run ID
    {
      const bad = draft();
      (bad.source as Record<string, unknown>).run_id = "not-a-run-id";
      expect(HandlerDraft.safeParse(bad).success).toBe(false);
    }
    // rejects the old {id, class} placeholder for handler, now that it must be a real Handler
    {
      const bad = draft();
      bad.handler = { id: "kyc_reminder", class: "needs_human" };
      expect(HandlerDraft.safeParse(bad).success).toBe(false);
    }
  });
});
