// Proves the handler draft schema accepts a minimal draft and rejects a bad source.
// Design section 5 §12.2.
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
    conditions: [],
    handler: { id: "kyc_reminder", class: "recoverable" },
    risk_hints: [{ subject: "click_remind_later", class: "idempotent", source: "rules" }],
    fixtures: { fire: "kyc_reminder_fire", no_fire: [] },
  };
}

describe("HandlerDraft", () => {
  test("accepts a minimal recorder draft", () => {
    expect(HandlerDraft.safeParse(draft()).success).toBe(true);
  });

  test("rejects a source with no run ID", () => {
    const bad = draft();
    (bad.source as Record<string, unknown>).run_id = "not-a-run-id";
    expect(HandlerDraft.safeParse(bad).success).toBe(false);
  });
});
