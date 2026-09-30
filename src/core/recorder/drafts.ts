// Recorder step 12 (section 6 §14.2, §14.12; section 5 §12.2 to §12.4): one draft handler per
// run of consecutive `incidental` actions, and the `normal` fixtures the main flow used.
//
// Simplification (ponytail: detector drafting needs "text the normal screen lacks" (section 5
// §12.3), which means comparing against every `normal` fixture already sealed for this app and
// location — a cross-candidate, cross-run comparison this recorder call does not have): the
// draft detector uses the interruption's own new landmark (or the acted control alone, with no
// landmark) instead of a lacks-in-normal diff. A human edits the draft before it is adopted
// (section 5 §12.3: "The draft is a start, not a decision"), so this is a starting point only.
import type { HandlerDraft, RiskHint } from "../model/handler-draft.js";
import { fromA11ySnapshot } from "../targets/a11y-snapshot.js";
import { ConditionRegistry, elementVisibleCheck, locationCheck, textVisibleCheck } from "./conditions.js";
import { toPathPattern } from "./paths.js";
import type { Snapshots } from "./steps.js";
import type { TaggedAction } from "./tags.js";
import { buildTargets, screenNameOf, slugify } from "./targets.js";

/** Consecutive `incidental` actions, in the run's own turn order (section 6 §14.12). */
function incidentalGroups(tagged: readonly TaggedAction[]): TaggedAction[][] {
  const groups: TaggedAction[][] = [];
  let current: TaggedAction[] = [];
  for (const a of tagged) {
    if (a.effectiveTag === "incidental") {
      current.push(a);
    } else if (current.length > 0) {
      groups.push(current);
      current = [];
    }
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

/** The draft class (section 5 §12.4). A human typing a known input, `[human_text]`, or
 * `[secret]`, or the gate classing any action possibly irreversible (a logged approval hint,
 * `riskHint !== null`), both need a human. Otherwise: `recoverable`. */
function classOf(group: readonly TaggedAction[]): "recoverable" | "needs_human" {
  const needsHuman = group.some((a) => {
    if (a.riskHint !== null) return true;
    const v = a.value ?? "";
    return v === "[human_text]" || v === "[secret]" || /^\{input\.[a-z0-9_]+\}$/.test(v);
  });
  return needsHuman ? "needs_human" : "recoverable";
}

/** One draft handler's ID, from its first action's screen and turn (deterministic, unique per
 * group since two groups never share a turn). */
function draftId(group: readonly TaggedAction[]): string {
  const first = group[0];
  const name = first === undefined ? "trouble" : screenNameOf(first.beforeLocation);
  const turn = first === undefined ? 0 : first.turn;
  return `${name === "" ? "trouble" : name}_t${String(turn)}`;
}

/** Drafts one handler for one run of consecutive incidental actions (section 5 §12.2 to §12.4). */
function draftHandler(
  group: readonly TaggedAction[],
  app: string,
  tenant: string,
  appVersion: string,
  snapshots: Snapshots,
): HandlerDraft {
  const id = draftId(group);
  const { targets, targetIdOf } = buildTargets(group);
  const registry = new ConditionRegistry();
  const first = group[0];
  const firstTargetId = first === undefined ? null : targetIdOf.get(first) ?? null;
  const detectorChecks = firstTargetId === null ? [] : [elementVisibleCheck(firstTargetId)];
  if (first !== undefined) {
    const before = snapshots.a11yByTurn.get(first.turn - 1);
    const after = snapshots.a11yByTurn.get(first.turn);
    if (before !== undefined && after !== undefined) {
      const bv = fromA11ySnapshot(before, first.beforeLocation);
      const av = fromA11ySnapshot(after, first.beforeLocation);
      const landmark = av.elements
        .filter((e) => (e.role === "heading" || e.role === "text") && !bv.elements.some((b) => b.text === e.text && b.name === e.name))
        .map((e) => e.text ?? e.name)
        .find((t): t is string => t !== undefined);
      if (landmark !== undefined) detectorChecks.push(textVisibleCheck(landmark));
    }
  }
  if (detectorChecks.length === 0 && first !== undefined) {
    detectorChecks.push(locationCheck(toPathPattern(first.beforeLocation)));
  }
  const soleCheck = detectorChecks.length === 1 ? detectorChecks[0] : undefined;
  const detectorId = registry.intern(
    soleCheck ?? { check: "all_of", checks: detectorChecks },
    `${id}_detector`,
    `The ${id} interruption is showing.`,
  );
  const risk_hints: RiskHint[] = group.map((a) => ({
    subject: `${a.runId}#${String(a.seq)}`,
    class: a.riskHint ?? "irreversible",
    source: a.riskHint === null ? "rules" : "gate",
  }));
  const cls = classOf(group);
  const handler: Record<string, unknown> = { id, class: cls, detector: detectorId, fixtures: { fire: `${id}_fire` } };
  if (cls === "recoverable") {
    handler.response = group.map((a) => ({ type: a.tool, target: targetIdOf.get(a) ?? null }));
  }
  return {
    schema: "intyy.handler_draft/1.0",
    id,
    app,
    source: {
      kind: "recorder",
      run_id: group[0]?.runId ?? "",
      seq: group.map((a) => a.seq),
      tenant,
      app_version: appVersion,
    },
    suggested_scope: "tenant",
    targets: [...targets],
    conditions: [...registry.list()],
    handler,
    risk_hints,
    fixtures: { fire: `${id}_fire`, no_fire: [] },
  };
}

/** What {@link buildDrafts} returns. */
export type DraftsResult = {
  drafts: readonly HandlerDraft[];
  /** Each drafted action's fate, as `handler_draft:<id>` (section 2 §17.3, `became`). */
  became: ReadonlyMap<TaggedAction, string>;
};

/** One draft handler per run of consecutive `incidental` actions (section 6 §14.12). */
export function buildDrafts(
  tagged: readonly TaggedAction[],
  app: string,
  tenant: string,
  appVersion: string,
  snapshots: Snapshots,
): DraftsResult {
  const drafts: HandlerDraft[] = [];
  const became = new Map<TaggedAction, string>();
  for (const group of incidentalGroups(tagged)) {
    const draft = draftHandler(group, app, tenant, appVersion, snapshots);
    drafts.push(draft);
    for (const a of group) became.set(a, `handler_draft:${draft.id}`);
  }
  return { drafts, became };
}

/** One `normal` fixture: an expected screen the main flow used (section 6 §14.12, section 5
 * §13.4). Simplified to one per distinct kept-step location (see the file header). `files` are
 * that turn's own saved capture paths inside the run folder (section 3 §7.4), for sealing to
 * copy into the fixture folder (section 5 §13.1). */
export type NormalFixture = { id: string; location: string; turn: number; files: readonly string[] };

/** The `normal` fixtures every kept step's own screen needs (section 6 §14.12), deduplicated by
 * location. `observationFiles` is `collectObservationFiles`'s result: each turn's own saved
 * capture paths. */
export function buildNormalFixtures(
  kept: readonly { turn: number; location: string }[],
  observationFiles: ReadonlyMap<number, readonly string[]>,
): NormalFixture[] {
  const seen = new Set<string>();
  const out: NormalFixture[] = [];
  for (const { turn, location } of kept) {
    if (seen.has(location)) continue;
    seen.add(location);
    const name = screenNameOf(location);
    out.push({
      id: `normal_${name === "" ? slugify(location) || "root" : name}`,
      location,
      turn,
      files: observationFiles.get(turn) ?? [],
    });
  }
  return out;
}
