// Proves the path matcher: every example in design section 4 §6.3, plus the normalizing tricks.
// Section 4 §14, "Path matcher"; M02 task 1.
import { describe, expect, test } from "vitest";
import {
  matchPath,
  normalizePath,
  parsePattern,
  type PathMatcher,
} from "../../../src/core/safety/policy/paths.js";

/** Parses a pattern the test knows is valid. */
function pattern(text: string): PathMatcher {
  const p = parsePattern(text);
  if (!p.ok) throw new Error(`bad test pattern ${text}: ${p.detail ?? ""}`);
  return p.value;
}

/** True when `raw` normalizes and matches `text`. */
function matches(text: string, raw: string, caseSensitive = true): boolean {
  const n = normalizePath(raw, caseSensitive);
  if (!n.ok) throw new Error(`bad test path ${raw}`);
  return matchPath(pattern(text), n.value, caseSensitive);
}

describe("section 4 §6.3 examples", () => {
  const rows: [string, string[], string[]][] = [
    ["/members/*", ["/members/100107"], ["/members/100107/accounts", "/members/"]],
    ["/members/*/accounts", ["/members/100107/accounts"], ["/members/100107/accounts/9"]],
    [
      "/Main.do?cmd=view*",
      ["/Main.do?cmd=viewMember&sid=77"],
      ["/Main.do?cmd=deleteMember", "/Main.do"],
    ],
    ["/login", ["/login", "/login?next=/home"], ["/login/help"]],
  ];
  for (const [p, yes, no] of rows) {
    for (const raw of yes)
      test(`${p} matches ${raw}`, () => {
        expect(matches(p, raw)).toBe(true);
      });
    for (const raw of no)
      test(`${p} rejects ${raw}`, () => {
        expect(matches(p, raw)).toBe(false);
      });
  }
});

describe("pattern rules", () => {
  test("* matches one or more characters, never /", () => {
    expect(matches("/a/*", "/a/x")).toBe(true);
    expect(matches("/a/*", "/a/x/y")).toBe(false);
    expect(matches("/a/x*", "/a/x")).toBe(false);
  });

  test("a query pattern needs every listed parameter; others are ignored", () => {
    expect(matches("/p?a=1&b=*", "/p?b=2&c=3&a=1")).toBe(true);
    expect(matches("/p?a=1&b=*", "/p?a=1")).toBe(false);
  });

  test("a repeated query parameter must match every time", () => {
    expect(matches("/Main.do?cmd=view*", "/Main.do?cmd=viewMember&cmd=deleteMember")).toBe(false);
  });

  test("the parse rejects patterns a clean path can never match", () => {
    for (const bad of [
      "members",
      "/a b",
      "/a//b",
      "/a/../b",
      "/a/./b",
      "/a;x",
      "/a#b",
      "/a%2Fb",
      "/a\\b",
      "/a/**",
      "/p?=1",
      "/p?a",
      "/p?a*=1",
    ]) {
      expect(parsePattern(bad).ok, bad).toBe(false);
    }
  });
});

describe("normalizing (section 4 §6.3)", () => {
  test("decodes percent codes once", () => {
    expect(matches("/members/*", "/members/%31%30%30107")).toBe(true);
  });

  test("an encoded slash, a backslash, or a null byte is malformed", () => {
    for (const raw of [
      "/members/1%2F2",
      "/members/1%2f2",
      "/members\\1",
      "/members/%00",
      "/members/1%252F2",
      "/members/1%5C2",
    ]) {
      const n = normalizePath(raw, true);
      expect(n.ok, raw).toBe(false);
      if (!n.ok) expect(n.failure).toBe("malformed");
    }
  });

  test("broken percent codes are malformed", () => {
    expect(normalizePath("/members/%E0%A4%A", true).ok).toBe(false);
  });

  test("collapses repeated slashes", () => {
    expect(matches("/members/*/accounts", "//members///100107//accounts")).toBe(true);
  });

  test("resolves . and .., and stops at the root", () => {
    expect(matches("/login", "/members/./../login")).toBe(true);
    expect(matches("/login", "/../../login")).toBe(true);
    expect(matches("/members/*", "/members/x/../100107")).toBe(true);
    // Why: a trailing `..` leaves a trailing slash, as in a browser. `/members/100107/` is another page.
    expect(matches("/members/*", "/members/100107/close/..")).toBe(false);
    expect(matches("/members/*/", "/members/100107/close/..")).toBe(true);
  });

  test("encoded dots resolve too", () => {
    expect(matches("/admin/*", "/members/%2e%2e/admin/users")).toBe(true);
    expect(matches("/members/*", "/members/%2e%2e/admin/users")).toBe(false);
  });

  test("strips ; path parameters before resolving ..", () => {
    expect(matches("/login", "/login;jsessionid=ABC123")).toBe(true);
    // Why: old Java servers read `..;x` as `..`. Resolving first would hide the jump.
    expect(matches("/members/*", "/members/100107/..;x/admin")).toBe(true);
    expect(matches("/admin", "/members/..;x/admin")).toBe(true);
  });

  test("drops the # fragment", () => {
    expect(matches("/login", "/login#top")).toBe(true);
    expect(matches("/Main.do?cmd=view*", "/Main.do#?cmd=viewMember")).toBe(false);
  });

  test("folds case only when the app says case_sensitive: false", () => {
    expect(matches("/login", "/LOGIN")).toBe(false);
    expect(matches("/login", "/LOGIN", false)).toBe(true);
    expect(matches("/Main.do?cmd=view*", "/main.DO?cmd=viewMember", false)).toBe(true);
  });

  test("the normal form is plain", () => {
    const n = normalizePath("//a/./b/../c;x=1?q=1#f", true);
    expect(n.ok && n.value.path).toBe("/a/c");
  });
});
