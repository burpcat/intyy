// Product logic for recording and reviewing a run as an artifact candidate: rebuilding a
// candidate's three files from its linked runs and decisions, and resolving a decision's
// subject (mapping a shown, possibly renamed, ID back to the one the recorder generated).
// Follows design section 6 §14.1 (the recorder is a pure function of its inputs, re-run after
// every decision), §14.8 (negative runs attach), and §15 (what each decision records).
// `src/cli/commands/candidate.ts` is the only caller: it owns argument parsing, role checks,
// prompting, and printing. Every failure here is an `Outcome`, never a thrown `CliExit`.
import { fail, ok, type Outcome } from "../../ports/outcome.js";
import type { Clock, Ids } from "../../ports/clock.js";
import type { CandidateStore, DocumentStore, EvidenceStore } from "../../ports/stores.js";
import type { Artifact } from "../model/artifact.js";
import type { CandidateDecision, CandidateDecisionWhat } from "../model/candidate-decision.js";
import type { CandidateIssues } from "../model/candidate-issues.js";
import { CandidateRuns, type CandidateRunRef } from "../model/candidate-runs.js";
import { RunJson } from "../model/run.js";
import type { RunSpec } from "../model/runspec.js";
import type { Settings } from "../model/settings.js";
import { DISCOVERY_VIEWPORT } from "../orchestrator/discovery.js";
import { loadRunLines } from "./load.js";
import { record, type RecorderOutput, type RunContext, type RunLines } from "./record.js";

/** A candidate folder's files (section 9 §6.2): linked runs, the regenerated artifact, and its
 * review issues. */
export type CandidateFiles = {
  "runs.json": CandidateRuns;
  "candidate.json": Artifact;
  "issues.json": CandidateIssues;
};

/**
 * Reads one app/capability's run spec. A spec file is a plain file in git, not behind a store
 * port (docs/decisions.md, M03), so the CLI supplies this: it knows where `library/specs/`
 * lives, which this module must not.
 */
export type SpecLookup = (
  app: string,
  capability: string,
) => Promise<Outcome<RunSpec, "not_found" | "invalid">>;

/** Every port this module's functions need. */
export type CandidateDeps = {
  candidates: CandidateStore<CandidateFiles, CandidateDecision>;
  evidence: EvidenceStore;
  settings: DocumentStore<Settings>;
  ids: Ids;
  clock: Clock;
  specs: SpecLookup;
};

/** Reads and checks one run's `run.json` (section 3 §7.3). */
async function readRunSummary(
  evidence: EvidenceStore,
  tenant: string,
  runId: string,
): Promise<Outcome<RunJson, "not_found" | "invalid">> {
  const got = await evidence.readRunJson(tenant, runId);
  if (!got.ok) return fail("not_found", `run ${runId} has no run.json yet; is it finished?`);
  const parsed = RunJson.safeParse(got.value);
  if (!parsed.success) return fail("invalid", `run ${runId}: run.json does not fit its schema`);
  return ok(parsed.data);
}

/** Reads one linked run's spec and masked log into what the recorder needs. */
async function loadOneRun(
  deps: CandidateDeps,
  ref: CandidateRunRef,
  tool: "done" | "report_outcome",
): Promise<Outcome<RunLines, "not_found" | "invalid">> {
  const summary = await readRunSummary(deps.evidence, ref.tenant, ref.run_id);
  if (!summary.ok) return summary;
  const [app, name] = summary.value.capability.split("/");
  if (app === undefined || name === undefined) {
    return fail("invalid", `run ${ref.run_id}: run.json names no capability`);
  }
  const spec = await deps.specs(app, name);
  if (!spec.ok) return spec;
  return loadRunLines(deps.evidence, ref.tenant, ref.run_id, spec.value, tool);
}

/** The newest approved revision's `app_version`, for one tenant and app. */
async function appVersionFor(
  settings: DocumentStore<Settings>,
  tenant: string,
  app: string,
): Promise<Outcome<string, "not_found" | "invalid">> {
  const revs = await settings.list({ id: tenant });
  const rev = revs.filter((s) => s.state === "approved").at(-1)?.rev;
  if (rev === undefined) return fail("not_found", `settings ${tenant} have no approved revision`);
  const got = await settings.get(tenant, rev);
  if (!got.ok) return fail("invalid", `settings ${tenant} ${rev}: ${got.detail ?? got.failure}`);
  const found = got.value.doc.apps[app];
  if (found === undefined) return fail("not_found", `settings name no app ${app}`);
  return ok(found.app_version);
}

/** The recorder's `context` input: the app's version and the fixed discovery viewport. */
async function recorderContext(
  deps: CandidateDeps,
  tenant: string,
  spec: RunSpec,
): Promise<Outcome<RunContext, "not_found" | "invalid">> {
  const version = await appVersionFor(deps.settings, tenant, spec.app);
  if (!version.ok) return version;
  // Why scale 1: the surface port's viewport carries no pixel density (M02); every discovery
  // run uses the browser's default.
  return ok({ tenant, appVersion: version.value, viewport: { ...DISCOVERY_VIEWPORT, scale: 1 } });
}

/**
 * Rebuilds a candidate's three files from its linked runs and every decision so far (section 6
 * §14.1: the recorder is a pure function of its inputs, re-run after every decision).
 */
export async function regenerateCandidate(
  deps: CandidateDeps,
  id: string,
  runs: CandidateRuns,
): Promise<Outcome<RecorderOutput, "not_found" | "invalid" | "write_failed">> {
  const decisions = await deps.candidates.decisions(id);
  if (!decisions.ok) return decisions;
  const positive = await loadOneRun(deps, runs.positive, "done");
  if (!positive.ok) return positive;
  const negatives: RunLines[] = [];
  for (const ref of runs.negatives) {
    const neg = await loadOneRun(deps, ref, "report_outcome");
    if (!neg.ok) return neg;
    negatives.push(neg.value);
  }
  const context = await recorderContext(deps, runs.positive.tenant, positive.value.spec);
  if (!context.ok) return context;
  const output = record({
    positive: positive.value,
    negatives,
    decisions: decisions.value,
    context: context.value,
  });
  const wroteRuns = await deps.candidates.putFile(id, "runs.json", runs);
  if (!wroteRuns.ok) return wroteRuns;
  const wroteCandidate = await deps.candidates.putFile(id, "candidate.json", output.candidate);
  if (!wroteCandidate.ok) return wroteCandidate;
  const issuesFile: CandidateIssues = {
    schema: "intyy.candidate_issues/1.0",
    issues: [...output.issues],
  };
  const wroteIssues = await deps.candidates.putFile(id, "issues.json", issuesFile);
  if (!wroteIssues.ok) return wroteIssues;
  return ok(output);
}

/** Records a just-finished positive discovery run as a brand new candidate. Shared by `candidate
 * new` and `discover`'s end-of-run step. */
export async function recordPositiveRun(
  deps: CandidateDeps,
  tenant: string,
  runId: string,
): Promise<Outcome<{ id: string; output: RecorderOutput }, "not_found" | "invalid" | "write_failed">> {
  const summary = await readRunSummary(deps.evidence, tenant, runId);
  if (!summary.ok) return summary;
  const [app, capability] = summary.value.capability.split("/");
  if (app === undefined || capability === undefined) {
    return fail("invalid", `run ${runId}: run.json names no capability`);
  }
  const id = `${app}/${capability}/${deps.ids.candidateId()}`;
  const runs: CandidateRuns = {
    schema: "intyy.candidate_runs/1.0",
    positive: { run_id: runId, tenant },
    negatives: [],
  };
  const output = await regenerateCandidate(deps, id, runs);
  if (!output.ok) return output;
  return ok({ id, output: output.value });
}

/** Attaches a just-finished negative discovery run to an existing candidate (section 6 §14.8).
 * Shared by `discover --candidate` and, later, `candidate adopt`. */
export async function attachNegativeRun(
  deps: CandidateDeps,
  id: string,
  tenant: string,
  runId: string,
): Promise<Outcome<RecorderOutput, "not_found" | "invalid" | "write_failed">> {
  const got = await deps.candidates.getFile(id, "runs.json");
  if (!got.ok) return got;
  const updated: CandidateRuns = {
    ...got.value,
    negatives: [...got.value.negatives, { run_id: runId, tenant }],
  };
  return regenerateCandidate(deps, id, updated);
}

/**
 * Maps a currently shown (possibly renamed) step/target/condition ID back to the ID the
 * recorder first generated (docs/decisions.md, M04): `risk`, `risk_second_look`, and an `edit`
 * on `steps`/`targets`/`conditions` are all applied earlier in the recorder's pipeline than a
 * rename (section 6 §15), so they must always name the original ID, never a later rename's.
 */
export function originalId(
  decisions: readonly CandidateDecision[],
  kind: "steps" | "targets" | "conditions",
  shown: string,
): string {
  const renameTo = new Map<string, string>();
  for (const d of decisions) {
    if (d.what !== "edit") continue;
    const parts = d.subject.split(".");
    if (parts.length === 3 && parts[0] === kind && parts[2] === "id") {
      renameTo.set(d.value, parts[1] ?? "");
    }
  }
  let current = shown;
  const seen = new Set<string>();
  while (renameTo.has(current) && !seen.has(current)) {
    seen.add(current);
    current = renameTo.get(current) ?? current;
  }
  return current;
}

/** Every step/target/condition ID this candidate has ever had, current or renamed away. */
export function knownIds(
  kind: "steps" | "targets" | "conditions",
  artifact: Artifact,
  decisions: readonly CandidateDecision[],
): Set<string> {
  const ids = new Set((artifact[kind] as readonly { id: string }[]).map((x) => x.id));
  for (const d of decisions) {
    if (d.what !== "edit") continue;
    const parts = d.subject.split(".");
    if (parts.length === 3 && parts[0] === kind && parts[2] === "id") ids.add(parts[1] ?? "");
  }
  return ids;
}

/** Fields an `edit` decision may change on `about` (section 6 §15). */
const ABOUT_FIELDS = new Set(["title", "summary", "when_to_use", "limits"]);

/**
 * Checks that `subject` names a real part of `artifact` for `what`, and maps a step/target/
 * condition subject back to its original ID first. `null` means the caller should refuse: an
 * unknown decision subject.
 */
export function resolveSubject(
  artifact: Artifact,
  decisions: readonly CandidateDecision[],
  what: CandidateDecisionWhat,
  subject: string,
): string | null {
  if (what === "risk" || what === "risk_second_look") {
    const mapped = originalId(decisions, "steps", subject);
    return knownIds("steps", artifact, decisions).has(mapped) ? mapped : null;
  }
  if (what === "tag") {
    const [runId, seqText] = subject.split("#");
    const seq = Number(seqText);
    const known = artifact.provenance.actions.some((a) => a.run_id === runId && a.seq === seq);
    return known ? subject : null;
  }
  if (what === "sensitivity") {
    const known =
      artifact.contract.inputs.some((i) => i.name === subject) ||
      artifact.contract.outputs.some((o) => o.name === subject);
    return known ? subject : null;
  }
  if (what === "outcome_name" || what === "refusal") {
    return artifact.contract.outcomes.some((o) => o.code === subject) ? subject : null;
  }
  if (what === "waiver" || what === "recovery") {
    return subject === "recovery.reconciliation" ? subject : null;
  }
  // what === "edit"
  const parts = subject.split(".");
  if (parts.length === 2 && parts[0] === "about") {
    return ABOUT_FIELDS.has(parts[1] ?? "") ? subject : null;
  }
  // Section 2 §10: "A human confirms paths at review." One fixed subject, no ID to map.
  if (parts.length === 2 && parts[0] === "runs_on" && parts[1] === "paths") {
    return subject;
  }
  // A whole condition body, section 6 §15 ("edit covers ... conditions"): `conditions.<id>`,
  // with no third part, unlike the `.id`/`.description` field edits below.
  if (parts.length === 2 && parts[0] === "conditions") {
    const mapped = originalId(decisions, "conditions", parts[1] ?? "");
    return knownIds("conditions", artifact, decisions).has(mapped) ? `conditions.${mapped}` : null;
  }
  if (parts.length === 3 && (parts[0] === "steps" || parts[0] === "targets" || parts[0] === "conditions")) {
    const kind = parts[0];
    const mapped = originalId(decisions, kind, parts[1] ?? "");
    return knownIds(kind, artifact, decisions).has(mapped) ? `${kind}.${mapped}.${parts[2] ?? ""}` : null;
  }
  return null;
}
