// `intyy candidate new | list | show | issues | decide | review`: recording one discovery run
// as an artifact candidate, and reviewing it. Follows design section 9 §8.1, §8.2 (commands),
// §6.2 (folder layout), section 6 §14 (recorder inputs) and §15 (what each decision records).
// This file owns argument parsing, role checks, prompting, and printing only; the product
// logic (rebuilding a candidate, resolving a decision's subject) lives in
// `src/core/recorder/candidates.ts`, which every failure here reports as an `Outcome`.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Command } from "commander";
import { AppId } from "../../core/model/common.js";
import type { Artifact } from "../../core/model/artifact.js";
import type { ArtifactCheckContext } from "../../core/model/artifact-checks.js";
import { CandidateDecision, CandidateDecisionWhat } from "../../core/model/candidate-decision.js";
import type { CandidateIssue } from "../../core/model/candidate-issues.js";
import { CandidateId, RunId } from "../../core/model/ids.js";
import type { HandlerDraft } from "../../core/model/handler-draft.js";
import { CapabilityName } from "../../core/model/runspec.js";
import {
  attachNegativeRun,
  recordPositiveRun,
  regenerateCandidate,
  resolveSubject,
  type CandidateDeps,
} from "../../core/recorder/candidates.js";
import type { RecorderOutput } from "../../core/recorder/record.js";
import { secondLook, sealCandidate, type SealedFixture } from "../../core/recorder/seal.js";
import { requireRole, type Ctx } from "../context.js";
import { CliExit, EXIT } from "../exit-codes.js";
import { answer, progress, type Answer } from "../output.js";
import { act, type Register } from "../program.js";
import { orExit } from "./documents.js";
import { effectivePolicy } from "./policy.js";
import { specLookup } from "./spec.js";

/** A candidate's store ID, split into its parts: `<app>/<capability>/<candidate_id>`. */
type CandidateRef = { app: string; capability: string; id: string };

/** Parses `<app>/<capability>/<candidate_id>`. */
function parseCandidateArg(arg: string | undefined): CandidateRef {
  const parts = (arg ?? "").split("/");
  const [app, capability, id] = parts;
  if (
    parts.length !== 3 ||
    app === undefined ||
    !AppId.safeParse(app).success ||
    capability === undefined ||
    !CapabilityName.safeParse(capability).success ||
    id === undefined ||
    !CandidateId.safeParse(id).success
  ) {
    throw new CliExit(EXIT.usage, `candidate ${arg ?? ""}: write <app>/<capability>/<candidate_id>`);
  }
  return { app, capability, id };
}

/** The store ID for a candidate reference. */
function docId(ref: CandidateRef): string {
  return `${ref.app}/${ref.capability}/${ref.id}`;
}

/** A run ID operand, checked. */
function runIdArg(raw: string | undefined): string {
  if (raw === undefined || !RunId.safeParse(raw).success) {
    throw new CliExit(EXIT.usage, `run ${raw ?? ""}: not a run ID`);
  }
  return raw;
}

/** A decision `<what>` operand, checked. */
function whatArg(raw: string | undefined): CandidateDecisionWhat {
  const parsed = CandidateDecisionWhat.safeParse(raw);
  if (!parsed.success) {
    throw new CliExit(
      EXIT.usage,
      `decide: ${raw ?? ""} is not one of ${CandidateDecisionWhat.options.join(", ")}`,
    );
  }
  return parsed.data;
}

/** A `--version` value, checked as a semver like `1.0.0`. */
function versionArg(opts: Record<string, unknown>): string {
  const v = opts.version;
  if (typeof v !== "string" || !/^\d+\.\d+\.\d+$/.test(v)) {
    throw new CliExit(EXIT.usage, "--version takes a semver like 1.0.0");
  }
  return v;
}

/**
 * Writes the drafted handlers and `normal` fixtures a seal returns, under the library paths
 * section 9 §6.2 names (owner decision, docs/decisions.md, M04: written at seal). A fixture's
 * `a11y.yaml`, `dom.html`, and `screen.png` are the run's own saved bytes for that turn, copied
 * byte for byte (section 5 §13.1); a file the run never saved (such as a withheld screenshot)
 * is left out and named in `meta.json`'s `missing`, never invented.
 */
function writeDraftsAndFixtures(
  ctx: Ctx,
  app: string,
  drafts: readonly HandlerDraft[],
  fixtures: readonly SealedFixture[],
): void {
  for (const d of drafts) {
    const dir = join(ctx.root, ctx.config.library, "drafts", "handlers", app, d.id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "draft.json"), `${JSON.stringify(d, null, 2)}\n`);
  }
  for (const { fixture, bytes, missing } of fixtures) {
    const dir = join(ctx.root, ctx.config.library, "fixtures", app, fixture.id);
    mkdirSync(dir, { recursive: true });
    for (const [name, content] of Object.entries(bytes)) writeFileSync(join(dir, name), content);
    const meta = {
      schema: "intyy.fixture/1.0",
      id: fixture.id,
      app,
      location: fixture.location,
      kind: "normal",
      missing,
    };
    writeFileSync(join(dir, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`);
  }
}

/** The merged global+app policy's checks a strict artifact load needs (section 2 §19.6). */
async function sealCheckContext(ctx: Ctx, app: string): Promise<ArtifactCheckContext> {
  const policy = await effectivePolicy(ctx, app);
  return {
    pathAllowed: (pattern) => policy.effective.paths.allow.includes(pattern),
    secretDeclared: (name) => name in policy.effective.secrets,
  };
}

/** The ports `src/core/recorder/candidates.ts` needs, from this command's context. */
export function candidateDeps(ctx: Ctx): CandidateDeps {
  return {
    candidates: ctx.wiring.candidates,
    evidence: ctx.wiring.evidence,
    settings: ctx.wiring.settings,
    ids: ctx.wiring.ids,
    clock: ctx.wiring.clock,
    specs: specLookup(ctx),
  };
}

/** One line's worth of an answer: the candidate ID, plus how many issues are left. */
export function candidateAnswer(
  id: string,
  issues: readonly { level: "blocking" | "warning" }[],
): Answer {
  const blocking = issues.filter((i) => i.level === "blocking").length;
  const warnings = issues.length - blocking;
  return answer(
    { candidate: id, blocking, warnings },
    `${id}\n${String(blocking)} blocking issue(s), ${String(warnings)} warning(s). ` +
      `Review with: intyy candidate issues ${id}`,
  );
}

/** Records a just-finished positive run as a candidate; ends the command on trouble. */
export async function recordPositiveRunOrExit(
  ctx: Ctx,
  runId: string,
): Promise<{ id: string; output: RecorderOutput }> {
  return orExit(await recordPositiveRun(candidateDeps(ctx), ctx.tenant, runId), `run ${runId}`);
}

/** Attaches a just-finished negative run to a candidate; ends the command on trouble. */
export async function attachNegativeRunOrExit(
  ctx: Ctx,
  id: string,
  runId: string,
): Promise<RecorderOutput> {
  return orExit(await attachNegativeRun(candidateDeps(ctx), id, ctx.tenant, runId), id);
}

/** One line of `candidate show`. */
function showLines(id: string, artifact: Artifact, issues: readonly CandidateIssue[]): string[] {
  const blocking = issues.filter((i) => i.level === "blocking").length;
  return [
    `${id}  ${artifact.contract.effect}`,
    "steps:",
    ...artifact.steps.map((s) => `  ${s.id}  ${s.action.type}  risk:${s.risk}`),
    "targets:",
    ...artifact.targets.map((t) => `  ${t.id}  ${t.description}`),
    "outcomes:",
    ...artifact.contract.outcomes.map((o) => `  ${o.code}  ${o.description}`),
    `issues: ${String(issues.length)} (${String(blocking)} blocking)`,
  ];
}

/** One line of `candidate issues`. */
function issueLine(i: CandidateIssue): string {
  return `${i.level}  ${i.code}  ${i.subject ?? "-"}  ${i.message}`;
}

/** What to ask, and what decision it becomes, for one blocking issue the guided walk can act
 * on. `null` means this issue is not decided by a review answer (docs/decisions.md, M04: for
 * example, `null_version` and `null_sealed` clear only at sealing). */
async function askForIssue(
  ctx: Ctx,
  artifact: Artifact,
  issue: CandidateIssue,
): Promise<{ what: CandidateDecisionWhat; subject: string; value: string } | null> {
  const ask = (q: string): Promise<string> => ctx.io.stdin.question(q);
  switch (issue.code) {
    case "risk_undecided":
    case "risk_second_look": {
      const stepId = issue.subject ?? "";
      const step = artifact.steps.find((s) => s.id === stepId);
      const current = step?.risk ?? "irreversible";
      progress(ctx.io, issue.message);
      const raw = await ask(
        `Risk for ${stepId} [idempotent/reversible/irreversible] (blank keeps ${current}): `,
      );
      return { what: "risk", subject: stepId, value: raw.trim() === "" ? current : raw.trim() };
    }
    case "undecided_tag": {
      const m = /^provenance\.actions\[(\d+)\]$/.exec(issue.subject ?? "");
      const idx = m?.[1] === undefined ? -1 : Number(m[1]);
      const a = artifact.provenance.actions[idx];
      if (a === undefined) return null;
      progress(ctx.io, `Action ${a.run_id}#${String(a.seq)} was tagged ${a.llm_tag} by the model.`);
      const raw = await ask(
        `Confirm tag [flow_step/incidental/correction/exploration] (blank keeps ${a.llm_tag}): `,
      );
      return {
        what: "tag",
        subject: `${a.run_id}#${String(a.seq)}`,
        value: raw.trim() === "" ? a.llm_tag : raw.trim(),
      };
    }
    case "empty_about": {
      const field = (issue.subject ?? "").split(".")[1] ?? "";
      const value = await ask(`${field}: `);
      return value.trim() === "" ? null : { what: "edit", subject: issue.subject ?? "", value: value.trim() };
    }
    case "missing_refusal": {
      const outcome = /outcome (\S+)/.exec(issue.message)?.[1];
      if (outcome === undefined) return null;
      const value = await ask(`Refuse outcome ${outcome} on the commit step? [refuse/allow]: `);
      return { what: "refusal", subject: outcome, value: value.trim() === "" ? "allow" : value.trim() };
    }
    case "missing_reconciliation": {
      const value = await ask(
        'Recovery: paste a waiver {"reason":"..."}, or a check {"capability":...,"inputs":{...}}: ',
      );
      if (value.trim() === "") return null;
      return { what: value.includes('"reason"') ? "waiver" : "recovery", subject: "recovery.reconciliation", value: value.trim() };
    }
    default:
      progress(ctx.io, `(${issue.code} is not answered by review; see: intyy candidate decide)`);
      return null;
  }
}

/** Registers the candidate commands. */
export const registerCandidate: Register = (program: Command, ctxOf) => {
  const candidate = program.command("candidate").description("record and review discovery runs");

  candidate
    .command("new")
    .argument("<run_id>", "a finished positive discovery run")
    .description("record a finished run as a candidate (operator); prints its ID")
    .action(
      act(ctxOf, async (ctx, args) => {
        requireRole(ctx, ctx.tenant, "operator");
        const { id, output } = await recordPositiveRunOrExit(ctx, runIdArg(args[0]));
        return candidateAnswer(id, output.issues);
      }),
    );

  candidate
    .command("list")
    .description("candidate IDs")
    .action(
      act(ctxOf, async (ctx) => {
        const ids = await ctx.wiring.candidates.list();
        return answer({ candidates: ids }, ids.length === 0 ? "No candidates." : ids.join("\n"));
      }),
    );

  candidate
    .command("show")
    .argument("<id>", "app/capability/candidate_id")
    .description("steps, targets, outcomes, and the issue count")
    .action(
      act(ctxOf, async (ctx, args) => {
        const id = docId(parseCandidateArg(args[0]));
        const artifact = orExit(await ctx.wiring.candidates.getFile(id, "candidate.json"), id);
        const issuesFile = orExit(await ctx.wiring.candidates.getFile(id, "issues.json"), id);
        return answer(
          { candidate: id, artifact, issues: issuesFile.issues },
          showLines(id, artifact, issuesFile.issues).join("\n"),
        );
      }),
    );

  candidate
    .command("issues")
    .argument("<id>", "app/capability/candidate_id")
    .description("blocking issues first, then warnings")
    .action(
      act(ctxOf, async (ctx, args) => {
        const id = docId(parseCandidateArg(args[0]));
        const issuesFile = orExit(await ctx.wiring.candidates.getFile(id, "issues.json"), id);
        const lines = issuesFile.issues.length === 0 ? ["No issues."] : issuesFile.issues.map(issueLine);
        return answer({ candidate: id, issues: issuesFile.issues }, lines.join("\n"));
      }),
    );

  candidate
    .command("decide")
    .argument("<id>", "app/capability/candidate_id")
    .argument("<what>", "tag, risk, sensitivity, outcome_name, refusal, waiver, recovery, or edit")
    .argument("<subject>", "what the decision is about")
    .argument("<value>", "the decision's value")
    .description(
      "record one review decision (reviewer); a piped standard input becomes its note; " +
        "regenerates the candidate and prints its issues",
    )
    .action(
      act(ctxOf, async (ctx, args) => {
        const id = docId(parseCandidateArg(args[0]));
        const what = whatArg(args[1]);
        const rawSubject = args[2] ?? "";
        const value = args[3] ?? "";
        const staff = requireRole(ctx, ctx.tenant, "reviewer");
        const artifact = orExit(await ctx.wiring.candidates.getFile(id, "candidate.json"), id);
        const decisions = orExit(await ctx.wiring.candidates.decisions(id), id);
        const subject = resolveSubject(artifact, decisions, what, rawSubject);
        if (subject === null) {
          throw new CliExit(EXIT.usage, `${id}: ${rawSubject} is not a known ${what} subject`);
        }
        const note = ctx.io.stdin.isTTY === true ? "" : (await ctx.io.stdin.readAll()).trim();
        const decision: CandidateDecision = {
          schema: "intyy.candidate_decision/1.0",
          what,
          subject,
          value,
          by: staff,
          at: ctx.wiring.clock.now().toISOString(),
          ...(note === "" ? {} : { note }),
        };
        orExit(await ctx.wiring.candidates.appendDecision(id, decision), id);
        const runs = orExit(await ctx.wiring.candidates.getFile(id, "runs.json"), id);
        const output = orExit(await regenerateCandidate(candidateDeps(ctx), id, runs), id);
        return candidateAnswer(id, output.issues);
      }),
    );

  candidate
    .command("review")
    .argument("<id>", "app/capability/candidate_id")
    .description("the guided review walk (reviewer, on a terminal)")
    .action(
      act(ctxOf, async (ctx, args) => {
        const id = docId(parseCandidateArg(args[0]));
        const staff = requireRole(ctx, ctx.tenant, "reviewer");
        if (ctx.io.stdin.isTTY !== true) {
          throw new CliExit(
            EXIT.usage,
            "review needs a terminal; answer issues one at a time with: intyy candidate decide",
          );
        }
        let artifact = orExit(await ctx.wiring.candidates.getFile(id, "candidate.json"), id);
        let issuesFile = orExit(await ctx.wiring.candidates.getFile(id, "issues.json"), id);
        const runs = orExit(await ctx.wiring.candidates.getFile(id, "runs.json"), id);
        for (;;) {
          const next = issuesFile.issues.find((i) => i.level === "blocking");
          if (next === undefined) break;
          const decided = await askForIssue(ctx, artifact, next);
          if (decided === null) {
            issuesFile = { ...issuesFile, issues: issuesFile.issues.filter((i) => i !== next) };
            continue;
          }
          const decision: CandidateDecision = {
            schema: "intyy.candidate_decision/1.0",
            what: decided.what,
            subject: decided.subject,
            value: decided.value,
            by: staff,
            at: ctx.wiring.clock.now().toISOString(),
          };
          orExit(await ctx.wiring.candidates.appendDecision(id, decision), id);
          const output = orExit(await regenerateCandidate(candidateDeps(ctx), id, runs), id);
          artifact = output.candidate;
          issuesFile = { schema: "intyy.candidate_issues/1.0", issues: [...output.issues] };
        }
        for (const w of issuesFile.issues.filter((i) => i.level === "warning")) {
          progress(ctx.io, `warning: ${w.message}`);
        }
        return candidateAnswer(id, issuesFile.issues);
      }),
    );

  candidate
    .command("second-look")
    .argument("<id>", "app/capability/candidate_id")
    .argument("<subject>", "the step whose lowered risk to review")
    .option("--agree", "confirm the lowering")
    .option("--disagree", "raise the step back to irreversible")
    .description(
      "another reviewer's answer to a lowered risk flag (reviewer, never its own decider); " +
        "a piped standard input becomes its note",
    )
    .action(
      act(ctxOf, async (ctx, args, opts) => {
        const id = docId(parseCandidateArg(args[0]));
        const subject = args[1] ?? "";
        const staff = requireRole(ctx, ctx.tenant, "reviewer");
        const agree = opts.agree === true;
        const disagree = opts.disagree === true;
        if (agree === disagree) {
          throw new CliExit(EXIT.usage, "second-look: pass exactly one of --agree or --disagree");
        }
        const note = ctx.io.stdin.isTTY === true ? "" : (await ctx.io.stdin.readAll()).trim();
        const output = orExit(
          await secondLook(candidateDeps(ctx), id, subject, staff, agree, note === "" ? undefined : note),
          id,
        );
        return candidateAnswer(id, output.issues);
      }),
    );

  candidate
    .command("seal")
    .argument("<id>", "app/capability/candidate_id")
    .requiredOption("--version <semver>", "the version to seal, like 1.0.0")
    .description("seal a candidate as one artifact version (reviewer); prints the next command")
    .action(
      act(ctxOf, async (ctx, args, opts) => {
        const ref = parseCandidateArg(args[0]);
        const id = docId(ref);
        const staff = requireRole(ctx, ctx.tenant, "reviewer");
        const version = versionArg(opts);
        const context = await sealCheckContext(ctx, ref.app);
        const result = orExit(await sealCandidate(candidateDeps(ctx), id, version, staff, context), id);
        writeDraftsAndFixtures(ctx, ref.app, result.drafts, result.normalFixtures);
        return answer(
          { key: result.key, hash: result.hash },
          `${result.key} sealed by ${staff}.\nhash ${result.hash}\nNext: intyy certify ${result.key}`,
        );
      }),
    );
};
