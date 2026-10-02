// Proves anchor expansion: `@commit_point`, `@step:<id>`, and `@each_request_step` resolve to
// an exact route key and counter, through the route map, and the three refusals.
// Design section 8 §6.3, §6.4; docs/decisions.md, M06 ("needs_at lists the request steps"). M06 task 8.
import { describe, expect, test } from "vitest";
import { requestStepsFor, resolveAnchor } from "../../../src/core/certify/anchors.js";
import type { RouteMap } from "../../../src/core/certify/route-map.js";

function routeMap(entries: Record<string, { route: string; nth: number }>): RouteMap {
  return new Map(Object.entries(entries));
}

describe("resolveAnchor: @commit_point", () => {
  test("resolveAnchor resolves @commit_point or says why not", () => {
    // no commit step named: no_commit_point
    {
      const map = routeMap({ click_confirm: { route: "POST /confirm", nth: 1 } });
      expect(resolveAnchor("@commit_point", map, null)).toEqual({ ok: false, failure: "no_commit_point" });
    }
    // the commit step sent no request: no_request
    {
      const map = routeMap({ type_member_id: { route: "POST /type", nth: 1 } });
      expect(resolveAnchor("@commit_point", map, "click_confirm")).toEqual({ ok: false, failure: "no_request" });
    }
    // resolves to the commit step's own route map entry
    {
      const map = routeMap({ click_confirm: { route: "POST /confirm", nth: 1 } });
      expect(resolveAnchor("@commit_point", map, "click_confirm")).toEqual({
        ok: true,
        value: { route: "POST /confirm", nth: 1 },
      });
    }
  });
});

describe("resolveAnchor: @each_request_step", () => {
  const map = routeMap({ click_search: { route: "POST /search", nth: 1 }, click_confirm: { route: "POST /confirm", nth: 1 } });

  test("resolveAnchor resolves @each_request_step from --at or says why not", () => {
    // no --at override: needs_at
    {
      expect(resolveAnchor("@each_request_step", map, "click_confirm")).toEqual({ ok: false, failure: "needs_at" });
    }
    // --at names a step with no request: no_request
    {
      expect(resolveAnchor("@each_request_step", map, "click_confirm", "@step:type_member_id")).toEqual({
        ok: false,
        failure: "no_request",
      });
    }
    // --at names a request step: resolves to it, ignoring the commit step
    {
      expect(resolveAnchor("@each_request_step", map, "click_confirm", "@step:click_search")).toEqual({
        ok: true,
        value: { route: "POST /search", nth: 1 },
      });
    }
  });
});

describe("resolveAnchor: @step:<id> (a suite extra case's own placement)", () => {
  const map = routeMap({ click_search: { route: "POST /search", nth: 1 } });

  test("resolveAnchor resolves @step:id from its route map entry", () => {
    // the named step sent no request: no_request
    {
      expect(resolveAnchor("@step:type_member_id", map, null)).toEqual({ ok: false, failure: "no_request" });
    }
    // resolves to the named step's route map entry; ignores its own --at param
    {
      expect(resolveAnchor("@step:click_search", map, null, "@step:type_member_id")).toEqual({
        ok: true,
        value: { route: "POST /search", nth: 1 },
      });
    }
  });
});

describe("requestStepsFor", () => {
  test("lists the route map's own step keys", () => {
    const map = routeMap({
      click_search: { route: "POST /search", nth: 1 },
      click_confirm: { route: "POST /confirm", nth: 1 },
    });
    expect(requestStepsFor(map)).toEqual(["click_search", "click_confirm"]);
  });
});
