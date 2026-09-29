// Loader checks for the artifact file (`intyy.artifact/1.0`): everything section 2 §19 asks for,
// beyond the shape `artifact.ts` already parses. Follows design section 2 §19 (all subsections),
// §7.2 to §7.4 (value references, wildcards, text matching), and §14.5 (ref chains do not loop).
// The candidate/strict split follows section 6 §14.15 (blocking review issues) and
// docs/decisions.md, M04, 2026-09-29: a fresh candidate may lack a version, a seal, a
// reconciliation link, a commit point, human tags, a refusal decision, or `about` text. Those
// checks return `blocking` in candidate mode and `error` in strict mode. Every other §19 check
// means the file is malformed, and always returns `error`. The file split past 400 lines: recovery,
// portability, the session link, formats, and the candidate placeholders live in
// `artifact-checks-recovery.ts`; shared types and small helpers live in `artifact-checks-shared.ts`.
import type { z } from "zod";
import { fail, ok, type Outcome } from "../../ports/outcome.js";
import { Artifact, NestedCheck, type Condition, type StepAction } from "./artifact.js";
import {
  checkFormats,
  checkPortability,
  checkRecovery,
  checkSession,
  checkCandidatePlaceholders,
} from "./artifact-checks-recovery.js";
import {
  D_REF,
  type ArtifactCheckContext,
  type ArtifactMode,
  type ArtifactProblem,
  type Facts,
  type Reporter,
  checkNamespace,
  computeSecretTargets,
  makeReporter,
  scanRefs,
} from "./artifact-checks-shared.js";
import { issueText } from "./sealing.js";

export type { ArtifactCheckContext, ArtifactMode, ArtifactProblem, CapabilityShape } from "./artifact-checks-shared.js";

/** A nested check's shape. `NestedCheck` exports only the Zod schema, not its own type name. */
type NestedCheckShape = z.infer<typeof NestedCheck>;

const DUPLICATE_ID = "duplicate_id";
const REF_CYCLE = "ref_cycle";
const SECRET_NOT_WHOLE = "secret_not_whole_value";
const SECRET_FIELD_NOT_WILDCARD = "secret_field_not_wildcard";
const OUTPUT_NOT_READ = "output_not_read";
const OUTPUT_WRITTEN_TWICE = "output_written_twice";
const OUTCOME_UNUSED = "outcome_unused";
const POLICY_SECRET_UNDECLARED = "policy_secret_undeclared";

/** §19.1: every ID pool listed in section 2 §7.1 is unique within its own kind. */
function checkDuplicateIds(artifact: Artifact, report: Reporter): void {
  const pools: [readonly string[], string][] = [
    [artifact.targets.map((t) => t.id), "targets"],
    [artifact.conditions.map((c) => c.id), "conditions"],
    [artifact.steps.map((s) => s.id), "steps"],
    [artifact.contract.inputs.map((i) => i.name), "contract.inputs"],
    [artifact.contract.outputs.map((o) => o.name), "contract.outputs"],
    [artifact.contract.outcomes.map((o) => o.code), "contract.outcomes"],
  ];
  for (const [ids, path] of pools) {
    const seen = new Set<string>();
    for (const id of ids) {
      if (seen.has(id)) report(DUPLICATE_ID, path, `${id} is used twice`);
      seen.add(id);
    }
  }
}

/** §19.2: a target's `within`, and its clue text (`input` only, section 2 §7.2's table). */
function checkTargets(artifact: Artifact, facts: Facts, report: Reporter): void {
  for (const t of artifact.targets) {
    if (t.within !== undefined && !facts.targetIds.has(t.within)) {
      report(D_REF, `targets.${t.id}.within`, `${t.within} does not exist`);
    }
    if (t.clues.text !== undefined) {
      checkNamespace(t.clues.text, new Set(["input"]), `targets.${t.id}.clues.text`, facts, report);
    }
    if (t.clues.label !== undefined) {
      checkNamespace(t.clues.label, new Set(["input"]), `targets.${t.id}.clues.label`, facts, report);
    }
  }
}

/** Every `ref` a condition's tree holds, following `all_of`, `any_of`, and `not` (§14.5). */
function refsWithin(node: Condition | NestedCheckShape): readonly string[] {
  if ("checks" in node) return node.checks.flatMap(refsWithin);
  if ("of" in node) return refsWithin(node.of);
  if ("ref" in node) return [node.ref];
  return [];
}

/** §14.5: `ref` chains must not loop. Reports every condition on a cycle it takes part in. */
function checkRefCycles(artifact: Artifact, report: Reporter): void {
  const graph = new Map(artifact.conditions.map((c) => [c.id, refsWithin(c)] as const));
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
    if (cycles(start)) report(REF_CYCLE, `conditions.${start}`, `${start} is part of a ref cycle`);
  }
}

/** Walks one condition's tree: target and `ref` existence, namespace use, and the secret rule. */
function walkConditionTree(
  node: Condition | NestedCheckShape,
  path: string,
  facts: Facts,
  report: Reporter,
): void {
  if ("ref" in node) {
    if (!facts.conditionIds.has(node.ref)) report(D_REF, path, `${node.ref} does not exist`);
    return;
  }
  if ("checks" in node) {
    node.checks.forEach((c, i) => {
      walkConditionTree(c, `${path}.checks[${String(i)}]`, facts, report);
    });
    return;
  }
  if ("of" in node) {
    walkConditionTree(node.of, `${path}.of`, facts, report);
    return;
  }
  if ("target" in node && !facts.targetIds.has(node.target)) {
    report(D_REF, `${path}.target`, `${node.target} does not exist`);
  }
  if ("within" in node && node.within !== undefined && !facts.targetIds.has(node.within)) {
    report(D_REF, `${path}.within`, `${node.within} does not exist`);
  }
  if (node.check === "text_visible") {
    checkNamespace(node.text, new Set(["input", "system"]), `${path}.text`, facts, report);
  }
  if (node.check === "field_value") {
    checkNamespace(node.value, new Set(["input", "system"]), `${path}.value`, facts, report);
    if (facts.secretTargets.has(node.target) && !(node.value === "*" && node.match === "wildcard")) {
      report(
        SECRET_FIELD_NOT_WILDCARD,
        path,
        `target ${node.target} holds a secret; this check may only use the * wildcard`,
      );
    }
  }
}

/** §19.2, §14.5: every condition's tree and refs, plus `contract.outcomes[].condition`. */
function checkConditions(artifact: Artifact, facts: Facts, report: Reporter): void {
  for (const c of artifact.conditions) walkConditionTree(c, `conditions.${c.id}`, facts, report);
  checkRefCycles(artifact, report);
  artifact.contract.outcomes.forEach((o, i) => {
    if (!facts.conditionIds.has(o.condition)) {
      report(D_REF, `contract.outcomes[${String(i)}].condition`, `${o.condition} does not exist`);
    }
  });
}

/** One step's action: target and output references, and the `type` value's namespace rules. */
function checkStepAction(
  action: StepAction,
  path: string,
  facts: Facts,
  context: ArtifactCheckContext,
  report: Reporter,
): void {
  switch (action.type) {
    case "navigate":
    case "press":
      break;
    case "click":
    case "select":
    case "set_checked":
      if (!facts.targetIds.has(action.target)) report(D_REF, `${path}.target`, `${action.target} does not exist`);
      break;
    case "read":
      if (!facts.targetIds.has(action.target)) report(D_REF, `${path}.target`, `${action.target} does not exist`);
      break;
    case "type": {
      if (!facts.targetIds.has(action.target)) report(D_REF, `${path}.target`, `${action.target} does not exist`);
      checkNamespace(action.value, new Set(["input", "system", "secret"]), `${path}.value`, facts, report);
      const secretRef = scanRefs(action.value).find((r) => r.ns === "secret");
      if (secretRef !== undefined) {
        if (action.value.trim() !== `{secret.${secretRef.name}}`) {
          report(SECRET_NOT_WHOLE, `${path}.value`, "a secret reference must fill the whole value");
        }
        if (context.secretDeclared !== undefined && !context.secretDeclared(secretRef.name)) {
          report(POLICY_SECRET_UNDECLARED, `${path}.value`, `secret ${secretRef.name} is not in the app's policy`);
        }
      }
      break;
    }
  }
}

/** §19.2: every step's `precondition`, `checkpoint`, and action references. */
function checkSteps(
  artifact: Artifact,
  facts: Facts,
  context: ArtifactCheckContext,
  report: Reporter,
): void {
  artifact.steps.forEach((step, i) => {
    const path = `steps[${String(i)}]`;
    if (!facts.conditionIds.has(step.precondition)) {
      report(D_REF, `${path}.precondition`, `${step.precondition} does not exist`);
    }
    if (!facts.conditionIds.has(step.checkpoint)) {
      report(D_REF, `${path}.checkpoint`, `${step.checkpoint} does not exist`);
    }
    checkStepAction(step.action, `${path}.action`, facts, context, report);
  });
}

/** §19.3: each output has exactly one writer, each outcome is used, and refs resolve. */
function checkOutputsOutcomes(artifact: Artifact, report: Reporter): void {
  for (const output of artifact.contract.outputs) {
    const writers = artifact.steps.filter(
      (s) => s.action.type === "read" && s.action.output === output.name,
    );
    if (writers.length === 0) {
      report(OUTPUT_NOT_READ, `contract.outputs.${output.name}`, "no read step writes this output");
    } else if (writers.length > 1) {
      report(OUTPUT_WRITTEN_TWICE, `contract.outputs.${output.name}`, "more than one read step writes this output");
    }
  }
  for (const outcome of artifact.contract.outcomes) {
    if (!artifact.steps.some((s) => s.outcomes.includes(outcome.code))) {
      report(OUTCOME_UNUSED, `contract.outcomes.${outcome.code}`, "no step lists this outcome");
    }
  }
  artifact.steps.forEach((step, i) => {
    if (step.action.type === "read") {
      const output = step.action.output;
      if (!artifact.contract.outputs.some((o) => o.name === output)) {
        report(D_REF, `steps[${String(i)}].action.output`, `${output} is not a declared output`);
      }
    }
    for (const code of step.outcomes) {
      if (!artifact.contract.outcomes.some((o) => o.code === code)) {
        report(D_REF, `steps[${String(i)}].outcomes`, `${code} is not a declared outcome`);
      }
    }
  });
}

/**
 * Runs every section 2 §19 loader check on an already-parsed artifact. In `strict` mode every
 * failure is an `error`. In `candidate` mode, the review-only gaps of section 6 §14.15 (no
 * version, no seal, empty `about`, no commit point, an undecided tag, no reconciliation link, no
 * refusal decision on the commit step) come back as `blocking` instead, so the recorder can still
 * write the file and list them in `issues.json`. Every other failure means the file is malformed,
 * and is always an `error`. Never throws; expected trouble is a value (CLAUDE.md).
 */
export function checkArtifact(
  artifact: Artifact,
  mode: ArtifactMode,
  context: ArtifactCheckContext = {},
): ArtifactProblem[] {
  const problems: ArtifactProblem[] = [];
  const report = makeReporter(problems, mode);
  const facts: Facts = {
    targetIds: new Set(artifact.targets.map((t) => t.id)),
    conditionIds: new Set(artifact.conditions.map((c) => c.id)),
    inputNames: new Set(artifact.contract.inputs.map((i) => i.name)),
    outputNames: new Set(artifact.contract.outputs.map((o) => o.name)),
    secretTargets: computeSecretTargets(artifact),
  };

  checkDuplicateIds(artifact, report);
  checkTargets(artifact, facts, report);
  checkConditions(artifact, facts, report);
  checkSteps(artifact, facts, context, report);
  checkOutputsOutcomes(artifact, report);
  checkRecovery(artifact, context, facts, report);
  checkPortability(artifact, context, report);
  checkSession(artifact, context, report);
  checkFormats(artifact, context, report);
  checkCandidatePlaceholders(artifact, report);

  return problems;
}

/** One loaded artifact, plus every problem `checkArtifact` found (`blocking` ones included). */
export type LoadedArtifact = { readonly artifact: Artifact; readonly problems: readonly ArtifactProblem[] };

/**
 * Parses `raw` against the schema, then runs {@link checkArtifact}. Fails when the shape is
 * wrong, or when any problem is an `error` (a `blocking` one in candidate mode does not fail,
 * so the recorder can still write the file and list it in `issues.json`).
 */
export function loadArtifact(
  raw: unknown,
  mode: ArtifactMode,
  context: ArtifactCheckContext = {},
): Outcome<LoadedArtifact, "invalid"> {
  const parsed = Artifact.safeParse(raw);
  if (!parsed.success) return fail("invalid", issueText(parsed.error));
  const problems = checkArtifact(parsed.data, mode, context);
  const errors = problems.filter((p) => p.level === "error");
  if (errors.length > 0) {
    return fail("invalid", errors.map((p) => `${p.path}: ${p.message}`).join("; "));
  }
  return ok({ artifact: parsed.data, problems });
}
