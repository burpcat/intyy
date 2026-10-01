// Proves the two pure parts of a quick certify batch: `declareInstance` (design section 9 §9.2,
// CONTRACT §4 option types) and `matrixProfiles` (section 8 §7.1, "the matrix on the commit step
// only"; section 8 §6.3 anchors). M08 task 1.
import { describe, expect, test } from "vitest";
import { declareInstance } from "../../../src/core/certify/instance.js";
import { matrixProfiles } from "../../../src/core/certify/quick.js";
import type { FaultProfile } from "../../../src/core/model/faults.js";
import type { TestInstance } from "../../../src/core/model/testdata.js";

const BASE: TestInstance = { variant: "keystone", strip_semantics: false, drop_labels: 0, label_seed: "0" };

function declared(text: string, base: TestInstance = BASE) {
  const r = declareInstance(text, base);
  if (!r.ok) throw new Error(`expected ok, got ${r.failure}: ${r.detail ?? ""}`);
  return r.value;
}

function refused(text: string, base: TestInstance = BASE): string {
  const r = declareInstance(text, base);
  if (r.ok) throw new Error(`expected a refusal for ${text}`);
  expect(r.failure).toBe("bad_instance");
  return r.detail ?? "";
}

describe("declareInstance", () => {
  test("strip_semantics takes 1, 0, true, and false", () => {
    expect(declared("strip_semantics=1").instance.strip_semantics).toBe(true);
    expect(declared("strip_semantics=true").instance.strip_semantics).toBe(true);
    expect(declared("strip_semantics=0").instance.strip_semantics).toBe(false);
    expect(declared("strip_semantics=false").instance.strip_semantics).toBe(false);
    expect(declared("strip_semantics=1").differs).toEqual(["strip_semantics"]);
    expect(declared("strip_semantics=0").differs).toEqual([]);
  });

  test("drop_labels is a number from 0 to 1 (CONTRACT §4)", () => {
    expect(declared("drop_labels=0.3").instance.drop_labels).toBe(0.3);
    expect(declared("drop_labels=0.3").differs).toEqual(["drop_labels"]);
    expect(declared("drop_labels=1").instance.drop_labels).toBe(1);
    refused("drop_labels=2");
    refused("drop_labels=abc");
    refused("drop_labels=-0.1");
  });

  test("delay_scale is above 0; 1 is no difference from a base with none", () => {
    refused("delay_scale=0");
    refused("delay_scale=abc");
    expect(declared("delay_scale=1").differs).toEqual([]);
    expect(declared("delay_scale=0.2").differs).toEqual(["delay_scale"]);
    expect(declared("delay_scale=0.2").instance.delay_scale).toBe(0.2);
    // A base that sets delay_scale itself is compared with its own value.
    expect(declared("delay_scale=0.2", { ...BASE, delay_scale: 0.2 }).differs).toEqual([]);
  });

  test("variant and label_seed differ from the base only when the text differs", () => {
    expect(declared("variant=lakeshore").differs).toEqual(["variant"]);
    expect(declared("variant=keystone").differs).toEqual([]);
    expect(declared("label_seed=7").differs).toEqual(["label_seed"]);
  });

  test("several facts: all declared are laid over the base; differs lists only changed ones", () => {
    const d = declared("variant=lakeshore,strip_semantics=1,drop_labels=0.3,label_seed=7,delay_scale=0.2");
    expect(d.instance).toEqual({
      variant: "lakeshore",
      strip_semantics: true,
      drop_labels: 0.3,
      label_seed: "7",
      delay_scale: 0.2,
    });
    expect(d.differs).toEqual(["variant", "strip_semantics", "drop_labels", "label_seed", "delay_scale"]);
  });

  test("a repeated key, an unknown key, and a pair without = are refused", () => {
    expect(refused("strip_semantics=1,strip_semantics=0")).toContain("strip_semantics");
    expect(refused("colour=blue")).toContain("colour");
    refused("strip_semantics");
    refused("strip_semantics=");
    refused("=1");
    refused("");
    refused("strip_semantics=yes");
  });
});

const profile = (id: string, at: string): FaultProfile =>
  at === "@commit_point"
    ? { id, kind: "drop_after_confirm", at, expect_commit: "reconciles_found" }
    : { id, kind: "server_error", at, expect_commit: "reconciles_absent", expect_window: "recovers" };

describe("matrixProfiles", () => {
  const all = [
    profile("each", "@each_request_step"),
    profile("lost", "@commit_point"),
    profile("on_commit", "@step:click_confirm"),
    profile("on_search", "@step:click_search"),
  ];

  test("@commit_point and @each_request_step count; a fixed step counts only as the commit step", () => {
    const got = matrixProfiles(all, "click_confirm");
    expect(got.map((e) => e.profile.id)).toEqual(["each", "lost", "on_commit"]);
  });

  test("@each_request_step is placed at the commit step; the others carry no --at", () => {
    const got = matrixProfiles(all, "click_confirm");
    expect(got.map((e) => e.at)).toEqual(["@step:click_confirm", undefined, undefined]);
  });

  test("with no commit step known, only the two movable anchors count", () => {
    const got = matrixProfiles(all, null);
    expect(got.map((e) => e.profile.id)).toEqual(["each", "lost"]);
    expect(got.map((e) => e.at)).toEqual([undefined, undefined]);
  });

  test("no profiles: no cases", () => {
    expect(matrixProfiles([], "click_confirm")).toEqual([]);
  });
});
