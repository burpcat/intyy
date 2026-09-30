// Merging packs by ID across scopes, building the frozen set, and the tie rule.
// Follows design section 5 §7 (scope, merge, frozen set) and §7.6 (when two handlers match).
import { fail, ok, type Outcome } from "../../ports/outcome.js";
import { hashJson } from "../model/canonical.js";
import type { z } from "zod";
import { NestedCheck } from "../model/artifact/conditions.js";
import type { Handler, Pack, PackCondition, PackScope, PackTarget } from "../model/pack.js";
import { handlerMatchesVersion } from "./checks.js";

type NestedCheckShape = z.infer<typeof NestedCheck>;

/** One loaded scope layer, general to specific order (section 5 §7.1). */
export type PackLayer = { scope: PackScope; revision: number; pack: Pack };

/** A non-fatal problem found while building the frozen set (section 5 §7.4 steps 5 to 7, §7.3).
 * Dropping is always safe; these are logged, never failed on. */
export type FrozenSetWarning = { readonly code: string; readonly handlerId: string; readonly message: string };

/** Outside facts the frozen set's policy and artifact filters need (section 5 §7.4 steps 5, 6, 7). */
export type FrozenSetContext = {
  /** The bank's own app version, for step 4. */
  appVersion: string;
  /** True when every action type, key, secret, and fixed path the handler's response uses is
   * allowed by the effective policy (step 5). Undefined skips the filter. */
  policyAllows?(h: Handler): boolean;
  /** True when every fixed `navigate` path the handler's response uses sits inside the
   * artifact's own `runs_on.paths` (step 6). Undefined skips the filter. */
  pathsAllow?(h: Handler): boolean;
  /** True when the running artifact has a `session` link, needed by any `sign_in` response
   * action (step 7). Undefined skips the filter. */
  hasSession?: boolean;
};

/** `from` label section 5 §7.5 uses in `run_start`: `global`, `app:kvfcu`, `tenant:lakeshore/kvfcu`. */
function scopeLabel(scope: PackScope): string {
  switch (scope.level) {
    case "global":
      return "global";
    case "app":
      return `app:${scope.app}`;
    case "app_version":
      return `app_version:${scope.app}:${scope.app_versions.join("+")}`;
    case "tenant":
      return `tenant:${scope.tenant}/${scope.app}`;
  }
}

/** Merges one kind of named object by ID: the most specific scope's copy wins whole, no
 * field-level merge (section 5 §7.2). `layers` must already run general to specific. */
function mergeById<T extends { id: string }>(
  layers: readonly { scope: PackScope; items: readonly T[] }[],
): Map<string, { item: T; scope: PackScope }> {
  const merged = new Map<string, { item: T; scope: PackScope }>();
  for (const layer of layers) {
    for (const item of layer.items) merged.set(item.id, { item, scope: layer.scope });
  }
  return merged;
}

/** The merged, filtered handler set: what `run_start` records, plus the objects the ladder needs. */
export type FrozenSet = {
  targets: readonly PackTarget[];
  conditions: readonly PackCondition[];
  handlers: readonly Handler[];
  /** Handler ID to the scope it came from, for the tie rule (section 5 §7.6) and `run_start`. */
  handlerScope: ReadonlyMap<string, PackScope>;
  /** `run_start.handlers` (section 5 §7.5). */
  runStart: {
    ids: readonly string[];
    packs: Readonly<Record<string, number>>;
    from: Readonly<Record<string, string>>;
    hash: string;
  };
  warnings: readonly FrozenSetWarning[];
};

/** Walks one condition's tree to find every dangling target or `ref` (section 5 §7.4 step 8). */
function walk(
  node: PackCondition | NestedCheckShape,
  targetIds: ReadonlySet<string>,
  conditionIds: ReadonlySet<string>,
  onBroken: (what: string) => void,
): void {
  if ("ref" in node) {
    if (!conditionIds.has(node.ref)) onBroken(node.ref);
    return;
  }
  if ("checks" in node) {
    node.checks.forEach((c) => {
      walk(c, targetIds, conditionIds, onBroken);
    });
    return;
  }
  if ("of" in node) {
    walk(node.of, targetIds, conditionIds, onBroken);
    return;
  }
  if ("target" in node && !targetIds.has(node.target)) onBroken(node.target);
  if ("within" in node && node.within !== undefined && !targetIds.has(node.within)) onBroken(node.within);
}

/**
 * Builds the frozen set from every matching scope's active revision (section 5 §7.4): merges by
 * ID, applies `disable`, drops handlers by app version, policy, artifact paths, and session,
 * validates every reference resolves, then hashes and records it. `layers` is empty when no
 * pack file exists anywhere: the frozen set is then empty, not an error (owner decision,
 * 2026-09-30). Any dangling reference fails the whole run: `handler_set_invalid`, phase `start`.
 */
export function buildFrozenSet(
  layers: readonly PackLayer[],
  ctx: FrozenSetContext,
): Outcome<FrozenSet, "handler_set_invalid"> {
  const warnings: FrozenSetWarning[] = [];

  const targetLayers = layers.map((l) => ({ scope: l.scope, items: l.pack.targets }));
  const conditionLayers = layers.map((l) => ({ scope: l.scope, items: l.pack.conditions }));
  const handlerLayers = layers.map((l) => ({ scope: l.scope, items: l.pack.handlers }));
  const mergedTargets = mergeById(targetLayers);
  const mergedConditions = mergeById(conditionLayers);
  let mergedHandlers = mergeById(handlerLayers);

  // Step 3: apply `disable` lists (section 5 §7.3). Any layer may list one; a name that
  // resolves to nothing is a warning, never fatal (the parent may have already removed it).
  const disabled = new Set(layers.flatMap((l) => l.pack.disable ?? []));
  for (const id of disabled) {
    if (mergedHandlers.has(id)) mergedHandlers.delete(id);
    else warnings.push({ code: "handler_disable_unknown", handlerId: id, message: `disable names ${id}, which does not exist` });
  }

  // Step 4: drop handlers whose app_versions do not match the bank's version.
  mergedHandlers = new Map(
    [...mergedHandlers].filter(([, v]) => handlerMatchesVersion(v.item, ctx.appVersion)),
  );

  // Steps 5 to 7: the policy, artifact-paths, and session filters. Each drop is a warning.
  const stepFilters: readonly [string, (h: Handler) => boolean | undefined][] = [
    ["handler_excluded_by_policy", (h) => ctx.policyAllows?.(h)],
    ["handler_excluded_by_paths", (h) => ctx.pathsAllow?.(h)],
    [
      "handler_excluded_no_session",
      (h) =>
        ctx.hasSession === undefined || h.class !== "recoverable" || !h.response.some((a) => a.type === "sign_in")
          ? undefined
          : ctx.hasSession,
    ],
  ];
  for (const [code, allowed] of stepFilters) {
    mergedHandlers = new Map(
      [...mergedHandlers].filter(([id, v]) => {
        const result = allowed(v.item);
        if (result === false) warnings.push({ code, handlerId: id, message: `${id} was dropped (${code})` });
        return result !== false;
      }),
    );
  }

  // Step 8: validate. Every reference must resolve in the final merged set.
  const targetIds = new Set(mergedTargets.keys());
  const conditionIds = new Set(mergedConditions.keys());
  const broken: string[] = [];
  for (const { item: c } of mergedConditions.values()) {
    walk(c, targetIds, conditionIds, (what) => broken.push(`conditions.${c.id} -> ${what}`));
  }
  for (const { item: h } of mergedHandlers.values()) {
    if (!conditionIds.has(h.detector)) broken.push(`handlers.${h.id}.detector -> ${h.detector}`);
    if (h.class === "recoverable") {
      if (h.done_when !== undefined && !conditionIds.has(h.done_when)) {
        broken.push(`handlers.${h.id}.done_when -> ${h.done_when}`);
      }
      h.response.forEach((a, i) => {
        if ((a.type === "click" || a.type === "type" || a.type === "select" || a.type === "set_checked") && !targetIds.has(a.target)) {
          broken.push(`handlers.${h.id}.response[${String(i)}] -> ${a.target}`);
        }
      });
    }
  }
  if (broken.length > 0) {
    return fail("handler_set_invalid", broken.join("; "));
  }

  // Steps 9, 10: hash and record. Sorted by ID so the same packs always give the same hash.
  const sortedTargets = [...mergedTargets.values()].map((v) => v.item).sort((a, b) => (a.id < b.id ? -1 : 1));
  const sortedConditions = [...mergedConditions.values()].map((v) => v.item).sort((a, b) => (a.id < b.id ? -1 : 1));
  const sortedHandlers = [...mergedHandlers.values()].map((v) => v.item).sort((a, b) => (a.id < b.id ? -1 : 1));
  const hash = hashJson({ targets: sortedTargets, conditions: sortedConditions, handlers: sortedHandlers });

  const from: Record<string, string> = {};
  const handlerScope = new Map<string, PackScope>();
  for (const [id, v] of mergedHandlers) {
    from[id] = scopeLabel(v.scope);
    handlerScope.set(id, v.scope);
  }
  const packs: Record<string, number> = {};
  for (const l of layers) packs[scopeLabel(l.scope)] = l.revision;

  return ok({
    targets: sortedTargets,
    conditions: sortedConditions,
    handlers: sortedHandlers,
    handlerScope,
    runStart: { ids: sortedHandlers.map((h) => h.id), packs, from, hash },
    warnings,
  });
}

/** How far a scope reaches (section 5 §7.6: "most specific scope wins"). */
const SPECIFICITY: Record<PackScope["level"], number> = { global: 0, app: 1, app_version: 2, tenant: 3 };

/** The tie rule (section 5 §7.6): most specific scope wins, then the higher `priority`, else
 * every tied ID climbs to rung 2. `matched` must hold at least one handler ID. */
export function breakTie(
  matched: readonly string[],
  frozen: Pick<FrozenSet, "handlers" | "handlerScope">,
): { winner: string } | { tied: readonly string[] } {
  const first = matched[0];
  if (first === undefined) throw new Error("breakTie needs at least one matched handler");
  if (matched.length === 1) return { winner: first };
  const byId = new Map(frozen.handlers.map((h) => [h.id, h]));
  const specOf = (id: string): number => SPECIFICITY[frozen.handlerScope.get(id)?.level ?? "global"];
  const maxSpec = Math.max(...matched.map(specOf));
  const atMaxSpec = matched.filter((id) => specOf(id) === maxSpec);
  const soleSpecWinner = atMaxSpec[0];
  if (atMaxSpec.length === 1 && soleSpecWinner !== undefined) return { winner: soleSpecWinner };
  const priorityOf = (id: string): number => byId.get(id)?.priority ?? 0;
  const maxPriority = Math.max(...atMaxSpec.map(priorityOf));
  const atMaxPriority = atMaxSpec.filter((id) => priorityOf(id) === maxPriority);
  const solePriorityWinner = atMaxPriority[0];
  if (atMaxPriority.length === 1 && solePriorityWinner !== undefined) return { winner: solePriorityWinner };
  return { tied: atMaxPriority };
}
