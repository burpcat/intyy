// Recorder step 3 (section 6 §14.2, §14.3, §14.5, §14.11): one step per kept action, its
// precondition and checkpoint, and a draft timeout. Ties targets.ts and conditions.ts together.
import type { Condition } from "../model/artifact/conditions.js";
import type { RiskKind, Step, StepAction } from "../model/artifact/steps.js";
import type { Target } from "../model/artifact/targets.js";
import { fromA11ySnapshot } from "../targets/a11y-snapshot.js";
import {
  allOf,
  ConditionRegistry,
  elementStateCheck,
  elementVisibleCheck,
  fieldValueCheck,
  findProofText,
  locationCheck,
  newLandmarks,
  textVisibleCheck,
  type NestedLeaf,
} from "./conditions.js";
import type { RecorderIssue } from "./issues.js";
import { toPathPattern } from "./paths.js";
import type { TaggedAction } from "./tags.js";
import { buildTargets, pickId, screenNameOf, slugify } from "./targets.js";

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

/** A step's own ID, before clash resolution: verb plus the target's stem (section 6 §14.3). */
function stepIdFor(a: TaggedAction, targetId: string | null): string {
  if (a.tool === "navigate") return `navigate_${slugify(a.afterLocation ?? a.beforeLocation)}`;
  if (a.tool === "press") return `press_${slugify(a.key ?? "key")}`;
  if (targetId === null) throw new Error(`${a.tool} step needs a target`);
  return `${a.tool}_${stemOf(targetId)}`;
}

/** The target for a step that must have one. Throwing here would mean the funneling below let a
 * targetless action through: a bug, not trouble. */
function must(targetId: string | null): string {
  if (targetId === null) throw new Error("expected a resolved target");
  return targetId;
}

/** The `StepAction` for one action (section 2 §15.2). Each field it reads was already checked
 * present by {@link hasRequiredValue}. */
function actionShapeFor(a: TaggedAction, targetId: string | null): StepAction {
  switch (a.tool) {
    case "click":
      return { type: "click", target: must(targetId) };
    case "type": {
      const value = a.value ?? "";
      return a.format === null
        ? { type: "type", target: must(targetId), value }
        : { type: "type", target: must(targetId), value, format: a.format };
    }
    case "select":
      return { type: "select", target: must(targetId), value: a.option ?? "" };
    case "set_checked":
      return { type: "set_checked", target: must(targetId), checked: a.checked === true };
    case "press":
      return { type: "press", key: a.key ?? "" };
    case "navigate":
      return { type: "navigate", location: toPathPattern(a.afterLocation ?? a.beforeLocation) };
    default:
      throw new Error(`${a.tool} is not a supported step action`);
  }
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

/** Fill tools: they change one field's value, and never send a request (docs/decisions.md, M04:
 * "click, press, and navigate count as steps that send a request; other action kinds are fills"). */
const FILL_TOOLS = new Set(["type", "select", "set_checked"]);

/** True when the log recorded the value a step's action needs. `click`, `type`, and `navigate`
 * always have what they need; `select`, `set_checked`, and `press` need a field the log only
 * carries from this milestone on (docs/decisions.md, M04: the gap fix in `loop.ts`/`tools.ts`).
 * A `false` here becomes a blocking issue, never a guess (CLAUDE.md: never invent a gap's data). */
function hasRequiredValue(a: TaggedAction): boolean {
  switch (a.tool) {
    case "select":
      return typeof a.option === "string";
    case "set_checked":
      return typeof a.checked === "boolean";
    case "press":
      return typeof a.key === "string";
    default:
      return true;
  }
}

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

/**
 * The saved snapshots the last two §14.5 rules need (docs/decisions.md, M04): each turn's
 * masked accessibility snapshot text, for the landmark check; and the run's `done` (positive) or
 * `report_outcome` (negative) proof IDs and that turn's masked element-list text, for the last
 * step's or outcome's checkpoint (section 6 §14.5, §14.8). The CLI (task 10) reads these files;
 * the recorder only ever sees their already-masked text.
 */
export type Snapshots = {
  /** Turn number to that observation's saved `a11y/*.yaml` text. */
  a11yByTurn: ReadonlyMap<number, string>;
  proof: { turn: number; ids: readonly string[] } | null;
  /** The proof turn's masked element-list text (`buildScreen`'s `view.list`), or `null`. */
  proofElementListText: string | null;
};

/** No snapshots supplied: every step falls back to its plain screen condition, with no landmark. */
export const EMPTY_SNAPSHOTS: Snapshots = {
  a11yByTurn: new Map(),
  proof: null,
  proofElementListText: null,
};

/** One new landmark between `a`'s before and after screens, or `null` when either snapshot is
 * missing or none was added (section 6 §14.5). */
function landmarkFor(a: TaggedAction, afterLocation: string, snapshots: Snapshots): string | null {
  const before = snapshots.a11yByTurn.get(a.turn);
  const after = snapshots.a11yByTurn.get(a.turn + 1);
  if (before === undefined || after === undefined) return null;
  const bv = fromA11ySnapshot(before, a.beforeLocation);
  const av = fromA11ySnapshot(after, afterLocation);
  return newLandmarks(bv, av)[0] ?? null;
}

/** The last step's checkpoint, from `done.proof` (section 6 §14.5). `null` when there is no
 * `done` call to build from, so the caller falls back to the plain after-location. Adds a
 * blocking issue only when a `done` call exists but its proof text cannot be found. */
function lastCheckpointFromProof(
  a: TaggedAction,
  snapshots: Snapshots,
  issues: RecorderIssue[],
): NestedLeaf | null {
  if (snapshots.proof === null) return null;
  const listText = snapshots.proofElementListText;
  const texts = listText === null ? [] : snapshots.proof.ids.map((id) => findProofText(listText, id));
  if (listText === null || texts.some((t) => t === null)) {
    issues.push({
      level: "blocking",
      code: "no_proof_text",
      subject: `${a.runId}#done`,
      message: "The done call's proof text could not be found; the last checkpoint falls back to the after-location.",
    });
    return null;
  }
  return allOf(texts.map((t): NestedLeaf => textVisibleCheck(t ?? "")));
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
  /** Each kept action's own step ID, as `step:<id>` (section 2 §17.3, `became`). An action with
   * no entry here was dropped: merged into a later `type`, or an issue kept it from a step. */
  became: ReadonlyMap<TaggedAction, string>;
  /** Step ID to the rules' own risk class (section 4 §7), always shown (section 6 §14.9), for
   * `record.ts`'s second-look check: a decision may draft a lower risk, but never hide what the
   * rules said. */
  gateRiskByStepId: ReadonlyMap<string, RiskKind>;
  /** Step ID to the staff who gave the approval hint the draft used, when one exists. */
  riskHintByByStepId: ReadonlyMap<string, string | null>;
};

/**
 * Builds one step per kept action, in order, with its target, precondition, checkpoint, and a
 * draft timeout (section 6 §14.2 steps 3 to 5, §14.11). `kept` is the run's `flow_step` actions,
 * already reduced by tag decisions and corrections (see `tags.ts`).
 */
export function buildSteps(
  kept: readonly TaggedAction[],
  snapshots: Snapshots = EMPTY_SNAPSHOTS,
): StepsResult {
  const issues: RecorderIssue[] = [];
  const eligible: TaggedAction[] = [];
  // Why: section 6 §14.3, "scroll and wait: never steps." Scroll never even runs a fingerprint
  // capture, so it carries nothing a step could use.
  for (const a of kept) {
    if (a.tool === "scroll") continue;
    if (!hasRequiredValue(a)) {
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
  const became = new Map<TaggedAction, string>();
  const gateRiskByStepId = new Map<string, RiskKind>();
  const riskHintByByStepId = new Map<string, string | null>();
  let fillsSincePageChange: string[] = [];
  let lastLocation: string | null = null;

  finalActions.forEach((a, i) => {
    const targetId = targetIdOf.get(a) ?? null;
    if (targetId === null && a.tool !== "navigate" && a.tool !== "press") {
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

    const screenName = screenNameOf(a.beforeLocation);
    const stepId = pickId(stepIdFor(a, targetId), usedStepIds, screenName);
    usedStepIds.add(stepId);

    const isFill = FILL_TOOLS.has(a.tool);
    // Why no separate "first step" case: the owner decision (docs/decisions.md, M04) only swaps
    // `entry` for the observed location; `beforeLocation` already is that location for every
    // step, including the first. With no prior fill on this page, `fillsSincePageChange` is
    // empty, so `allOf` below degrades to the location check alone.
    const precondition: NestedLeaf = isFill
      ? allOf([locationCheck(toPathPattern(a.beforeLocation)), elementVisibleCheck(must(targetId))])
      : allOf([
          locationCheck(toPathPattern(a.beforeLocation)),
          ...fillsSincePageChange.map((ref): NestedLeaf => ({ ref })),
        ]);
    const preconditionId = registry.intern(
      precondition,
      `${stepId}_precondition`,
      `Before ${stepId.replace(/_/g, " ")}.`,
    );

    const afterLocation = a.afterLocation ?? a.beforeLocation;
    let checkpoint: NestedLeaf;
    if (a.tool === "type") {
      checkpoint = fieldValueCheck(must(targetId), a.value ?? "", a.format ?? undefined);
    } else if (a.tool === "select") {
      checkpoint = fieldValueCheck(must(targetId), a.option ?? "");
    } else if (a.tool === "set_checked") {
      checkpoint = elementStateCheck(must(targetId), a.checked === true ? "checked" : "unchecked");
    } else {
      const isLast = i === finalActions.length - 1;
      const fromProof = isLast ? lastCheckpointFromProof(a, snapshots, issues) : null;
      if (fromProof !== null) {
        checkpoint = fromProof;
      } else {
        const next = finalActions[i + 1];
        const nextTargetId = next === undefined ? null : targetIdOf.get(next) ?? null;
        const landmark = landmarkFor(a, afterLocation, snapshots);
        const parts: NestedLeaf[] = [locationCheck(toPathPattern(afterLocation))];
        if (nextTargetId !== null) parts.push(elementVisibleCheck(nextTargetId));
        if (landmark !== null) parts.push(textVisibleCheck(landmark));
        checkpoint = allOf(parts);
      }
    }
    const checkpointId = registry.intern(
      checkpoint,
      `${stepId}_checkpoint`,
      `After ${stepId.replace(/_/g, " ")}.`,
    );
    if (isFill) fillsSincePageChange.push(checkpointId);

    const timeoutMs = draftTimeoutMs(isFill ? "fill" : "request", observedMs(a));
    // Section 6 §14.9: the draft is the operator's approval hint when present, else the rules'
    // class from the gate line that let this action run. With neither, when unsure assume the
    // worst (section 4 §2.3) — never a silent lower default — and flag it for review.
    let risk: RiskKind;
    if (a.riskHint !== null) risk = a.riskHint;
    else if (a.gateRisk !== null) risk = a.gateRisk;
    else {
      risk = "irreversible";
      issues.push({
        level: "blocking",
        code: "no_risk_class",
        subject: stepId,
        message: `${stepId} has no approval hint and no gate line to draft its risk from; drafted irreversible.`,
      });
    }
    if (a.gateRisk !== null) gateRiskByStepId.set(stepId, a.gateRisk);
    if (a.riskHint !== null) riskHintByByStepId.set(stepId, a.riskHintBy);

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
    became.set(a, `step:${stepId}`);
  });

  return {
    steps,
    conditions: registry.list(),
    targets,
    crops,
    issues,
    became,
    gateRiskByStepId,
    riskHintByByStepId,
  };
}
