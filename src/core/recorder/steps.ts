// Recorder step 3 (section 6 §14.2, §14.3, §14.5, §14.11): one step per kept action, its
// precondition and checkpoint, and a draft timeout. Ties targets.ts and conditions.ts together.
//
// Known limit: `select`, `set_checked`, and `press` cannot be rebuilt from the log alone. The
// `action` log line records the typed value for `type` (`data.value`), but not the chosen
// option, the checked flag, or the pressed key for the other three (loop.ts's `afterGate` logs
// `value: c.typed ?? null`, and only `type` sets `c.typed`). Rather than invent that value
// (CLAUDE.md: never invent product behavior to fill a gap), such an action becomes a blocking
// issue instead of a step. Recommended fix: log a `value` for `select` (the option) and
// `set_checked` (the checked flag) too, and a `key` for `press`, alongside `type`'s.
import type { Condition } from "../model/artifact/conditions.js";
import type { RiskKind, Step, StepAction } from "../model/artifact/steps.js";
import type { Target } from "../model/artifact/targets.js";
import {
  allOf,
  ConditionRegistry,
  elementVisibleCheck,
  fieldValueCheck,
  locationCheck,
  type NestedLeaf,
} from "./conditions.js";
import type { RecorderIssue } from "./issues.js";
import { toPathPattern } from "./paths.js";
import type { TaggedAction } from "./tags.js";
import { buildTargets, pickId, slugify } from "./targets.js";

/** Suffixes {@link buildTargets} may add to a target's own words (section 6 §14.4). */
const ROLE_SUFFIXES = ["button", "box", "list", "check", "row", "link"];

/** A target ID's own words, with its role suffix stripped, for a step ID's stem. Examples:
 * `search_button` → `search`; `member_id_box` → `member_id` (section 6 §14.3). */
function stemOf(targetId: string): string {
  for (const suffix of ROLE_SUFFIXES) {
    if (targetId.endsWith(`_${suffix}`)) return targetId.slice(0, -(suffix.length + 1));
  }
  return targetId;
}

/** A step's own ID, before clash numbering: verb plus the target's stem (section 6 §14.3). */
function stepIdFor(a: TaggedAction, targetId: string | null): string {
  if (a.tool === "navigate") return `navigate_${slugify(a.afterLocation ?? a.beforeLocation)}`;
  if (targetId === null) throw new Error(`${a.tool} step needs a target`);
  return `${a.tool}_${stemOf(targetId)}`;
}

/** The `StepAction` for one supported tool (section 2 §15.2). */
function actionShapeFor(a: TaggedAction, targetId: string | null): StepAction {
  switch (a.tool) {
    case "click":
      if (targetId === null) throw new Error("click step needs a target");
      return { type: "click", target: targetId };
    case "type": {
      if (targetId === null) throw new Error("type step needs a target");
      const value = a.value ?? "";
      return a.format === null
        ? { type: "type", target: targetId, value }
        : { type: "type", target: targetId, value, format: a.format };
    }
    case "navigate":
      return { type: "navigate", location: toPathPattern(a.afterLocation ?? a.beforeLocation) };
    default:
      throw new Error(`${a.tool} is not a supported step action`);
  }
}

/** The target for a step that must have one (every supported tool but `navigate`). Throwing
 * here would mean the funneling below let a targetless action through: a bug, not trouble. */
function must(targetId: string | null): string {
  if (targetId === null) throw new Error("expected a resolved target");
  return targetId;
}

/** Milliseconds between an action and the next observation, or `null` when there is none. */
function observedMs(a: TaggedAction): number | null {
  return a.afterAt === null ? null : Date.parse(a.afterAt) - Date.parse(a.at);
}

/** A draft timeout (section 6 §14.11): three times the observed time, rounded up to a second,
 * within the step kind's floor and cap. The commit step's 15 s floor is a later task (section
 * 6 §14.9 picks the commit point); every step drafts with the plain floors here. */
export function draftTimeoutMs(kind: "fill" | "request", observed: number | null): number {
  const floor = kind === "fill" ? 5000 : 10000;
  const cap = 30_000;
  const drafted = observed === null ? floor : Math.ceil((observed * 3) / 1000) * 1000;
  return Math.min(cap, Math.max(floor, drafted));
}

/** The tool kinds `buildSteps` can rebuild a full step for (see the file header). */
const SUPPORTED = new Set(["click", "type", "navigate"]);

/** Drops repeated `type` actions on the same target, keeping only the last one (section 6
 * §14.3). Every other kept action stays, in order. */
function mergeRepeatedType(
  actions: readonly TaggedAction[],
  targetIdOf: ReadonlyMap<TaggedAction, string | null>,
): TaggedAction[] {
  const lastTypeIndex = new Map<string, number>();
  actions.forEach((a, i) => {
    if (a.tool !== "type") return;
    const id = targetIdOf.get(a) ?? null;
    if (id !== null) lastTypeIndex.set(id, i);
  });
  return actions.filter((a, i) => {
    if (a.tool !== "type") return true;
    const id = targetIdOf.get(a) ?? null;
    return id === null || lastTypeIndex.get(id) === i;
  });
}

/** What {@link buildSteps} returns. */
export type StepsResult = {
  steps: readonly Step[];
  conditions: readonly Condition[];
  targets: readonly Target[];
  /** Target ID to its crop's source path inside the run folder (section 6 §14.1, "Crops for
   * targets"). */
  crops: ReadonlyMap<string, string>;
  issues: readonly RecorderIssue[];
};

/**
 * Builds one step per kept action, in order, with its target, precondition, checkpoint, and a
 * draft timeout (section 6 §14.2 steps 3 to 5, §14.11). `kept` is the run's `flow_step` actions,
 * already reduced by tag decisions and corrections (see `tags.ts`).
 */
export function buildSteps(kept: readonly TaggedAction[]): StepsResult {
  const issues: RecorderIssue[] = [];
  const eligible: TaggedAction[] = [];
  // Why: section 6 §14.3, "scroll and wait: never steps." Scroll never even runs a fingerprint
  // capture, so it carries nothing a step could use.
  for (const a of kept) {
    if (a.tool === "scroll") continue;
    if (!SUPPORTED.has(a.tool)) {
      issues.push({
        level: "blocking",
        code: "unsupported_step_action",
        subject: `${a.runId}#${String(a.seq)}`,
        message: `${a.tool} at t${String(a.turn)} cannot become a step: the log does not record its value.`,
      });
      continue;
    }
    eligible.push(a);
  }

  const { targets, targetIdOf, crops } = buildTargets(eligible);
  const finalActions = mergeRepeatedType(eligible, targetIdOf);

  const registry = new ConditionRegistry();
  const usedStepIds = new Set<string>();
  const steps: Step[] = [];
  let fillsSincePageChange: string[] = [];
  let lastLocation: string | null = null;

  finalActions.forEach((a, i) => {
    const targetId = targetIdOf.get(a) ?? null;
    if (targetId === null && a.tool !== "navigate") {
      issues.push({
        level: "blocking",
        code: "no_fingerprint",
        subject: `${a.runId}#${String(a.seq)}`,
        message: `${a.tool} at t${String(a.turn)} has no captured fingerprint.`,
      });
      return;
    }
    if (a.beforeLocation !== lastLocation) {
      fillsSincePageChange = [];
      lastLocation = a.beforeLocation;
    }

    const stepId = pickId(stepIdFor(a, targetId), usedStepIds);
    usedStepIds.add(stepId);

    // Why no separate "first step" case: the owner decision (docs/decisions.md, M04) only swaps
    // `entry` for the observed location; `beforeLocation` already is that location for every
    // step, including the first. With no prior fill on this page, `fillsSincePageChange` is
    // empty, so `allOf` below degrades to the location check alone, matching the design's
    // "screen condition of entry" for a first step that sends a request.
    const precondition: NestedLeaf =
      a.tool === "type"
        ? allOf([
            locationCheck(toPathPattern(a.beforeLocation)),
            elementVisibleCheck(must(targetId)),
          ])
        : allOf([
            locationCheck(toPathPattern(a.beforeLocation)),
            ...fillsSincePageChange.map((ref): NestedLeaf => ({ ref })),
          ]);
    const preconditionId = registry.intern(
      precondition,
      `${stepId}_precondition`,
      `Before ${stepId.replace(/_/g, " ")}.`,
    );

    const isFill = a.tool === "type";
    const next = finalActions[i + 1];
    const nextTargetId = next === undefined ? null : targetIdOf.get(next) ?? null;
    const afterLocation = a.afterLocation ?? a.beforeLocation;
    const checkpoint: NestedLeaf = isFill
      ? fieldValueCheck(must(targetId), a.value ?? "", a.format ?? undefined)
      : nextTargetId === null
        ? locationCheck(toPathPattern(afterLocation))
        : allOf([locationCheck(toPathPattern(afterLocation)), elementVisibleCheck(nextTargetId)]);
    const checkpointId = registry.intern(
      checkpoint,
      `${stepId}_checkpoint`,
      `After ${stepId.replace(/_/g, " ")}.`,
    );
    if (isFill) fillsSincePageChange.push(checkpointId);

    const timeoutMs = draftTimeoutMs(isFill ? "fill" : "request", observedMs(a));
    // Why unsure means irreversible: section 4 §2.3. §14.9's policy-class draft is a later task.
    const risk: RiskKind = a.riskHint ?? "irreversible";

    steps.push({
      id: stepId,
      intent: a.reason,
      action: actionShapeFor(a, targetId),
      precondition: preconditionId,
      checkpoint: checkpointId,
      outcomes: [],
      risk,
      timeout_ms: timeoutMs,
    });
  });

  return { steps, conditions: registry.list(), targets, crops, issues };
}
