// Proves merging packs by ID, the frozen set's filters (design section 5 §7.4), and the tie
// rule (§7.6). M06 task 1.
import { describe, expect, test } from "vitest";
import { Pack } from "../../../src/core/model/pack.js";
import { breakTie, buildFrozenSet, type FrozenSet, type PackLayer } from "../../../src/core/packs/merge.js";

/** One handler, its own target and condition, at the given scope and revision. `overrides`
 * marks a specific-scope layer that intentionally replaces a global one of the same ID. */
function layer(
  scope: PackLayer["scope"],
  revision: number,
  opts: {
    handlerId?: string;
    overrides?: boolean;
    disable?: string[];
    response?: Record<string, unknown>[];
    detector?: string;
    priority?: number;
    signInResponse?: boolean;
  } = {},
): PackLayer {
  const handlerId = opts.handlerId ?? "popup_handler";
  const detectorId = opts.detector ?? "popup_shown";
  const response = opts.signInResponse === true ? [{ type: "sign_in", risk: "idempotent" }] : opts.response ?? [{ type: "click", target: "ok_button", risk: "idempotent" }];
  const pack = Pack.parse({
    schema: "intyy.pack/1.0",
    scope,
    revision,
    reason: "Test layer.",
    targets: [{ id: "ok_button", description: "OK button", clues: { role: "button", name: "OK" } }],
    conditions: [{ id: detectorId, check: "element_visible", description: "The popup is showing", target: "ok_button" }],
    handlers: [
      {
        id: handlerId,
        description: "A dismissible popup.",
        class: "recoverable",
        detector: detectorId,
        ...(opts.priority === undefined ? {} : { priority: opts.priority }),
        ...(opts.overrides === true ? { overrides: true } : {}),
        response,
        limits: { per_step: 1, per_run: 1 },
        on_exhausted: { class: "hard_failure", failure: "app_error" },
        fixtures: { fire: [`${handlerId}_fire_01`], no_fire: [`${handlerId}_near_miss_01`] },
      },
    ],
    ...(opts.disable === undefined ? {} : { disable: opts.disable }),
    provenance: {
      runs: [],
      decisions: response
        .map((_a, i) => ({
          what: "risk" as const,
          subject: `${handlerId}.response[${String(i)}]`,
          value: "idempotent" as const,
          by: "op_017",
          at: "2026-09-30T00:00:00Z",
        })),
      sealed: null,
    },
  });
  return { scope, revision, pack };
}

const GLOBAL = { level: "global" as const };
const APP = { level: "app" as const, app: "kvfcu" };
const TENANT = { level: "tenant" as const, tenant: "keystone", app: "kvfcu" };

describe("merge by ID: the most specific scope wins whole", () => {
  test("merge by ID: the most specific scope wins whole", () => {
    {
      const globalLayer = layer(GLOBAL, 1);
      const appLayer = layer(APP, 4, { overrides: true, response: [{ type: "click", target: "ok_button", risk: "reversible" }] });
      const result = buildFrozenSet([globalLayer, appLayer], { appVersion: "9.2" });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.handlers).toHaveLength(1);
      expect(result.value.handlers[0]).toMatchObject({ id: "popup_handler", response: [{ type: "click", target: "ok_button", risk: "reversible" }] });
      expect(result.value.runStart.from).toEqual({ popup_handler: "app:kvfcu" });
      expect(result.value.runStart.packs).toEqual({ global: 1, "app:kvfcu": 4 });
    }
    {
      const globalLayer = layer(GLOBAL, 1);
      const tenantConditionOnly: PackLayer = {
        scope: TENANT,
        revision: 1,
        pack: Pack.parse({
          schema: "intyy.pack/1.0",
          scope: TENANT,
          revision: 1,
          reason: "Reword the detector.",
          targets: [],
          conditions: [
            { id: "popup_shown", overrides: true, check: "element_visible", description: "Tenant's own words", target: "ok_button" },
          ],
          handlers: [],
          provenance: { runs: [], decisions: [], sealed: null },
        }),
      };
      const result = buildFrozenSet([globalLayer, tenantConditionOnly], { appVersion: "9.2" });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.conditions).toHaveLength(1);
      expect(result.value.conditions[0]).toMatchObject({ description: "Tenant's own words" });
      expect(result.value.handlers.map((h) => h.id)).toEqual(["popup_handler"]);
    }
  });

});

describe("disable", () => {
  test("disable: an inherited handler drops quietly, an unknown ID only warns", () => {
    {
      const globalLayer = layer(GLOBAL, 1);
      const tenantLayer = layer(TENANT, 1, { disable: ["popup_handler"], handlerId: "tenant_only", detector: "tenant_only_shown" });
      const result = buildFrozenSet([globalLayer, tenantLayer], { appVersion: "9.2" });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.handlers.map((h) => h.id)).toEqual(["tenant_only"]);
      expect(result.value.warnings).toEqual([]);
    }
    {
      const globalLayer = layer(GLOBAL, 1);
      const tenantLayer = layer(TENANT, 1, { disable: ["no_such_handler"], handlerId: "tenant_only", detector: "tenant_only_shown" });
      const result = buildFrozenSet([globalLayer, tenantLayer], { appVersion: "9.2" });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.warnings).toEqual([
        { code: "handler_disable_unknown", handlerId: "no_such_handler", message: "disable names no_such_handler, which does not exist" },
      ]);
    }
  });

});

describe("no pack files: an empty frozen set, never handler_set_invalid", () => {
  test("zero layers gives an empty, valid set", () => {
    const result = buildFrozenSet([], { appVersion: "9.2" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.handlers).toEqual([]);
    expect(result.value.targets).toEqual([]);
    expect(result.value.conditions).toEqual([]);
    expect(result.value.runStart.ids).toEqual([]);
  });
});

describe("step 4: app_versions", () => {
  test("a tenant-only handler outside the bank's app version is dropped, with no warning", () => {
    const pack = Pack.parse({
      schema: "intyy.pack/1.0",
      scope: TENANT,
      revision: 1,
      reason: "Version-limited handler.",
      targets: [{ id: "ok_button", description: "OK", clues: { role: "button", name: "OK" } }],
      conditions: [{ id: "popup_shown", check: "element_visible", description: "x", target: "ok_button" }],
      handlers: [
        {
          id: "popup_handler",
          description: "x",
          class: "recoverable",
          detector: "popup_shown",
          app_versions: ["8.*"],
          response: [{ type: "click", target: "ok_button", risk: "idempotent" }],
          limits: { per_step: 1, per_run: 1 },
          on_exhausted: { class: "hard_failure", failure: "app_error" },
          fixtures: { fire: ["a"], no_fire: ["b"] },
        },
      ],
      provenance: {
        runs: [],
        decisions: [{ what: "risk", subject: "popup_handler.response[0]", value: "idempotent", by: "op_017", at: "2026-09-30T00:00:00Z" }],
        sealed: null,
      },
    });
    const result = buildFrozenSet([{ scope: TENANT, revision: 1, pack }], { appVersion: "9.2" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.handlers).toEqual([]);
    expect(result.value.warnings).toEqual([]);
  });
});

describe("steps 5 to 7: policy, artifact-paths, and session filters", () => {
  test("steps 5 to 7: policy, artifact-path, and session filters", () => {
    {
      const result = buildFrozenSet([layer(GLOBAL, 1)], { appVersion: "9.2", policyAllows: () => false });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.handlers).toEqual([]);
      expect(result.value.warnings).toEqual([{ code: "handler_excluded_by_policy", handlerId: "popup_handler", message: "popup_handler was dropped (handler_excluded_by_policy)" }]);
    }
    {
      const result = buildFrozenSet([layer(GLOBAL, 1)], { appVersion: "9.2", pathsAllow: () => false });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.warnings.map((w) => w.code)).toEqual(["handler_excluded_by_paths"]);
    }
    {
      const result = buildFrozenSet([layer(GLOBAL, 1, { signInResponse: true })], { appVersion: "9.2", hasSession: false });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.warnings.map((w) => w.code)).toEqual(["handler_excluded_no_session"]);
    }
    {
      const result = buildFrozenSet([layer(GLOBAL, 1, { signInResponse: true })], { appVersion: "9.2", hasSession: true });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.handlers.map((h) => h.id)).toEqual(["popup_handler"]);
    }
    {
      const pack = Pack.parse({
        schema: "intyy.pack/1.0",
        scope: GLOBAL,
        revision: 1,
        reason: "Naming handler.",
        targets: [],
        conditions: [{ id: "maintenance_shown", check: "text_visible", description: "x", text: "under maintenance", match: "contains" }],
        handlers: [
          { id: "maintenance", description: "x", class: "hard_failure", detector: "maintenance_shown", failure: "app_error", fixtures: { fire: ["a"], no_fire: ["b"] } },
        ],
        provenance: { runs: [], decisions: [], sealed: null },
      });
      const result = buildFrozenSet([{ scope: GLOBAL, revision: 1, pack }], { appVersion: "9.2", hasSession: false });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.handlers.map((h) => h.id)).toEqual(["maintenance"]);
      expect(result.value.warnings).toEqual([]);
    }
    {
      const result = buildFrozenSet([layer(GLOBAL, 1)], { appVersion: "9.2" });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.handlers.map((h) => h.id)).toEqual(["popup_handler"]);
      expect(result.value.warnings).toEqual([]);
    }
  });

});

describe("step 8: validation, step 9: hash", () => {
  test("step 8 and 9: a dangling detector fails the run, and the hash tracks the handlers", () => {
    {
      const bad = layer(GLOBAL, 1, { detector: "popup_shown" });
      // Why direct mutation, not the schema: a merged set with a broken cross-reference is
      // exactly what step 8 exists to catch; the pack itself parses fine on its own.
      const brokenPack = { ...bad.pack, conditions: [] };
      const result = buildFrozenSet([{ ...bad, pack: brokenPack }], { appVersion: "9.2" });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.failure).toBe("handler_set_invalid");
      expect(result.detail).toContain("popup_handler.detector -> popup_shown");
    }
    {
      const layers = [layer(GLOBAL, 1), layer(APP, 2, { handlerId: "other_handler", detector: "other_shown" })];
      const a = buildFrozenSet(layers, { appVersion: "9.2" });
      const b = buildFrozenSet(layers, { appVersion: "9.2" });
      expect(a.ok && b.ok).toBe(true);
      if (!a.ok || !b.ok) return;
      expect(a.value.runStart.hash).toBe(b.value.runStart.hash);
    }
    {
      const a = buildFrozenSet([layer(GLOBAL, 1)], { appVersion: "9.2" });
      const b = buildFrozenSet([layer(GLOBAL, 1, { priority: 5 })], { appVersion: "9.2" });
      expect(a.ok && b.ok).toBe(true);
      if (!a.ok || !b.ok) return;
      expect(a.value.runStart.hash).not.toBe(b.value.runStart.hash);
    }
  });

});

describe("breakTie (section 5 §7.6)", () => {
  const scoped = (ids: readonly { id: string; scope: PackLayer["scope"]; priority?: number }[]): Pick<FrozenSet, "handlers" | "handlerScope"> => ({
    handlers: ids.map(
      (i): FrozenSet["handlers"][number] => ({
        id: i.id,
        description: "x",
        class: "recoverable",
        detector: "d",
        ...(i.priority === undefined ? {} : { priority: i.priority }),
        response: [],
        limits: { per_step: 1, per_run: 1 },
        on_exhausted: { class: "hard_failure", failure: "app_error" },
        fixtures: { fire: [], no_fire: [] },
      }),
    ),
    handlerScope: new Map(ids.map((i) => [i.id, i.scope])),
  });

  test("breakTie: one match wins, then scope, then priority, then a named tie, and an empty list throws", () => {
    {
      expect(breakTie(["only_one"], scoped([{ id: "only_one", scope: GLOBAL }]))).toEqual({ winner: "only_one" });
    }
    {
      const frozen = scoped([{ id: "g", scope: GLOBAL }, { id: "t", scope: TENANT }]);
      expect(breakTie(["g", "t"], frozen)).toEqual({ winner: "t" });
    }
    {
      const frozen = scoped([{ id: "low", scope: APP, priority: 0 }, { id: "high", scope: APP, priority: 1 }]);
      expect(breakTie(["low", "high"], frozen)).toEqual({ winner: "high" });
    }
    {
      const frozen = scoped([{ id: "a", scope: APP, priority: 1 }, { id: "b", scope: APP, priority: 1 }]);
      const result = breakTie(["a", "b"], frozen);
      expect("tied" in result && [...result.tied].sort()).toEqual(["a", "b"]);
    }
    {
      expect(() => breakTie([], scoped([]))).toThrow();
    }
  });

});
