// Applies every review decision to the recorder's draft, deterministically (section 2 §6.4:
// the last decision on a subject wins). `record.ts` calls these in section 6 §15's order:
// risk, sensitivity, outcome_name, waiver/recovery, then edit last of all.
import type { z } from "zod";
import { Artifact, Condition, NestedCheck } from "../model/artifact.js";
import type { Contract, ContractInput, ContractOutcome, ContractOutput } from "../model/artifact/contract.js";
import type { Target } from "../model/artifact/targets.js";
import type { Recovery } from "../model/artifact/recovery.js";
import type { RiskKind, Step } from "../model/artifact/steps.js";
import type { CandidateDecision, CandidateDecisionWhat } from "../model/candidate-decision.js";
import { checkArtifact } from "../model/artifact-checks.js";
import type { Handler, PackCondition, PackTarget } from "../model/pack.js";
import type { FrozenSet } from "../packs/merge.js";
import { ConditionRegistry, type NestedLeaf } from "./conditions.js";
import type { RecorderIssue } from "./issues.js";

/** A nested pack check's shape: no `id`/`description` (same recursive union `checks.ts` uses). */
type NestedCheckShape = z.infer<typeof NestedCheck>;

/** The merged pack set `applyOutcomeNameDecisions` needs, for a `pack:` adoption. */
export type PackHandlerSet = Pick<FrozenSet, "targets" | "conditions" | "handlers">;

/** The last decision per subject, for one `what` (section 2 §6.4). Decision order is the
 * append order of `decisions.jsonl`. */
function lastBySubject(
  decisions: readonly CandidateDecision[],
  what: CandidateDecisionWhat,
): ReadonlyMap<string, CandidateDecision> {
  const out = new Map<string, CandidateDecision>();
  for (const d of decisions) if (d.what === what) out.set(d.subject, d);
  return out;
}

/**
 * `risk` decisions override a step's drafted risk (section 6 §15). A lowering from the rules'
 * own class (`gateRiskByStepId`, always `irreversible` when the draft had no gate line to read
 * either) needs a `risk_second_look` decision by a different staff ID, else it is a blocking
 * issue (section 9 §8.3, section 6 §14.9, §15 rule 4). A `risk_second_look` by the same staff
 * ID as the lowering decision does not count; a later `risk` decision from another reviewer
 * naturally overrides the lowering instead (last decision wins), which needs no second look.
 *
 * Every step still needs its own `risk` decision (section 6 §14.9: "Every flag still needs a
 * human `risk` decision"; §14.15 lists "Undecided risk flags" as blocking): the operator's
 * discovery-time approval hint is only the draft, never the review decision. A step with no
 * `risk` decision at all gets a `risk_undecided` blocking issue too, on top of any
 * `risk_second_look` one.
 */
export function applyRiskDecisions(
  steps: readonly Step[],
  decisions: readonly CandidateDecision[],
  gateRiskByStepId: ReadonlyMap<string, RiskKind>,
  riskHintByStepId: ReadonlyMap<string, string | null>,
  issues: RecorderIssue[],
): Step[] {
  const riskDecisions = lastBySubject(decisions, "risk");
  const secondLooks = new Map<string, CandidateDecision[]>();
  for (const d of decisions) {
    if (d.what !== "risk_second_look") continue;
    secondLooks.set(d.subject, [...(secondLooks.get(d.subject) ?? []), d]);
  }
  return steps.map((s) => {
    const decision = riskDecisions.get(s.id);
    const finalRisk = decision === undefined ? s.risk : (decision.value as RiskKind);
    const rulesRisk = gateRiskByStepId.get(s.id) ?? "irreversible";
    if (rulesRisk === "irreversible" && finalRisk !== "irreversible") {
      const loweredBy = decision?.by ?? riskHintByStepId.get(s.id) ?? null;
      const looks = secondLooks.get(s.id) ?? [];
      const confirmed = looks.some((l) => loweredBy === null || l.by !== loweredBy);
      if (!confirmed) {
        issues.push({
          level: "blocking",
          code: "risk_second_look",
          subject: s.id,
          message: `${s.id}'s risk was lowered from irreversible (the rules' class) to ${finalRisk}; a second look by another staff ID is needed.`,
        });
      }
    }
    if (decision === undefined) {
      issues.push({
        level: "blocking",
        code: "risk_undecided",
        subject: s.id,
        message: `${s.id}'s risk (${finalRisk}) has not been confirmed by a risk decision yet.`,
      });
    }
    return finalRisk === s.risk ? s : { ...s, risk: finalRisk };
  });
}

/** `sensitivity` decisions override a contract input's or output's label, by name. */
export function applySensitivityDecisions(
  contract: Contract,
  decisions: readonly CandidateDecision[],
): Contract {
  const bySubject = lastBySubject(decisions, "sensitivity");
  if (bySubject.size === 0) return contract;
  const inputs: ContractInput[] = contract.inputs.map((i) => {
    const d = bySubject.get(i.name);
    return d === undefined ? i : { ...i, sensitivity: d.value as ContractInput["sensitivity"] };
  });
  const outputs: ContractOutput[] = contract.outputs.map((o) => {
    const d = bySubject.get(o.name);
    return d === undefined ? o : { ...o, sensitivity: d.value as ContractOutput["sensitivity"] };
  });
  return { ...contract, inputs, outputs };
}

/** Copies one pack target into the artifact's own target list, renaming on an ID clash (the
 * same numbering rule as {@link ConditionRegistry.intern}). Memoized by `idMap`, so a target
 * reached more than once — including through a `within` chain — is copied only once. `null`
 * only when `packId` does not resolve: the pack loader already forbids that (section 5 §5.6). */
function copyPackTarget(
  packId: string,
  packTargetsById: ReadonlyMap<string, PackTarget>,
  targets: Target[],
  usedIds: Set<string>,
  idMap: Map<string, string>,
): string | null {
  const already = idMap.get(packId);
  if (already !== undefined) return already;
  const packTarget = packTargetsById.get(packId);
  if (packTarget === undefined) return null;
  let id = packTarget.id;
  for (let n = 2; usedIds.has(id); n++) id = `${packTarget.id}_${String(n)}`;
  usedIds.add(id);
  idMap.set(packId, id);
  const within =
    packTarget.within === undefined ? undefined : copyPackTarget(packTarget.within, packTargetsById, targets, usedIds, idMap);
  targets.push({ id, description: packTarget.description, clues: packTarget.clues, ...(within === null || within === undefined ? {} : { within }) });
  return id;
}

/** Flattens one pack condition into a plain nested check (section 5 §5.3: a pack's targets and
 * conditions are their own name space, so every `ref` here resolves only in `packConditionsById`,
 * never the artifact's own conditions). Inlining every `ref` this way, instead of copying it as
 * its own named condition, needs no second ID-clash pass for condition IDs: only the one final,
 * flattened check is registered, through {@link ConditionRegistry.intern}'s own content-based
 * dedup. Every target reference is copied and renamed on clash, section 5 §7.6's targets. */
function flattenPackCondition(
  node: PackCondition | NestedCheckShape,
  packConditionsById: ReadonlyMap<string, PackCondition>,
  packTargetsById: ReadonlyMap<string, PackTarget>,
  targets: Target[],
  usedIds: Set<string>,
  idMap: Map<string, string>,
): NestedLeaf {
  const copyTarget = (id: string): string => copyPackTarget(id, packTargetsById, targets, usedIds, idMap) ?? id;
  const recurse = (n: PackCondition | NestedCheckShape): NestedLeaf =>
    flattenPackCondition(n, packConditionsById, packTargetsById, targets, usedIds, idMap);
  if ("ref" in node) {
    const next = packConditionsById.get(node.ref);
    return next === undefined ? { check: "text_visible", text: "*", match: "wildcard" } : recurse(next);
  }
  switch (node.check) {
    case "all_of":
      return { check: "all_of", checks: node.checks.map(recurse) };
    case "any_of":
      return { check: "any_of", checks: node.checks.map(recurse) };
    case "not":
      return { check: "not", of: recurse(node.of) };
    case "element_visible":
      return { check: "element_visible", target: copyTarget(node.target) };
    case "element_state":
      return { check: "element_state", target: copyTarget(node.target), state: node.state };
    case "field_value":
      // Unreachable in a sealed pack: the loader forbids `field_value` (section 5 §5.6). Copied
      // defensively all the same, so a malformed one still yields a valid check, never a throw.
      return { ...node, target: copyTarget(node.target) };
    case "count":
      return { ...node, within: copyTarget(node.within) };
    case "text_visible":
      return node.within === undefined ? node : { ...node, within: copyTarget(node.within) };
    case "location":
      return node;
  }
}

/**
 * Copies a `business_outcome` pack handler's outcome, code, description, and detector
 * condition into the artifact (section 5 §9.2: "Adopting copies the code, description, and
 * condition into the artifact"). `null` when `handler` cannot be adopted: not found, not a
 * `business_outcome`, or its detector does not resolve — the caller raises a blocking issue.
 */
function copyHandlerOutcome(
  handler: Handler,
  packs: PackHandlerSet,
  registry: ConditionRegistry,
  targets: Target[],
  usedIds: Set<string>,
  idMap: Map<string, string>,
): { code: string; description: string; condition: string } | null {
  if (handler.class !== "business_outcome") return null;
  const packConditionsById = new Map(packs.conditions.map((c) => [c.id, c] as const));
  const packTargetsById = new Map(packs.targets.map((t) => [t.id, t] as const));
  const detector = packConditionsById.get(handler.detector);
  if (detector === undefined) return null;
  const nested = flattenPackCondition(detector, packConditionsById, packTargetsById, targets, usedIds, idMap);
  const condition = registry.intern(nested, `${handler.outcome.code}_shown`, handler.outcome.description);
  return { code: handler.outcome.code, description: handler.outcome.description, condition };
}

/**
 * `outcome_name` decisions rename a drafted outcome's code, everywhere it appears: the
 * contract's own entry, and the step it is attached to. A `pack:<handler_id>` value is not a
 * plain rename (section 5 §9.2, section 2 §17.4): it copies that pack handler's outcome code,
 * description, and detector condition into the artifact instead, and the decision's own
 * `pack:<handler_id>` value stays in provenance only, never as the outcome's own code. A
 * missing or ineligible handler is a blocking issue, never a throw: `packs` may be `undefined`
 * (a caller with no pack set to offer, such as a test with no `pack:` decisions at all).
 */
export function applyOutcomeNameDecisions(
  outcomes: readonly ContractOutcome[],
  steps: readonly Step[],
  targets: readonly Target[],
  registry: ConditionRegistry,
  decisions: readonly CandidateDecision[],
  packs: PackHandlerSet | undefined,
  issues: RecorderIssue[],
): { outcomes: ContractOutcome[]; steps: Step[]; targets: Target[] } {
  const renames = lastBySubject(decisions, "outcome_name");
  const codeMap = new Map<string, string>();
  const replacements = new Map<string, ContractOutcome>();
  const nextTargets = [...targets];
  const usedIds = new Set(nextTargets.map((t) => t.id));
  const idMap = new Map<string, string>();
  for (const o of outcomes) {
    const d = renames.get(o.code);
    if (d === undefined) continue;
    const packMatch = /^pack:([a-z][a-z0-9_]*)$/.exec(d.value);
    if (packMatch?.[1] === undefined) {
      codeMap.set(o.code, d.value);
      continue;
    }
    const handlerId = packMatch[1];
    const handler = packs === undefined ? undefined : packs.handlers.find((h) => h.id === handlerId);
    const copied =
      packs === undefined || handler === undefined
        ? null
        : copyHandlerOutcome(handler, packs, registry, nextTargets, usedIds, idMap);
    if (copied === null) {
      issues.push({
        level: "blocking",
        code: "pack_outcome_missing",
        subject: o.code,
        message: `${o.code} was adopted from pack handler ${handlerId}, which is not a business_outcome handler in the merged pack set.`,
      });
      continue;
    }
    codeMap.set(o.code, copied.code);
    replacements.set(o.code, copied);
  }
  if (codeMap.size === 0) return { outcomes: [...outcomes], steps: [...steps], targets: nextTargets };
  return {
    outcomes: outcomes.map((o) => replacements.get(o.code) ?? { ...o, code: codeMap.get(o.code) ?? o.code }),
    steps: steps.map((s) => ({ ...s, outcomes: s.outcomes.map((c) => codeMap.get(c) ?? c) })),
    targets: nextTargets,
  };
}

/** One JSON object, loosely checked. */
function parseJsonObject(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * `waiver` and `recovery` decisions both fill in `recovery.reconciliation` (section 6 §15):
 * `waiver`'s value is a JSON `{ reason }`; `recovery`'s is a JSON reconciliation link,
 * `{ capability, inputs, not_found_outcomes?, outputs? }`. Both share one subject,
 * `recovery.reconciliation`, so the later decision (of either kind) wins. A value that will
 * not parse, or does not fit, is a blocking issue; `recovery` is returned unchanged.
 */
export function applyRecoveryDecisions(
  recovery: Recovery | undefined,
  decisions: readonly CandidateDecision[],
  issues: RecorderIssue[],
): Recovery | undefined {
  if (recovery === undefined) return undefined;
  let last: CandidateDecision | undefined;
  for (const d of decisions) {
    if ((d.what === "waiver" || d.what === "recovery") && d.subject === "recovery.reconciliation") {
      last = d;
    }
  }
  if (last === undefined) return recovery;
  const fail = (message: string): Recovery => {
    issues.push({ level: "blocking", code: "invalid_recovery_decision", subject: last.subject, message });
    return recovery;
  };
  const parsed = parseJsonObject(last.value);
  if (parsed === null) return fail("recovery.reconciliation's decision value is not a JSON object.");
  if (last.what === "waiver") {
    if (typeof parsed.reason !== "string" || parsed.reason === "") {
      return fail("a waiver needs a non-empty reason.");
    }
    return { ...recovery, reconciliation: { waiver: { reason: parsed.reason } } };
  }
  if (typeof parsed.capability !== "string" || typeof parsed.inputs !== "object" || parsed.inputs === null) {
    return fail("a reconciliation link needs a capability and inputs.");
  }
  return {
    ...recovery,
    reconciliation: {
      check: {
        capability: parsed.capability,
        inputs: parsed.inputs as Record<string, string>,
        not_found_outcomes: Array.isArray(parsed.not_found_outcomes)
          ? parsed.not_found_outcomes.filter((x): x is string => typeof x === "string")
          : [],
        outputs:
          typeof parsed.outputs === "object" && parsed.outputs !== null
            ? (parsed.outputs as Record<string, string>)
            : {},
      },
    },
  };
}

/** Fields an `edit` decision may change on `about` (section 6 §15). */
const ABOUT_FIELDS = new Set(["title", "summary", "when_to_use", "limits"]);

/** A JSON array of strings, or `null` on bad JSON or a non-string entry. */
function parseJsonStringArray(value: string): string[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  return Array.isArray(parsed) && parsed.every((p): p is string => typeof p === "string") ? parsed : null;
}

/** One dotted-path `edit` (section 6 §15): `about.<field>`, `runs_on.paths` (section 2 §10: "a
 * human confirms paths at review"), `conditions.<id>` (a whole condition body), or
 * `<kind>.<id>.<field>` for `steps`, `targets`, and `conditions`. Anything else is not (yet)
 * supported. */
function applyOneEdit(
  candidate: Artifact,
  subject: string,
  value: string,
  issues: RecorderIssue[],
): Artifact {
  const parts = subject.split(".");
  const bad = (message: string): Artifact => {
    issues.push({ level: "blocking", code: "invalid_edit", subject, message });
    return candidate;
  };
  if (parts.length === 2 && parts[0] === "about" && ABOUT_FIELDS.has(parts[1] ?? "")) {
    return { ...candidate, about: { ...candidate.about, [parts[1] ?? ""]: value } };
  }
  if (parts.length === 2 && parts[0] === "runs_on" && parts[1] === "paths") {
    // The outer `applyChecked` (Artifact.safeParse) runs each entry through the same
    // `PathPattern` schema `runs_on.paths` already uses, so a bad pattern still ends up as this
    // subject's `invalid_edit`, never a throw.
    const paths = parseJsonStringArray(value);
    if (paths === null) return bad(`${subject}: value must be a JSON array of path patterns.`);
    return { ...candidate, runs_on: { ...candidate.runs_on, paths } };
  }
  if (parts.length === 2 && parts[0] === "conditions") {
    const id = parts[1] ?? "";
    const idx = candidate.conditions.findIndex((c) => c.id === id);
    const existing = candidate.conditions[idx];
    if (existing === undefined) return bad(`no condition named ${id}.`);
    let bodyJson: unknown;
    try {
      bodyJson = JSON.parse(value);
    } catch {
      return bad(`${subject}: value is not valid JSON.`);
    }
    const body = NestedCheck.safeParse(bodyJson);
    if (!body.success) return bad(`${subject}: value is not a valid condition body.`);
    const merged = Condition.safeParse({ ...body.data, id: existing.id, description: existing.description });
    if (!merged.success) return bad(`${subject}: value is not a valid condition body.`);
    const newConditions = [...candidate.conditions];
    newConditions[idx] = merged.data;
    const after: Artifact = { ...candidate, conditions: newConditions };
    // The usual candidate checks (section 2 §19): a replaced check can point at a target or
    // another condition that does not exist. `Artifact.safeParse` alone would miss that; only
    // an `error`-level problem counts, the same filter `loadArtifact` uses in candidate mode, so
    // this never trips on the review-only gaps every fresh candidate still has.
    const problem = checkArtifact(after, "candidate").find((p) => p.level === "error");
    if (problem !== undefined) return bad(`${subject}: ${problem.message}.`);
    return after;
  }
  if (parts.length === 3 && (parts[0] === "steps" || parts[0] === "targets" || parts[0] === "conditions")) {
    const kind = parts[0];
    const id = parts[1] ?? "";
    const field = parts[2] ?? "";
    const list = candidate[kind] as readonly { id: string }[];
    const idx = list.findIndex((x) => x.id === id);
    if (idx === -1) return bad(`no ${kind.slice(0, -1)} named ${id}.`);
    const item = list[idx];
    if (item === undefined) return bad(`no ${kind.slice(0, -1)} named ${id}.`);
    let patch: Record<string, unknown> | null = null;
    if (kind === "steps" && (field === "intent" || field === "id")) patch = { [field]: value };
    else if (kind === "steps" && field === "timeout_ms") {
      const n = Number(value);
      if (!Number.isFinite(n) || n <= 0) return bad(`${subject}: not a positive number of milliseconds.`);
      patch = { timeout_ms: n };
    } else if ((kind === "targets" || kind === "conditions") && (field === "description" || field === "id")) {
      patch = { [field]: value };
    }
    if (patch === null) return bad(`${field} is not an editable field of ${kind}.`);
    const newList = [...list];
    newList[idx] = { ...item, ...patch };
    return { ...candidate, [kind]: newList };
  }
  return bad("not a supported edit path.");
}

/** Every key whose string value is an ID reference, for {@link renameRefs} (section 2 §13, §14,
 * §15, §16): a target, a condition's `ref`, `within`, or `commit_point`. */
const ID_REF_KEYS = new Set(["target", "within", "precondition", "checkpoint", "ref", "condition", "commit_point"]);

/** Rewrites every reference to `oldId` as `newId`, on the known ID-reference keys, and on a
 * `provenance.actions[].became` value like `step:<id>` or `handler_draft:<id>`. Never touches a
 * plain `id` field: the caller already renamed the one object that owns it. */
function renameRefs(value: unknown, oldId: string, newId: string): unknown {
  if (Array.isArray(value)) return value.map((v) => renameRefs(v, oldId, newId));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === "id") {
        out[k] = v;
      } else if (typeof v === "string" && ID_REF_KEYS.has(k) && v === oldId) {
        out[k] = newId;
      } else if (typeof v === "string" && (v === `step:${oldId}` || v === `handler_draft:${oldId}`)) {
        out[k] = v.replace(`:${oldId}`, `:${newId}`);
      } else {
        out[k] = renameRefs(v, oldId, newId);
      }
    }
    return out;
  }
  return value;
}

/** `edit` decisions (section 6 §15), applied after every other decision kind. A rename (its
 * field is `id`) is applied last of all, and rewrites every reference to the old ID. An edit
 * that would produce an invalid artifact is a blocking issue; the candidate keeps its old value. */
export function applyEditDecisions(
  candidate: Artifact,
  decisions: readonly CandidateDecision[],
  issues: RecorderIssue[],
): Artifact {
  const bySubject = lastBySubject(decisions, "edit");
  const plain: CandidateDecision[] = [];
  const renames: CandidateDecision[] = [];
  for (const d of bySubject.values()) {
    (d.subject.endsWith(".id") ? renames : plain).push(d);
  }

  const applyChecked = (before: Artifact, after: unknown, subject: string, onFail: string): Artifact => {
    const check = Artifact.safeParse(after);
    if (check.success) return check.data;
    issues.push({ level: "blocking", code: "invalid_edit", subject, message: onFail });
    return before;
  };

  let out = candidate;
  for (const d of plain) {
    const attempted = applyOneEdit(out, d.subject, d.value, issues);
    out = applyChecked(out, attempted, d.subject, `${d.subject}: produced an invalid artifact.`);
  }
  for (const d of renames) {
    const parts = d.subject.split(".");
    const oldId = parts[1] ?? "";
    const attempted = applyOneEdit(out, d.subject, d.value, issues);
    const renamed = renameRefs(attempted, oldId, d.value);
    out = applyChecked(
      out,
      renamed,
      d.subject,
      `${d.subject}: renaming ${oldId} to ${d.value} produced an invalid artifact.`,
    );
  }
  return out;
}
