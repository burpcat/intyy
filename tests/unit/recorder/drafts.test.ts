// Proves drafts.ts (section 6 §14.12; section 5 §12.2 to §12.4): one draft handler per run of
// consecutive incidental actions, and the normal fixtures the main flow used.
import { describe, expect, test } from "vitest";
import { buildDrafts, buildNormalFixtures } from "../../../src/core/recorder/drafts.js";
import type { Snapshots } from "../../../src/core/recorder/steps.js";
import type { TaggedAction } from "../../../src/core/recorder/tags.js";

function incidental(): TaggedAction {
  return {
    runId: "run_2026-09-24_x",
    seq: 6,
    turn: 4,
    tool: "click",
    target: "e9",
    value: null,
    format: null,
    option: null,
    checked: null,
    key: null,
    result: "ok",
    dispatched: true,
    tag: "incidental",
    humanTag: null,
    effectiveTag: "incidental",
    reason: "Clear the KYC reminder.",
    expected: "The reminder closes.",
    corrects: null,
    fingerprint: {
      role: "button",
      name: "Remind Later",
      label: null,
      text: "Remind Later",
      region: null,
      crop: null,
      crop_dropped: "no_crop_rule",
      path: "dialog > button[1]",
      within: null,
      max_length: null,
      field_kind: null,
      uniqueness: 1,
    },
    beforeLocation: "/members/100107",
    afterLocation: "/members/100107",
    at: "2026-09-24T10:00:00.000Z",
    afterAt: "2026-09-24T10:00:01.000Z",
    riskHint: null,
    riskHintBy: null,
    gateRisk: null,
  };
}

const EMPTY: Snapshots = { a11yByTurn: new Map(), proof: null, proofElementListText: null };

describe("buildDrafts", () => {
  test("one draft per run of incidental actions, recoverable when nothing needs a human", () => {
    const a = incidental();
    const { drafts, became } = buildDrafts([a], "kvfcu", "keystone", "9.2", EMPTY);
    expect(drafts).toHaveLength(1);
    const draft = drafts[0];
    if (draft === undefined) throw new Error("expected one draft");
    expect(draft.source).toMatchObject({ kind: "recorder", seq: [6], tenant: "keystone" });
    expect(draft.targets.map((t) => t.id)).toEqual(["remind_later_button"]);
    expect(draft.fixtures).toEqual({ fire: `${draft.id}_fire`, no_fire: [] });
    expect((draft.handler as { class: string }).class).toBe("recoverable");
    expect(became.get(a)).toBe(`handler_draft:${draft.id}`);
  });

  test("an approved irreversible action needs a human", () => {
    const a = { ...incidental(), riskHint: "irreversible" as const };
    const { drafts } = buildDrafts([a], "kvfcu", "keystone", "9.2", EMPTY);
    expect((drafts[0]?.handler as { class: string }).class).toBe("needs_human");
  });
});

describe("buildNormalFixtures", () => {
  test("one fixture per distinct kept-step location", () => {
    const fixtures = buildNormalFixtures(["/login.do", "/login.do", "/main.do"]);
    expect(fixtures).toEqual([
      { id: "normal_login", location: "/login.do" },
      { id: "normal_main", location: "/main.do" },
    ]);
  });
});
