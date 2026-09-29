// Proves the artifact schema accepts the design's full example and a candidate-shaped file,
// and rejects an unknown field and a bad enum value.
// Design section 2 §4 to §19, §21 (full example); owner decision 2026-09-29 (candidate mode).
import { describe, expect, test } from "vitest";
import { Artifact } from "../../../src/core/model/artifact.js";
import { artifactExample } from "../../fixtures/design-examples.js";

/** A deep clone, so each test mutates its own copy. */
function clone(): Record<string, unknown> {
  return structuredClone(artifactExample());
}

describe("intyy.artifact/1.0", () => {
  test("the section 2 §21 full example parses", () => {
    const result = Artifact.safeParse(clone());
    expect(result.success).toBe(true);
  });

  test("a candidate-shaped copy parses: version, sealed, reconciliation, commit point, and tags null; about empty", () => {
    const doc = clone();
    (doc.identity as Record<string, unknown>).version = null;
    (doc.about as Record<string, unknown>) = {
      title: "",
      summary: "",
      when_to_use: "",
      limits: "",
    };
    const recovery = doc.recovery as Record<string, unknown>;
    recovery.reconciliation = null;
    recovery.commit_point = null;
    (doc.provenance as Record<string, unknown>).sealed = null;
    const actions = (doc.provenance as Record<string, unknown>).actions as Record<
      string,
      unknown
    >[];
    for (const action of actions) {
      action.human_tag = null;
      action.decided_by = null;
    }
    expect(Artifact.safeParse(doc).success).toBe(true);
  });

  test("an unknown top-level field is rejected", () => {
    const doc = clone();
    doc.surprise = true;
    expect(Artifact.safeParse(doc).success).toBe(false);
  });

  test("an unknown field on a nested block is rejected", () => {
    const doc = clone();
    (doc.contract as Record<string, unknown>).extra = "nope";
    expect(Artifact.safeParse(doc).success).toBe(false);
  });

  test("a wrong enum value is rejected", () => {
    const doc = clone();
    (doc.contract as Record<string, unknown>).effect = "reads_only";
    expect(Artifact.safeParse(doc).success).toBe(false);
  });

  test("a wrong risk value on a step is rejected", () => {
    const doc = clone();
    const steps = doc.steps as Record<string, unknown>[];
    const confirm = steps.find((s) => s.id === "click_confirm");
    if (confirm === undefined) throw new Error("fixture missing click_confirm");
    confirm.risk = "unsure";
    expect(Artifact.safeParse(doc).success).toBe(false);
  });

  test("a `ref` nested check with no `check` field parses (section 2 §21 shorthand)", () => {
    const doc = clone();
    const conditions = doc.conditions as Record<string, unknown>[];
    const formReady = conditions.find((c) => c.id === "form_ready");
    if (formReady === undefined) throw new Error("fixture missing form_ready");
    expect((formReady.checks as unknown[]).some((c) => (c as { ref?: string }).ref !== undefined)).toBe(
      true,
    );
    expect(Artifact.safeParse(doc).success).toBe(true);
  });
});
