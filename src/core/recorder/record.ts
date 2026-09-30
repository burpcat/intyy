// The recorder's top-level entry point (section 6 §14.1, §14.2). Pure: every field traces to a
// logged event, a saved snapshot the caller supplied, or a recorded decision. No file access,
// no clock, no model call.
import type { Artifact } from "../model/artifact.js";
import { checkArtifact } from "../model/artifact-checks.js";
import type { CandidateDecision } from "../model/candidate-decision.js";
import type { HandlerDraft } from "../model/handler-draft.js";
import type { RunSpec } from "../model/runspec.js";
import {
  buildAbout,
  buildProvenanceActions,
  buildProvenanceDecisions,
  buildProvenanceRun,
} from "./about.js";
import { collectActions, collectObservationFiles } from "./collect.js";
import { ConditionRegistry } from "./conditions.js";
import {
  applyEditDecisions,
  applyOutcomeNameDecisions,
  applyRecoveryDecisions,
  applyRiskDecisions,
  applySensitivityDecisions,
} from "./decide.js";
import { buildDrafts, buildNormalFixtures, type NormalFixture } from "./drafts.js";
import type { RecorderIssue } from "./issues.js";
import { alignNegativeRun, attachOutcome, buildOutcome } from "./outcomes.js";
import { buildPaths } from "./paths.js";
import { buildRecovery, pickCommitPoint } from "./risk.js";
import { buildContractInputs } from "./sensitivity.js";
import { buildContractOutputs } from "./outputs.js";
import { buildSteps, EMPTY_SNAPSHOTS, type Snapshots } from "./steps.js";
import { applyTags, keptActions } from "./tags.js";
import { RECORDER_VERSION } from "./version.js";

/** One linked run's masked log, and the saved snapshots §14.5's rules need. */
export type RunLines = {
  runId: string;
  spec: RunSpec;
  /** Already-`JSON.parse`d lines of that run's masked `events.jsonl`, in file order. */
  lines: readonly unknown[];
  snapshots?: Snapshots;
};

/** Everything one candidate needs that no run log carries (section 2 §10). */
export type RunContext = {
  tenant: string;
  appVersion: string;
  viewport: { width: number; height: number; scale: number };
};

/** What {@link record} needs (section 6 §14.1). */
export type RecorderInput = {
  positive: RunLines;
  negatives?: readonly RunLines[];
  decisions: readonly CandidateDecision[];
  context: RunContext;
  /**
   * The previous sealed version, for ID reuse (section 6 §14.13). Not yet implemented: with no
   * earlier version there is nothing to reuse, so this milestone only builds that path.
   * ponytail: M05 adds voting new targets against `previous.targets` with the section 7 §6 clue
   * voter, when this is not `null`.
   */
  previous?: Artifact | null;
};

/** What {@link record} returns (section 6 §14.1). */
export type RecorderOutput = {
  candidate: Artifact;
  issues: readonly RecorderIssue[];
  drafts: readonly HandlerDraft[];
  /** Target ID to its crop's source path inside its run folder. */
  crops: ReadonlyMap<string, string>;
  normalFixtures: readonly NormalFixture[];
};

/** Among risk issues, a lowered flag shows before an undecided one (section 6 §14.9, "Lowered
 * flags show first"). Everything else keeps its relative order (a stable sort). */
const RISK_ISSUE_RANK: Record<string, number> = { risk_second_look: 0, risk_undecided: 1 };

/** Every review issue, blocking ones first, lowered risk flags first among those (section 6
 * §14.15, §14.9). */
function sortIssues(issues: readonly RecorderIssue[]): RecorderIssue[] {
  return [...issues].sort((a, b) => {
    if (a.level !== b.level) return a.level === "blocking" ? -1 : 1;
    return (RISK_ISSUE_RANK[a.code] ?? 2) - (RISK_ISSUE_RANK[b.code] ?? 2);
  });
}

/**
 * Builds one candidate artifact from a positive run, any linked negative runs, and the
 * decisions so far (section 6 §14.2). The same inputs always give the same bytes.
 */
export function record(input: RecorderInput): RecorderOutput {
  const issues: RecorderIssue[] = [];
  const { positive, decisions, context } = input;
  const snapshots = positive.snapshots ?? EMPTY_SNAPSHOTS;

  const positiveRaw = collectActions(positive.runId, positive.lines);
  const positiveTagged = applyTags(positiveRaw, decisions);
  const positiveKept = keptActions(positiveTagged);
  const effect = positive.spec.expected_effect;
  const stepsResult = buildSteps(positiveKept, snapshots);
  issues.push(...stepsResult.issues);

  // The `risk` decision applies before the commit point is picked: a lowering can remove the
  // one irreversible step a `commits` capability needs (section 6 §14.9, §15).
  let steps = applyRiskDecisions(
    stepsResult.steps,
    decisions,
    stepsResult.gateRiskByStepId,
    stepsResult.riskHintByStepId,
    issues,
  );

  const registry = new ConditionRegistry(stepsResult.conditions);
  const outcomes: { code: string; description: string; condition: string }[] = [];
  for (const neg of input.negatives ?? []) {
    const negSnapshots = neg.snapshots ?? EMPTY_SNAPSHOTS;
    const negRaw = collectActions(neg.runId, neg.lines);
    const negTagged = applyTags(negRaw, decisions);
    const negKept = keptActions(negTagged);
    const aligned = alignNegativeRun(negKept, steps, stepsResult.targets);
    const built = buildOutcome(neg.spec, aligned, negSnapshots, registry, issues);
    if (built !== null) {
      steps = attachOutcome(steps, built.stepId, built.outcome.code);
      outcomes.push(built.outcome);
    }
  }

  let contract = applySensitivityDecisions(
    {
      inputs: buildContractInputs(positive.spec.inputs),
      outputs: buildContractOutputs(positive.spec.outputs),
      outcomes,
      effect,
    },
    decisions,
  );
  const named = applyOutcomeNameDecisions(contract.outcomes, steps, decisions);
  contract = { ...contract, outcomes: named.outcomes };
  steps = named.steps;

  const commitPoint = pickCommitPoint(steps, effect, issues);
  const recovery = applyRecoveryDecisions(buildRecovery(commitPoint, effect), decisions, issues);

  const drafted = buildDrafts(positiveTagged, positive.spec.app, context.tenant, context.appVersion, snapshots);
  const normalFixtures = buildNormalFixtures(
    positiveKept.map((a) => ({ turn: a.turn, location: a.beforeLocation })),
    collectObservationFiles(positive.lines),
  );

  const pathsResult = buildPaths(
    positive.spec.entry,
    positiveKept.flatMap((a) => [a.beforeLocation, ...(a.afterLocation === null ? [] : [a.afterLocation])]),
  );
  for (const unmatched of pathsResult.unmatched) {
    issues.push({ level: "warning", code: "unmatched_path", message: `${unmatched} did not become a path pattern.` });
  }

  const becameOf = (a: (typeof positiveTagged)[number]): string =>
    stepsResult.became.get(a) ?? drafted.became.get(a) ?? "dropped";

  let candidate: Artifact = {
    schema: "intyy.artifact/1.0",
    identity: { app: positive.spec.app, capability: positive.spec.capability, version: null },
    runs_on: {
      surface: "web",
      app_versions: [context.appVersion],
      viewport: context.viewport,
      entry: positive.spec.entry,
      paths: pathsResult.paths,
      session: positive.spec.session,
    },
    about: buildAbout(positive.spec),
    contract,
    targets: [...stepsResult.targets],
    conditions: [...registry.list()],
    steps: [...steps],
    provenance: {
      runs: [
        buildProvenanceRun(positive.spec, positive.runId, "discovery", RECORDER_VERSION),
        ...(input.negatives ?? []).map((n) =>
          buildProvenanceRun(n.spec, n.runId, "negative_discovery", RECORDER_VERSION),
        ),
      ],
      derived_from: null,
      actions: [
        ...buildProvenanceActions(positiveTagged, decisions, becameOf),
        ...(input.negatives ?? []).flatMap((n) => {
          const raw = collectActions(n.runId, n.lines);
          const tagged = applyTags(raw, decisions);
          return buildProvenanceActions(tagged, decisions, () => "dropped");
        }),
      ],
      decisions: buildProvenanceDecisions(decisions),
      sealed: null,
    },
  };
  if (recovery !== undefined) candidate.recovery = recovery;

  // `edit` decisions are applied last of all (section 6 §15); a rename among them rewrites
  // every reference to the old ID, so it must see every other block already in place.
  candidate = applyEditDecisions(candidate, decisions, issues);

  issues.push(...checkArtifact(candidate, "candidate").map((p) => ({
    level: "blocking" as const,
    code: p.code,
    subject: p.path,
    message: p.message,
  })));

  return {
    candidate,
    issues: sortIssues(issues),
    drafts: drafted.drafts,
    crops: stepsResult.crops,
    normalFixtures,
  };
}
