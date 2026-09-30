// The handler pack file (`intyy.pack/1.0`) and one handler's shape.
// Follows design section 5 §5 (pack file), §6 (one handler), §7 (scope, merge, frozen set).
import { z } from "zod";
import { AppId, TenantId } from "./common.js";
import { RunId } from "./ids.js";
import { Condition } from "./artifact/conditions.js";
import { Decision, RunKind } from "./artifact/provenance.js";
import { SnakeId } from "./artifact/shared.js";
import { Target } from "./artifact/targets.js";
import { Approval } from "./store-index.js";

export { SnakeId } from "./artifact/shared.js";
export { Decision } from "./artifact/provenance.js";

/** Which layer a pack serves (section 5 §5.1, §5.2). `app_version` keeps a version range;
 * `tenant` names one bank's own copy. */
export const PackScope = z.discriminatedUnion("level", [
  z.object({ level: z.literal("global") }).strict(),
  z.object({ level: z.literal("app"), app: AppId }).strict(),
  z
    .object({ level: z.literal("app_version"), app: AppId, app_versions: z.array(z.string().min(1)).min(1) })
    .strict(),
  z.object({ level: z.literal("tenant"), tenant: TenantId, app: AppId }).strict(),
]);

/** One pack's scope. */
export type PackScope = z.infer<typeof PackScope>;

/** A fixture ID: shared across every pack (section 5 §13.1), same shape as any other ID. */
export const FixtureId = SnakeId;

/** A shared clue, saved once so `overrides: true` can be seen at a glance (section 5 §5.6). */
const overridesField = { overrides: z.boolean().optional() };

/** A pack's own target (section 5 §5.3): the artifact's target shape, plus `overrides` for a
 * reused ID (section 5 §5.6, §7.2). Whether a new ID wrongly sets it is a sealing-time check. */
export const PackTarget = Target.extend(overridesField);

/** One pack target. */
export type PackTarget = z.infer<typeof PackTarget>;

/** A pack's own condition (section 5 §5.3): the artifact's condition shape, plus `overrides`.
 * Every union member is a plain, strict object (`conditions.ts`), so each gets the field. */
export const PackCondition = z.union(Condition.options.map((o) => o.extend(overridesField)));

/** `T`, distributed member by member when `T` is a union (so `checks`, `target`, and the rest
 * of each variant keep their own literal type, unlike `z.infer` over a `.map()`-built union). */
type Distribute<T> = T extends infer U ? U & { overrides?: boolean | undefined } : never;

/** One pack condition. */
export type PackCondition = Distribute<z.infer<typeof Condition>>;

/** One handler's `fixtures` block (section 5 §6.1). Minimum-one counts (§13.3) are a fixture-suite
 * check, not a shape rule: a candidate mid-edit may hold fewer while its author is still working. */
export const HandlerFixtures = z.object({ fire: z.array(FixtureId), no_fire: z.array(FixtureId) }).strict();

/** A response action's risk, confirmed by a human at review (section 5 §6.4, §6.7). Never
 * `irreversible`: section 5 §5.6 forbids it outright. */
export const HandlerActionRisk = z.enum(["idempotent", "reversible"]);

/** A `navigate` response's location (section 5 §6.4): a fixed path, or "go back to where things
 * worked". Whether it sits inside `runs_on.paths` is a runtime, act-time check (§6.4), not a shape rule. */
export const NavigateLocation = z.union([z.literal("{system.last_good_path}"), z.string().regex(/^\/\S*$/)]);

/** One response action (section 5 §6.4). `sign_in` re-runs the prelude; every other type matches
 * the artifact's own action shapes, aimed at the pack's own targets. */
export const HandlerAction = z.discriminatedUnion("type", [
  z.object({ type: z.literal("navigate"), location: NavigateLocation, risk: HandlerActionRisk }).strict(),
  z.object({ type: z.literal("click"), target: SnakeId, risk: HandlerActionRisk }).strict(),
  z
    .object({ type: z.literal("type"), target: SnakeId, value: z.string().min(1), risk: HandlerActionRisk })
    .strict(),
  z
    .object({ type: z.literal("select"), target: SnakeId, value: z.string().min(1), risk: HandlerActionRisk })
    .strict(),
  z
    .object({ type: z.literal("set_checked"), target: SnakeId, checked: z.boolean(), risk: HandlerActionRisk })
    .strict(),
  z.object({ type: z.literal("press"), key: z.string().regex(/^[A-Z][A-Za-z0-9]*$/), risk: HandlerActionRisk }).strict(),
  z.object({ type: z.literal("sign_in"), risk: HandlerActionRisk }).strict(),
]);

/** One response action. */
export type HandlerAction = z.infer<typeof HandlerAction>;

/** `recoverable`'s attempt caps (section 5 §6.6). The engine's own caps also apply; the lower wins. */
export const HandlerLimits = z
  .object({ per_step: z.number().int().positive(), per_run: z.number().int().positive() })
  .strict();

/** The two allowed `hard_failure` codes (section 5 §6.2). */
export const HardFailureCode = z.enum(["app_error", "permission_denied"]);

/** What happens when `limits` runs out (section 5 §6.6). No silent default: the author decides. */
export const OnExhausted = z.discriminatedUnion("class", [
  z.object({ class: z.literal("hard_failure"), failure: HardFailureCode }).strict(),
  z.object({ class: z.literal("needs_human"), operator_note: z.string().min(1) }).strict(),
]);

/** A `business_outcome` handler's outcome (section 5 §6.1), the contract-outcome shape without
 * `condition`: the handler's own `detector` already names the proving condition. */
export const HandlerOutcome = z.object({ code: SnakeId, description: z.string().min(1) }).strict();

/** Fields every handler carries, whatever its class (section 5 §6.1). */
const handlerBase = {
  id: SnakeId,
  description: z.string().min(1),
  detector: SnakeId,
  priority: z.number().int().optional(),
  overrides: z.boolean().optional(),
  /** Wildcard patterns this handler is limited to. Tenant scope only (a loader check). */
  app_versions: z.array(z.string().min(1)).min(1).optional(),
  fixtures: HandlerFixtures,
};

/** One handler (section 5 §6): the state it names, and what it does about it. Only
 * `recoverable` acts (§6.2); the other three classes only name the state. */
export const Handler = z.discriminatedUnion("class", [
  z.object({ ...handlerBase, class: z.literal("business_outcome"), outcome: HandlerOutcome }).strict(),
  z
    .object({
      ...handlerBase,
      class: z.literal("recoverable"),
      response: z.array(HandlerAction).max(5),
      delay_ms: z.number().int().nonnegative().optional(),
      done_when: SnakeId.optional(),
      wait_ms: z.number().int().positive().optional(),
      limits: HandlerLimits,
      on_exhausted: OnExhausted,
    })
    .strict(),
  z.object({ ...handlerBase, class: z.literal("hard_failure"), failure: HardFailureCode }).strict(),
  z.object({ ...handlerBase, class: z.literal("needs_human"), operator_note: z.string().min(1) }).strict(),
]);

/** One handler. */
export type Handler = z.infer<typeof Handler>;

/** One `provenance.runs` entry (section 5 §15.3): lighter than an artifact's, a pack has no
 * capability contract to derive from a run. */
export const PackProvenanceRun = z.object({ run_id: RunId, kind: RunKind }).strict();

/** `provenance` (section 5 §5.2): runs, human decisions, and who sealed it. `sealed` is `null`
 * until sealing sets it (same candidate/sealed split as the artifact file, section 2 §19.9). */
export const PackProvenance = z
  .object({
    runs: z.array(PackProvenanceRun),
    decisions: z.array(Decision),
    sealed: Approval.nullable(),
  })
  .strict();

/** One pack file (section 5 §5): a bundle of known interruptions for one scope. */
export const Pack = z
  .object({
    schema: z.literal("intyy.pack/1.0"),
    scope: PackScope,
    revision: z.number().int().positive(),
    reason: z.string().min(1),
    targets: z.array(PackTarget),
    conditions: z.array(PackCondition),
    handlers: z.array(Handler),
    /** Inherited handler IDs to switch off. Version and tenant scopes only (a loader check). */
    disable: z.array(SnakeId).optional(),
    provenance: PackProvenance,
    approved: Approval.optional(),
  })
  .strict();

/** One pack file. */
export type Pack = z.infer<typeof Pack>;

/**
 * The store ID a pack's own scope names (section 9 §6.2): `global`, `app/<app>`,
 * `app_version/<app>/<pattern>`, or `tenant/<tenant>/<app>`. A folder name never decides
 * meaning; the loader checks it matches (section 9 §6.2).
 * ponytail: an `app_version` scope may list several wildcard patterns (section 5 §5.2), but one
 * file has one folder; this joins them with `+` and turns `*` into `x` for a safe path segment.
 * No app-version pack exists in this build, so a real multi-pattern folder name is untested.
 */
export function packScopeId(scope: PackScope): string {
  switch (scope.level) {
    case "global":
      return "global";
    case "app":
      return `app/${scope.app}`;
    case "app_version":
      return `app_version/${scope.app}/${scope.app_versions.map((p) => p.replaceAll("*", "x")).join("+")}`;
    case "tenant":
      return `tenant/${scope.tenant}/${scope.app}`;
  }
}

/** The CLI's scope notation (section 9 §8.5): `global`, `app:kvfcu`, `app_version:kvfcu:9.*`,
 * `tenant:keystone:kvfcu`. `null` when `text` fits none of these shapes. */
export function parsePackScopeArg(text: string): PackScope | null {
  const parts = text.split(":");
  if (parts[0] === "global" && parts.length === 1) return { level: "global" };
  if (parts[0] === "app" && parts.length === 2 && parts[1] !== undefined) {
    return { level: "app", app: parts[1] };
  }
  if (parts[0] === "app_version" && parts.length === 3 && parts[1] !== undefined && parts[2] !== undefined) {
    return { level: "app_version", app: parts[1], app_versions: [parts[2]] };
  }
  if (parts[0] === "tenant" && parts.length === 3 && parts[1] !== undefined && parts[2] !== undefined) {
    return { level: "tenant", tenant: parts[1], app: parts[2] };
  }
  return null;
}

/** The scope one level less specific than `scope`, or `null` past global (section 5 §7.1). Used
 * to find the parent scope a reference or an `overrides` flag must resolve against. */
export function parentScopes(scope: PackScope): PackScope[] {
  switch (scope.level) {
    case "global":
      return [];
    case "app":
      return [{ level: "global" }];
    case "app_version":
      return [{ level: "global" }, { level: "app", app: scope.app }];
    case "tenant":
      return [{ level: "global" }, { level: "app", app: scope.app }];
  }
}
