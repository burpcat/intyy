// Proves the allowlist: exact hosts, allow minus deny, irreversible paths, actions and keys per actor.
// Design section 4 §6.1, §6.2, §6.4, §6.8, §6.9, §6.10; M02 task 2.
import { describe, expect, test } from "vitest";
import type { ActionType } from "../../../src/core/model/policy.js";
import {
  buildAllowlist,
  checkActionType,
  checkKey,
} from "../../../src/core/safety/policy/allowlist.js";
import type { Actor } from "../../../src/core/safety/rules.js";

const ORIGIN = "http://127.0.0.1:8080";

const list = buildAllowlist({
  origin: ORIGIN,
  extraOrigins: ["http://127.0.0.1:9123"],
  paths: {
    allow: ["/login", "/members/*", "/accounts/*/close", "/Main.do?cmd=view*"],
    deny: ["/members/export", "/__test__/*"],
    irreversible: ["/accounts/*/close"],
    case_sensitive: true,
  },
  browser: { popups: "allowlist" },
});

describe("hosts (section 4 §6.2)", () => {
  test("the origin and extra origins are allowed, with the same paths", () => {
    expect(list.check(`${ORIGIN}/login`, "document")).toEqual({
      allowed: true,
      irreversible: false,
    });
    expect(list.check("http://127.0.0.1:9123/login", "document").allowed).toBe(true);
  });

  test("the match is exact: scheme, host, and port", () => {
    for (const url of [
      "https://127.0.0.1:8080/login",
      "http://127.0.0.1:8081/login",
      "http://localhost:8080/login",
      "https://www.ncua.gov/",
      "http://sub.127.0.0.1:8080/login",
    ]) {
      expect(list.check(url, "document"), url).toEqual({
        allowed: false,
        rule: "allowlist.host",
      });
    }
  });

  test("every request kind checks the host", () => {
    expect(list.check("https://www.ncua.gov/logo.png", "resource").allowed).toBe(false);
    expect(list.check("wss://www.ncua.gov/live", "websocket").allowed).toBe(false);
    expect(list.check("ws://127.0.0.1:8080/live", "websocket").allowed).toBe(true);
  });

  test("resource requests need the host only", () => {
    expect(list.check(`${ORIGIN}/static/app.css`, "resource").allowed).toBe(true);
  });

  test("non-web addresses are blocked", () => {
    for (const url of ["data:text/html,hi", "file:///etc/hosts", "javascript:alert(1)", "nope"]) {
      expect(list.check(url, "document").allowed, url).toBe(false);
    }
  });
});

describe("paths (section 4 §6.3, §6.4)", () => {
  test("paths: deny by default, deny beats allow, queries count, tricks are blocked, irreversible paths are marked", () => {
    expect(list.check(`${ORIGIN}/admin`, "document")).toEqual({
      allowed: false,
      rule: "allowlist.path",
    });
    expect(list.check(`${ORIGIN}/members/export`, "document")).toEqual({
      allowed: false,
      rule: "allowlist.path",
    });
    expect(list.check(`${ORIGIN}/__test__/faultlog`, "document").allowed).toBe(false);
    expect(list.check(`${ORIGIN}/Main.do?cmd=viewMember`, "document").allowed).toBe(true);
    expect(list.check(`${ORIGIN}/Main.do?cmd=deleteMember`, "document").allowed).toBe(false);
    expect(list.check(`${ORIGIN}/members/1%2F2`, "document")).toEqual({
      allowed: false,
      rule: "allowlist.path_malformed",
    });
    expect(list.check(`${ORIGIN}/members/x/..;y/export`, "document").allowed).toBe(false);
    expect(list.check(`${ORIGIN}/members/%2e%2e/__test__/reset`, "document").allowed).toBe(false);
    expect(list.check(`${ORIGIN}/accounts/9/close`, "document")).toEqual({
      allowed: true,
      irreversible: true,
    });
  });

  test("case folds only when the app says so", () => {
    expect(list.check(`${ORIGIN}/LOGIN`, "document").allowed).toBe(false);
    const folded = buildAllowlist({
      origin: ORIGIN,
      extraOrigins: [],
      paths: { allow: ["/login"], deny: [], irreversible: [], case_sensitive: false },
      browser: { popups: "block" },
    });
    expect(folded.check(`${ORIGIN}/LOGIN`, "document").allowed).toBe(true);
    expect(folded.popups).toBe(false);
    expect(list.popups).toBe(true);
  });
});

describe("action types per actor (section 4 §6.9)", () => {
  const all: ActionType[] = [
    "navigate",
    "click",
    "type",
    "select",
    "set_checked",
    "press",
    "read",
    "scroll",
  ];
  const allowed: Record<Actor, ActionType[]> = {
    engine: ["navigate", "click", "type", "select", "set_checked", "press", "read"],
    handler: ["navigate", "click", "type", "select", "set_checked", "press"],
    llm: all,
    reviewer: ["navigate", "click", "type", "select", "set_checked", "press"],
    human: all,
  };
  test("each actor gets exactly its action types", () => {
    for (const [actor, types] of Object.entries(allowed) as [Actor, ActionType[]][]) {
      for (const type of all) {
        const want = types.includes(type) ? null : "allowlist.action";
        expect(checkActionType(actor, type, all), `${actor} ${type}`).toBe(want);
      }
    }
  });

  test("the merged policy narrows every gated actor", () => {
    expect(checkActionType("llm", "scroll", ["click"])).toBe("allowlist.action");
    expect(checkActionType("engine", "click", ["click"])).toBeNull();
  });
});

describe("keys (section 4 §6.9)", () => {
  const policy = {
    actions: { types: [], keys: ["Enter", "Tab", "Escape", "ArrowUp", "PageDown"] },
    risk: {
      irreversible_words: [],
      reversible_words: [],
      safe_words: [],
      key_labels: { F2: "search" },
    },
  };

  test("keys: global keys pass, off-list and unmapped function keys block, reviewer and human differ", () => {
    expect(checkKey("engine", "Enter", policy)).toBeNull();
    expect(checkKey("llm", "PageDown", policy)).toBeNull();
    expect(checkKey("engine", "Delete", policy)).toBe("allowlist.key");
    expect(checkKey("engine", "F2", policy)).toBeNull();
    expect(checkKey("engine", "F10", policy)).toBe("allowlist.key");
    expect(checkKey("reviewer", "Tab", policy)).toBeNull();
    expect(checkKey("reviewer", "Escape", policy)).toBeNull();
    expect(checkKey("reviewer", "Enter", policy)).toBe("allowlist.key");
    expect(checkKey("reviewer", "F2", policy)).toBe("allowlist.key");
    expect(checkKey("human", "F10", policy)).toBeNull();
  });

});
