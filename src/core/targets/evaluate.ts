// The condition evaluator: answers what one screen check says, in the shared language of design
// section 2 §14. Every check answers `true`, `false`, or `unknown`; only `true` passes (§14.2).
// Follows section 7 §6.7 (checks that use targets, unknown combining) and §14.5 (combining).
import type { z } from "zod";
import { matchPath, normalizePath, parsePattern } from "../safety/policy/paths.js";
import type { Condition, NestedCheck } from "../model/artifact/conditions.js";
import type { Target } from "../model/artifact/targets.js";
import { descendantsOf, elementOf, type ScreenView } from "./screen.js";
import { matchText, resolveRefs } from "./text.js";
import { vote } from "./vote.js";

/** Either a top-level, named condition, or a nested check inside `all_of`, `any_of`, or `not`. */
export type AnyCheck = Condition | z.infer<typeof NestedCheck>;

/** A leaf's `unknown` reason, for a trace (section 7 §6.7: "The trace shows unknown leaves
 * with the reason"). */
export type EvalReason = "target ambiguous" | "value not observable";

/** Every reason an `evaluate` call hit, in leaf order. Callers that do not need a trace may omit it. */
export type EvalTrace = EvalReason[];

/** What `evaluate` needs besides the screen. `refs` resolves `{input.*}`; it is never logged
 * (section 7 §6.3). `conditions` resolves a `ref` combiner; absent when none is used. */
export type EvalCtx = {
  targets: ReadonlyMap<string, Target>;
  conditions?: ReadonlyMap<string, Condition>;
  refs?: ReadonlyMap<string, string>;
};

/** A condition's answer (section 2 §14.2). */
export type ConditionAnswer = "true" | "false" | "unknown";

function pushTrace(trace: EvalTrace | undefined, reason: EvalReason): void {
  trace?.push(reason);
}

/** Votes for a check's target. Throws when `targetId` names no known target: the loader checks
 * that every `target` field names one, so an unresolved ID here is a data bug, not trouble. */
function voteFor(targetId: string, screen: ScreenView, ctx: EvalCtx) {
  const target = ctx.targets.get(targetId);
  if (target === undefined) throw new Error(`condition target ${targetId} is not a known target`);
  return vote(target, screen, ctx.targets, ctx.refs);
}

/** `element_visible` (section 2 §14.3, section 7 §6.7). */
function evalElementVisible(
  check: { target: string },
  screen: ScreenView,
  ctx: EvalCtx,
  trace: EvalTrace | undefined,
): ConditionAnswer {
  const v = voteFor(check.target, screen, ctx);
  if (v.kind === "ambiguous") {
    pushTrace(trace, "target ambiguous");
    return "unknown";
  }
  if (v.kind === "not_found") return "false";
  return elementOf(screen, v.elementId)?.visible === true ? "true" : "false";
}

/** `element_state` (section 2 §14.3, §14.4, section 7 §6.7). `enabled`/`disabled` always read
 * the element's own `enabled` flag, so they are always observable. `checked`/`unchecked` and
 * `selected` give `unknown` when the screen view has no such value for the element (owner
 * decision, matching `field_value`): not observable is never a silent `false`. */
function evalElementState(
  check: { target: string; state: "enabled" | "disabled" | "checked" | "unchecked" | "selected" },
  screen: ScreenView,
  ctx: EvalCtx,
  trace: EvalTrace | undefined,
): ConditionAnswer {
  const v = voteFor(check.target, screen, ctx);
  if (v.kind === "ambiguous") {
    pushTrace(trace, "target ambiguous");
    return "unknown";
  }
  if (v.kind === "not_found") return "false";
  const el = elementOf(screen, v.elementId);
  if (el === undefined) return "false";
  switch (check.state) {
    case "enabled":
      return el.enabled ? "true" : "false";
    case "disabled":
      return el.enabled ? "false" : "true";
    case "checked":
    case "unchecked":
      if (el.checked === undefined) {
        pushTrace(trace, "value not observable");
        return "unknown";
      }
      return el.checked === (check.state === "checked") ? "true" : "false";
    case "selected":
      if (el.selected === undefined) {
        pushTrace(trace, "value not observable");
        return "unknown";
      }
      return el.selected ? "true" : "false";
  }
}

/** `field_value` (section 2 §14.3, section 7 §6.7). No observed value gives `unknown`, an
 * owner decision (docs/decisions.md): a secret-filled or unread field cannot be judged either way. */
function evalFieldValue(
  check: {
    target: string;
    value: string;
    match: "exact" | "contains" | "wildcard";
    case_sensitive?: boolean | undefined;
  },
  screen: ScreenView,
  ctx: EvalCtx,
  trace: EvalTrace | undefined,
): ConditionAnswer {
  const v = voteFor(check.target, screen, ctx);
  if (v.kind === "ambiguous") {
    pushTrace(trace, "target ambiguous");
    return "unknown";
  }
  if (v.kind === "not_found") return "false";
  const el = elementOf(screen, v.elementId);
  if (el?.fieldValue === undefined) {
    pushTrace(trace, "value not observable");
    return "unknown";
  }
  const expected = resolveRefs(check.value, ctx.refs);
  return matchText(el.fieldValue, expected, check.match, check.case_sensitive) ? "true" : "false";
}

/** `text_visible` (section 2 §14.3, section 2 §7.3/§7.4 for matching). Searches every visible
 * element's name, text, and label; `within` narrows the search to one target's descendants. */
function evalTextVisible(
  check: {
    text: string;
    match: "exact" | "contains" | "wildcard";
    within?: string | undefined;
    case_sensitive?: boolean | undefined;
  },
  screen: ScreenView,
  ctx: EvalCtx,
  trace: EvalTrace | undefined,
): ConditionAnswer {
  let pool = screen.elements;
  if (check.within !== undefined) {
    const v = voteFor(check.within, screen, ctx);
    if (v.kind === "ambiguous") {
      pushTrace(trace, "target ambiguous");
      return "unknown";
    }
    if (v.kind === "not_found") return "false";
    const within = descendantsOf(screen, v.elementId);
    pool = screen.elements.filter((e) => within.has(e.id));
  }
  const expected = resolveRefs(check.text, ctx.refs);
  const found = pool.some((e) => {
    if (!e.visible) return false;
    const texts = [e.name, e.text, e.label].filter((t): t is string => t !== undefined);
    return texts.some((t) => matchText(t, expected, check.match, check.case_sensitive));
  });
  return found ? "true" : "false";
}

/** `count.item` to the role it counts (section 2 §14.4). */
const ITEM_ROLE: Record<"row" | "list_item" | "option", string> = {
  row: "row",
  list_item: "listitem",
  option: "option",
};

/** `count` (section 2 §14.3, §14.4). */
function evalCount(
  check: {
    within: string;
    item: "row" | "list_item" | "option";
    op: "equals" | "at_least" | "at_most";
    value: number;
  },
  screen: ScreenView,
  ctx: EvalCtx,
  trace: EvalTrace | undefined,
): ConditionAnswer {
  const v = voteFor(check.within, screen, ctx);
  if (v.kind === "ambiguous") {
    pushTrace(trace, "target ambiguous");
    return "unknown";
  }
  if (v.kind === "not_found") return "false";
  const within = descendantsOf(screen, v.elementId);
  const role = ITEM_ROLE[check.item];
  const n = screen.elements.filter(
    (e) => e.id !== v.elementId && within.has(e.id) && e.role === role && e.visible,
  ).length;
  const ok =
    check.op === "equals" ? n === check.value : check.op === "at_least" ? n >= check.value : n <= check.value;
  return ok ? "true" : "false";
}

/** `location` (section 2 §14.3, §7.3: a path pattern, `*` never crosses `/`). The pattern is
 * already schema-checked (`PathPattern`), so a parse failure here is a data bug, not trouble. */
function evalLocation(check: { pattern: string }, screen: ScreenView): ConditionAnswer {
  const p = parsePattern(check.pattern);
  if (!p.ok) throw new Error(`location pattern ${check.pattern} is invalid: ${p.detail ?? ""}`);
  const n = normalizePath(screen.location, false);
  if (!n.ok) return "false";
  return matchPath(p.value, n.value, false) ? "true" : "false";
}

/** `all_of` (section 2 §14.5, section 7 §6.7: false wins over unknown; else unknown; else true). */
function combineAll(results: readonly ConditionAnswer[]): ConditionAnswer {
  if (results.some((r) => r === "false")) return "false";
  if (results.some((r) => r === "unknown")) return "unknown";
  return "true";
}

/** `any_of` (section 2 §14.5, section 7 §6.7: true wins over unknown; else unknown; else false). */
function combineAny(results: readonly ConditionAnswer[]): ConditionAnswer {
  if (results.some((r) => r === "true")) return "true";
  if (results.some((r) => r === "unknown")) return "unknown";
  return "false";
}

/** `not` (section 2 §14.5, §6.7: swaps true and false; `unknown` never passes through as its
 * opposite, it stays `unknown`). */
function negate(result: ConditionAnswer): ConditionAnswer {
  if (result === "unknown") return "unknown";
  return result === "true" ? "false" : "true";
}

/**
 * Answers one condition or nested check against `screen` (section 2 §14, section 7 §6.7).
 * Only `true` passes; callers decide what to do with `false` or `unknown`. `trace`, if given,
 * collects each unknown leaf's reason, in leaf order.
 */
export function evaluate(
  check: AnyCheck,
  screen: ScreenView,
  ctx: EvalCtx,
  trace?: EvalTrace,
): ConditionAnswer {
  switch (check.check) {
    case "element_visible":
      return evalElementVisible(check, screen, ctx, trace);
    case "element_state":
      return evalElementState(check, screen, ctx, trace);
    case "text_visible":
      return evalTextVisible(check, screen, ctx, trace);
    case "field_value":
      return evalFieldValue(check, screen, ctx, trace);
    case "count":
      return evalCount(check, screen, ctx, trace);
    case "location":
      return evalLocation(check, screen);
    case "all_of":
      return combineAll(check.checks.map((c) => evaluate(c, screen, ctx, trace)));
    case "any_of":
      return combineAny(check.checks.map((c) => evaluate(c, screen, ctx, trace)));
    case "not":
      return negate(evaluate(check.of, screen, ctx, trace));
    case "ref":
    case undefined: {
      const target = ctx.conditions?.get(check.ref);
      if (target === undefined) throw new Error(`ref ${check.ref} is not a known condition`);
      return evaluate(target, screen, ctx, trace);
    }
  }
}
