// Proves the pure parts of pack impact and coverage (design section 8 §15.1, §15.2): `appliesTo` says
// which pack scopes reach a tenant's app (global, app, tenant; `app_version` reaches nothing in this
// build); `layersWith` swaps the candidate in for its own scope, general to specific, and changes the
// frozen set hash; `regressionCovers` accepts only a passed, non-drill regression batch under the new
// hash; `uncovered` lists the impacted keys that have none. No files. M11 task 5.
import { describe, expect, test } from "vitest";
import { buildFrozenSet, type PackLayer } from "../../../src/core/packs/merge.js";
import { Pack, type PackScope } from "../../../src/core/model/pack.js";
import type { HistoryLine } from "../../../src/core/model/score-history.js";
import { appliesTo, layersWith, regressionCovers, uncovered, type PackImpact } from "../../../src/core/trust/pack-impact.js";
import { keyText } from "../../../src/core/trust/keys.js";
import { rebuild } from "../../../src/core/trust/rebuild.js";
import { approved, batch, h, HASHES, KEY } from "./kit.js";

const APP_SCOPE: PackScope = { level: "app", app: "kvfcu" };
const GLOBAL_SCOPE: PackScope = { level: "global" };

function handler(id: string): Record<string, unknown> {
  return {
    id,
    description: "A dismissible popup.",
    class: "recoverable",
    detector: "popup_shown",
    response: [{ type: "click", target: "ok_button", risk: "idempotent" }],
    limits: { per_step: 1, per_run: 1 },
    on_exhausted: { class: "hard_failure", failure: "app_error" },
    fixtures: { fire: [`${id}_fire`], no_fire: [`${id}_near_miss`] },
  };
}

/** A pack with one handler per ID. */
function layer(scope: PackScope, revision: number, handlers: string[]): PackLayer {
  const pack = Pack.parse({
    schema: "intyy.pack/1.0",
    scope,
    revision,
    reason: "A test pack.",
    targets: [{ id: "ok_button", description: "OK button", clues: { role: "button", name: "OK" } }],
    conditions: [{ id: "popup_shown", check: "element_visible", description: "The popup is showing", target: "ok_button" }],
    handlers: handlers.map(handler),
    provenance: { runs: [], decisions: [], sealed: null },
  });
  return { scope, revision, pack };
}

const hashOf = (layers: PackLayer[]): string => {
  const set = buildFrozenSet(layers, { appVersion: "9.2" });
  if (!set.ok) throw new Error("test setup: frozen set did not build");
  return set.value.runStart.hash;
};

describe("appliesTo", () => {
  test("appliesTo reaches the right tenants and apps for each pack scope", () => {
    // global reaches every tenant and app
    expect(appliesTo(GLOBAL_SCOPE, "keystone", "kvfcu")).toBe(true);
    expect(appliesTo(GLOBAL_SCOPE, "lakeshore", "other")).toBe(true);
    // an app pack reaches every tenant on that app only
    expect(appliesTo(APP_SCOPE, "keystone", "kvfcu")).toBe(true);
    expect(appliesTo(APP_SCOPE, "lakeshore", "kvfcu")).toBe(true);
    expect(appliesTo(APP_SCOPE, "keystone", "other")).toBe(false);
    // a tenant pack reaches that tenant on that app only
    {
      const scope: PackScope = { level: "tenant", tenant: "keystone", app: "kvfcu" };
      expect(appliesTo(scope, "keystone", "kvfcu")).toBe(true);
      expect(appliesTo(scope, "lakeshore", "kvfcu")).toBe(false);
      expect(appliesTo(scope, "keystone", "other")).toBe(false);
    }
    // an app_version pack reaches nothing: the build's frozen set has no such layer
    expect(appliesTo({ level: "app_version", app: "kvfcu", app_versions: ["9.*"] }, "keystone", "kvfcu")).toBe(false);
  });
});

describe("layersWith", () => {
  const global1 = layer(GLOBAL_SCOPE, 1, ["g_one"]);
  const app1 = layer(APP_SCOPE, 1, ["a_one"]);
  const tenant1 = layer({ level: "tenant", tenant: "keystone", app: "kvfcu" }, 1, ["t_one"]);

  test("layersWith replaces or adds the candidate layer without changing the active list, and moves the frozen hash", () => {
    // the candidate replaces the active layer of its own scope
    {
      const app2 = layer(APP_SCOPE, 2, ["a_one", "a_two"]);
      const out = layersWith([global1, app1], app2);
      expect(out.map((l) => `${l.scope.level}@${String(l.revision)}`)).toEqual(["global@1", "app@2"]);
    }
    // a candidate for a scope with no active layer is added, and the order stays general to specific
    {
      const out = layersWith([tenant1, global1], app1);
      expect(out.map((l) => l.scope.level)).toEqual(["global", "app", "tenant"]);
    }
    // it does not change the active list
    {
      const active = [global1, app1];
      layersWith(active, layer(APP_SCOPE, 2, ["a_one"]));
      expect(active).toEqual([global1, app1]);
    }
    // a candidate that adds a handler changes the frozen set hash; the same pack does not
    {
      const active = [global1, app1];
      const before = hashOf(active);
      expect(hashOf(layersWith(active, layer(APP_SCOPE, 2, ["a_one", "a_two"])))).not.toBe(before);
      // Same content as the active layer, so the same hash (the revision number is not in the hash's content).
      expect(hashOf(layersWith(active, app1))).toBe(before);
    }
  });
});

describe("regressionCovers", () => {
  const NEW = h("new-handler-set");
  const under = (handlerSet: string) => ({ engine: "0.4.0", handler_set: handlerSet, jev: null, session: null, check: null });
  const reg = (over: Partial<Extract<HistoryLine, { event: "batch" }>> = {}): HistoryLine =>
    batch(3, "batch_reg", { kind: "regression", gate: "passed", under: under(NEW), ...over });

  test("regressionCovers needs a passed, non-drill regression under the hash", () => {
    // a passed, non-drill regression under the hash covers it
    expect(regressionCovers([reg()], NEW)).toBe(true);
    // a failed gate, a drill, another hash, or another kind does not
    expect(regressionCovers([reg({ gate: "failed" })], NEW)).toBe(false);
    expect(regressionCovers([reg({ drill: true })], NEW)).toBe(false);
    expect(regressionCovers([reg({ under: under(h("other")) })], NEW)).toBe(false);
    expect(regressionCovers([reg({ kind: "full" })], NEW)).toBe(false);
    expect(regressionCovers([reg({ kind: "quick" })], NEW)).toBe(false);
    // non-batch lines and an empty history do not cover; a null hash is never covered
    expect(regressionCovers([], NEW)).toBe(false);
    expect(regressionCovers([approved(1)], NEW)).toBe(false);
    expect(regressionCovers([reg()], null)).toBe(false);
    // one covering line among others is enough
    expect(regressionCovers([reg({ gate: "failed" }), approved(4), reg()], NEW)).toBe(true);
  });
});

describe("uncovered", () => {
  const NEW = h("new-handler-set");
  const under = { engine: "0.4.0", handler_set: NEW, jev: null, session: null, check: null };
  const keyB = { ...KEY, capability: "kvfcu/close_share_subaccount@1.0.0" };
  function factsOf(key: typeof KEY, lines: HistoryLine[]): PackImpact["facts"][number] {
    const record = rebuild(key, HASHES, lines);
    if (!record.ok) throw new Error("test setup: rebuild failed");
    return { key, record: record.value, history: lines, live: [], timeouts: {} };
  }
  const impacted = (key: typeof KEY, after: string | null): PackImpact["impacted"][number] => ({ key, text: keyText(key), before: h("old"), after });

  test("uncovered lists impacted keys with no covering regression, and only those", () => {
    // lists the impacted keys that have no covering regression, and only those
    {
      const covering = [approved(1), batch(2, "batch_reg", { kind: "regression", gate: "passed", under })];
      const failed = [approved(1), batch(2, "batch_reg", { kind: "regression", gate: "failed", under })];
      const impact: PackImpact = {
        impacted: [impacted(KEY, NEW), impacted(keyB, NEW)],
        facts: [factsOf(KEY, covering), factsOf(keyB, failed)],
      };
      expect(uncovered(impact).map((i) => i.text)).toEqual([keyText(keyB)]);
    }
    // nothing impacted: nothing uncovered
    expect(uncovered({ impacted: [], facts: [factsOf(KEY, [approved(1)])] })).toEqual([]);
    // a key whose candidate frozen set is invalid (after is null) is always uncovered
    {
      const lines = [approved(1), batch(2, "batch_reg", { kind: "regression", gate: "passed", under })];
      expect(uncovered({ impacted: [impacted(KEY, null)], facts: [factsOf(KEY, lines)] })).toHaveLength(1);
    }
    // facts of another tenant's key with the same text do not cover
    {
      const covering = [approved(1), batch(2, "batch_reg", { kind: "regression", gate: "passed", under })];
      const other = { ...KEY, tenant: "lakeshore" };
      const impact: PackImpact = {
        impacted: [impacted(KEY, NEW)],
        facts: [factsOf(other, covering), factsOf(KEY, [approved(1)])],
      };
      expect(uncovered(impact)).toHaveLength(1);
    }
  });
});
