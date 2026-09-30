// The pack loader checks (design section 5 §5.6): everything a pack file must satisfy beyond
// its own shape. "Any failure stops the load." Follows the artifact loader's own pattern
// (`src/core/model/artifact-checks.ts`): small checks, one shared `report`, every problem
// listed, not just the first (section 4's merge-report style, section 5 §5.4).
import type { z } from "zod";
import { NestedCheck } from "../model/artifact/conditions.js";
import { scanRefs, matchesAnyPattern } from "../model/artifact-checks-shared.js";
import type { Handler, HandlerAction, Pack, PackCondition, PackTarget } from "../model/pack.js";

/** A nested check's shape (section 5 §5.3: packs reuse the artifact's condition language). */
type NestedCheckShape = z.infer<typeof NestedCheck>;

/** One problem the pack loader found (section 5 §5.6). Every one stops the load. */
export type PackProblem = { readonly code: string; readonly path: string; readonly message: string };

type Reporter = (code: string, path: string, message: string) => void;

/**
 * Outside facts a pure pack check cannot know on its own: what a parent scope's active
 * revision already declares (section 5 §5.6 "References"), and the policy (§5.6 "Checks that
 * need the policy", run again at freeze, section 5 §7.4 step 5 to 7). Every field optional: a
 * missing one skips that one check, matching the artifact checker's own `ArtifactCheckContext`.
 */
export type PackCheckContext = {
  ancestorTargetIds?: ReadonlySet<string>;
  ancestorConditionIds?: ReadonlySet<string>;
  ancestorHandlerIds?: ReadonlySet<string>;
  secretDeclared?(name: string): boolean;
  pathAllowed?(path: string): boolean;
};

/** Mask text shape, like `[name#1]` or `[secret]` (section 4 §9.9, §9.5). A detector holding one
 * could never fire on a live screen, only on the masked text intyy itself writes. */
const MASK_TEXT = /\[[a-z_]+#\d+\]|\[(?:secret|human_text|pii|financial)\]/;

const D_REF = "dangling_ref";
const BAD_NS = "bad_namespace";

/** Every `{ns.*}` reference in `text` is rejected outright: no namespace belongs in a pack
 * target or condition's own text (section 5 §5.6 "no `{input.*}` anywhere"; §5.6 only carves
 * out `{system.last_good_path}` as a whole `navigate` location, and `{secret.*}` as a whole
 * `type` value, neither of which is free text). */
function rejectAnyRef(text: string, path: string, report: Reporter): void {
  for (const r of scanRefs(text)) report(BAD_NS, path, `{${r.ns}.${r.name}} is not allowed here`);
}

/** Every `overrides: true` flag actually reuses a parent ID, and every reused ID sets it
 * (section 5 §5.6 "Overrides"). Skipped when `ancestorIds` is not supplied (no policy to check
 * against yet, such as a first pass before ancestor packs are loaded). */
function checkOverride(
  id: string,
  overrides: boolean | undefined,
  ancestorIds: ReadonlySet<string> | undefined,
  path: string,
  report: Reporter,
): void {
  if (ancestorIds === undefined) return;
  const inherited = ancestorIds.has(id);
  if (overrides === true && !inherited) {
    report("overrides_new_id", path, `${id} is new; it must not set "overrides": true`);
  }
  if (overrides !== true && inherited) {
    report("overrides_missing", path, `${id} reuses a parent scope's ID; set "overrides": true`);
  }
}

/** Walks one condition's tree: target and `ref` existence, forbidden references, mask text,
 * and the `field_value` ban (section 5 §5.6 "References" and "Detectors"). */
function walkConditionTree(
  node: PackCondition | NestedCheckShape,
  path: string,
  targetIds: ReadonlySet<string>,
  conditionIds: ReadonlySet<string>,
  report: Reporter,
): void {
  if ("ref" in node) {
    if (!conditionIds.has(node.ref)) report(D_REF, path, `${node.ref} does not exist`);
    return;
  }
  if ("checks" in node) {
    node.checks.forEach((c, i) => {
      walkConditionTree(c, `${path}.checks[${String(i)}]`, targetIds, conditionIds, report);
    });
    return;
  }
  if ("of" in node) {
    walkConditionTree(node.of, `${path}.of`, targetIds, conditionIds, report);
    return;
  }
  if (node.check === "field_value") {
    report("no_field_value_in_pack", path, "a pack detector may not use field_value; fixtures hold no field values");
    return;
  }
  if ("target" in node && !targetIds.has(node.target)) {
    report(D_REF, `${path}.target`, `${node.target} does not exist`);
  }
  if ("within" in node && node.within !== undefined && !targetIds.has(node.within)) {
    report(D_REF, `${path}.within`, `${node.within} does not exist`);
  }
  if (node.check === "text_visible") {
    rejectAnyRef(node.text, `${path}.text`, report);
    if (MASK_TEXT.test(node.text)) report("mask_text_in_detector", `${path}.text`, "holds mask text, like [name#1]");
  }
}

/** Every target's clue text: no references, no mask text (section 5 §5.6). */
function checkTargets(targets: readonly PackTarget[], ancestorIds: ReadonlySet<string> | undefined, report: Reporter): void {
  for (const t of targets) {
    checkOverride(t.id, t.overrides, ancestorIds, `targets.${t.id}`, report);
    for (const [field, value] of [["text", t.clues.text], ["label", t.clues.label]] as const) {
      if (value === undefined) continue;
      rejectAnyRef(value, `targets.${t.id}.clues.${field}`, report);
      if (MASK_TEXT.test(value)) {
        report("mask_text_in_detector", `targets.${t.id}.clues.${field}`, "holds mask text, like [name#1]");
      }
    }
  }
}

/** One response action's target/location reference and namespace rules (section 5 §6.4, §5.6). */
function checkAction(
  action: HandlerAction,
  path: string,
  targetIds: ReadonlySet<string>,
  ctx: PackCheckContext,
  report: Reporter,
): void {
  switch (action.type) {
    case "navigate":
      if (action.location !== "{system.last_good_path}") {
        if (ctx.pathAllowed !== undefined && !ctx.pathAllowed(action.location)) {
          report("policy_path_denied", `${path}.location`, `${action.location} is outside the app's allowed paths`);
        }
      }
      break;
    case "press":
    case "sign_in":
      break;
    case "click":
    case "set_checked":
      if (!targetIds.has(action.target)) report(D_REF, `${path}.target`, `${action.target} does not exist`);
      break;
    case "type":
    case "select": {
      if (!targetIds.has(action.target)) report(D_REF, `${path}.target`, `${action.target} does not exist`);
      const refs = scanRefs(action.value);
      const secretRef = refs.find((r) => r.ns === "secret");
      const others = refs.filter((r) => r.ns !== "secret");
      for (const r of others) report(BAD_NS, `${path}.value`, `{${r.ns}.${r.name}} is not allowed here`);
      if (secretRef !== undefined) {
        if (action.type !== "type" || action.value.trim() !== `{secret.${secretRef.name}}`) {
          report("secret_not_whole_value", `${path}.value`, "a secret reference must fill the whole value of a type action");
        } else if (ctx.secretDeclared !== undefined && !ctx.secretDeclared(secretRef.name)) {
          report("policy_secret_undeclared", `${path}.value`, `secret ${secretRef.name} is not in the app's policy`);
        }
      }
      break;
    }
  }
}

/** One handler: its scope-only fields, references, risk decisions, and overrides
 * (section 5 §5.6 "Format", "References", "Actions", "Overrides"). */
function checkHandler(
  h: Handler,
  scope: Pack["scope"],
  targetIds: ReadonlySet<string>,
  conditionIds: ReadonlySet<string>,
  pack: Pack,
  ctx: PackCheckContext,
  report: Reporter,
): void {
  const path = `handlers.${h.id}`;
  checkOverride(h.id, h.overrides, ctx.ancestorHandlerIds, path, report);
  if (h.app_versions !== undefined && scope.level !== "tenant") {
    report("app_versions_not_tenant", path, "app_versions is allowed only in a tenant-scope pack");
  }
  if (!conditionIds.has(h.detector)) report(D_REF, `${path}.detector`, `${h.detector} does not exist`);
  if (h.class !== "recoverable") return;
  if (h.done_when !== undefined && !conditionIds.has(h.done_when)) {
    report(D_REF, `${path}.done_when`, `${h.done_when} does not exist`);
  }
  h.response.forEach((action, i) => {
    checkAction(action, `${path}.response[${String(i)}]`, targetIds, ctx, report);
    const subject = `${h.id}.response[${String(i)}]`;
    const decided = pack.provenance.decisions.some((d) => d.what === "risk" && d.subject === subject);
    if (!decided) report("missing_risk_decision", `${path}.response[${String(i)}]`, `${subject} has no risk decision in provenance`);
  });
}

/** Runs every section 5 §5.6 check on one pack file. An empty result means it loads. */
export function checkPack(pack: Pack, ctx: PackCheckContext = {}): PackProblem[] {
  const problems: PackProblem[] = [];
  const report: Reporter = (code, path, message) => problems.push({ code, path, message });

  for (const [ids, path] of [
    [pack.handlers.map((h) => h.id), "handlers"],
    [pack.targets.map((t) => t.id), "targets"],
    [pack.conditions.map((c) => c.id), "conditions"],
  ] as const) {
    const seen = new Set<string>();
    for (const id of ids) {
      if (seen.has(id)) report("duplicate_id", path, `${id} is used twice`);
      seen.add(id);
    }
  }

  if ((pack.disable?.length ?? 0) > 0 && pack.scope.level !== "app_version" && pack.scope.level !== "tenant") {
    report("disable_not_versioned", "disable", "disable is allowed only in an app_version or tenant-scope pack");
  }

  const ownTargetIds = new Set(pack.targets.map((t) => t.id));
  const ownConditionIds = new Set(pack.conditions.map((c) => c.id));
  const targetIds = new Set([...ownTargetIds, ...(ctx.ancestorTargetIds ?? [])]);
  const conditionIds = new Set([...ownConditionIds, ...(ctx.ancestorConditionIds ?? [])]);

  checkTargets(pack.targets, ctx.ancestorTargetIds, report);
  for (const c of pack.conditions) {
    checkOverride(c.id, c.overrides, ctx.ancestorConditionIds, `conditions.${c.id}`, report);
    walkConditionTree(c, `conditions.${c.id}`, targetIds, conditionIds, report);
  }
  checkRefCycles(pack, report);
  for (const h of pack.handlers) checkHandler(h, pack.scope, targetIds, conditionIds, pack, ctx, report);

  return problems;
}

/** Every `ref` a condition's own tree holds (section 5 §5.6 "ref chains do not loop"). */
function refsWithin(node: PackCondition | NestedCheckShape): readonly string[] {
  if ("checks" in node) return node.checks.flatMap(refsWithin);
  if ("of" in node) return refsWithin(node.of);
  if ("ref" in node) return [node.ref];
  return [];
}

/** `ref` chains within this file must not loop. A cycle through a parent scope cannot happen:
 * the parent's own load already checked its own conditions. */
function checkRefCycles(pack: Pack, report: Reporter): void {
  const graph = new Map(pack.conditions.map((c) => [c.id, refsWithin(c)] as const));
  for (const start of graph.keys()) {
    const stack: string[] = [];
    const cleared = new Set<string>();
    const cycles = (id: string): boolean => {
      if (stack.includes(id)) return true;
      if (cleared.has(id)) return false;
      stack.push(id);
      const found = (graph.get(id) ?? []).some((next) => graph.has(next) && cycles(next));
      stack.pop();
      cleared.add(id);
      return found;
    };
    if (cycles(start)) report("ref_cycle", `conditions.${start}`, `${start} is part of a ref cycle`);
  }
}

/** True when `appVersion` matches any of a handler's own `app_versions` patterns, or when it
 * has none (section 5 §7.4 step 4). */
export function handlerMatchesVersion(h: Handler, appVersion: string): boolean {
  return h.app_versions === undefined || matchesAnyPattern(h.app_versions, appVersion);
}
