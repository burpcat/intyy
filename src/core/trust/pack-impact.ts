// Which approved keys a candidate pack revision would touch, and whether a passing regression batch covers each.
// Follows design section 8 §15.1 (impact and coverage) and §15.2 (which contexts); section 5 §7.4 (the frozen set).
// A key is touched when its frozen handler set hash would change. Pure but for the ports it reads.
import { buildFrozenSet, type PackLayer } from "../packs/merge.js";
import type { PackScope } from "../model/pack.js";
import type { HistoryLine } from "../model/score-history.js";
import type { ScoreKey } from "../model/score.js";
import { gatherFacts } from "./alerts.js";
import type { KeyFacts } from "./drift.js";
import { capabilityParts, keyText } from "./keys.js";
import type { ScoreDeps } from "./scores.js";

/** How specific a scope is, general to specific (section 5 §7.1). */
const RANK: Record<PackScope["level"], number> = { global: 0, app: 1, app_version: 2, tenant: 3 };

/**
 * True when a pack of `scope` is part of the frozen set of this tenant, app, and app version. The
 * build's frozen set loads global, app, and tenant packs only (`loadFrozenSetFor`: no `app_version` pack
 * exists yet), so an `app_version` scope touches nothing here (docs/decisions.md, M06).
 */
export function appliesTo(scope: PackScope, tenant: string, app: string): boolean {
  switch (scope.level) {
    case "global":
      return true;
    case "app":
      return scope.app === app;
    case "tenant":
      return scope.tenant === tenant && scope.app === app;
    case "app_version":
      return false;
  }
}

/** The layers with `candidate` standing in for the same scope's active revision (or added), general to specific. */
export function layersWith(active: readonly PackLayer[], candidate: PackLayer): PackLayer[] {
  const same = (l: PackLayer): boolean => JSON.stringify(l.scope) === JSON.stringify(candidate.scope);
  return [...active.filter((l) => !same(l)), candidate].sort((a, b) => RANK[a.scope.level] - RANK[b.scope.level]);
}

/** One approved key the candidate would touch. `after` is `null` when the candidate breaks this key's frozen set (`detail` says why). */
export type ImpactedKey = {
  key: ScoreKey;
  text: string;
  before: string | null;
  after: string | null;
  detail?: string;
};

/** What `pack impact` finds, and the facts it read (the coverage check reuses them). */
export type PackImpact = { impacted: ImpactedKey[]; facts: KeyFacts[] };

/**
 * Finds the approved keys of these tenants whose frozen handler set hash changes when `candidate` takes
 * its scope's place (section 8 §15.1 step 2). `layersFor` gives the active layers for one tenant and app.
 * No approved key means no impact, so the first pack approval needs no regression (docs/decisions.md, M06).
 */
export async function packImpact(
  deps: ScoreDeps,
  tenants: readonly string[],
  candidate: PackLayer,
  layersFor: (tenant: string, app: string) => Promise<PackLayer[]>,
): Promise<PackImpact> {
  const facts = await gatherFacts(deps, tenants);
  const impacted: ImpactedKey[] = [];
  for (const f of facts) {
    if (f.record.state !== "approved" || f.key.patch_revision !== null) continue;
    const app = capabilityParts(f.key.capability).name.split("/")[0] ?? "";
    if (!appliesTo(candidate.scope, f.key.tenant, app)) continue;
    const active = await layersFor(f.key.tenant, app);
    const ctx = { appVersion: f.key.app_version };
    const before = buildFrozenSet(active, ctx);
    const after = buildFrozenSet(layersWith(active, candidate), ctx);
    const beforeHash = before.ok ? before.value.runStart.hash : null;
    if (after.ok && beforeHash === after.value.runStart.hash) continue;
    impacted.push({
      key: f.key,
      text: keyText(f.key),
      before: beforeHash,
      after: after.ok ? after.value.runStart.hash : null,
      ...(after.ok ? {} : { detail: after.detail ?? after.failure }),
    });
  }
  return { impacted, facts };
}

/**
 * True when a regression batch that passed its gate, and was no drill, ran under `hash` (section 8 §15.1
 * step 4: "approval of the pack needs all of them to pass"). Reads the history's `batch` lines.
 */
export function regressionCovers(history: readonly HistoryLine[], hash: string | null): boolean {
  if (hash === null) return false;
  return history.some(
    (l) => l.event === "batch" && l.kind === "regression" && l.gate === "passed" && l.drill !== true && l.under.handler_set === hash,
  );
}

/** The impacted keys with no covering regression batch: what `pack approve` refuses on. */
export function uncovered(impact: PackImpact): ImpactedKey[] {
  return impact.impacted.filter((i) => {
    const f = impact.facts.find((x) => x.key.tenant === i.key.tenant && keyText(x.key) === i.text);
    return !regressionCovers(f?.history ?? [], i.after);
  });
}
