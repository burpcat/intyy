// Proves paths.ts step 6 (section 6 §14.6): `runs_on.paths` from every location a kept step
// saw, with dynamic segments and query values turned into `*` or dropped.
import { describe, expect, test } from "vitest";
import { buildPaths, toPathPattern } from "../../../src/core/recorder/paths.js";

describe("toPathPattern", () => {
  test("a dynamic path segment becomes *", () => {
    expect(toPathPattern("/members/48213")).toBe("/members/*");
    expect(toPathPattern("/members/{input.member_id}")).toBe("/members/*");
  });

  test("a constant query value stays; a dynamic one is dropped", () => {
    expect(toPathPattern("/main.do?cmd=view")).toBe("/main.do?cmd=view");
    expect(toPathPattern("/main.do?cmd=view&id=48213")).toBe("/main.do?cmd=view");
  });

  test("a plain location with no dynamic part is kept as is", () => {
    expect(toPathPattern("/login.do")).toBe("/login.do");
    expect(toPathPattern("/")).toBe("/");
  });
});

describe("buildPaths", () => {
  test("entry plus every kept location, deduplicated, in first-seen order", () => {
    const { paths, unmatched } = buildPaths("/login.do", [
      "/login.do",
      "/login.do",
      "/main.do",
      "/members/48213",
    ]);
    expect(paths).toEqual(["/login.do", "/main.do", "/members/*"]);
    expect(unmatched).toEqual([]);
  });
});
