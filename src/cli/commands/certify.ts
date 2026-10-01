// `intyy certify case <key> --class … --profile … [--at …]`, `certify rerun`, `certify report`:
// thin certify's one-case batches. Follows design section 9 §9.1; section 8 §7.1, §7.4 to §7.8;
// the updates file §11.1 (`--profile` also accepts a suite `extra` case ID).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Command } from "commander";
import { BatchPlan } from "../../core/model/batch-plan.js";
import { BatchReport } from "../../core/model/batch-report.js";
import { faultsKind, suiteKind, testdataKind } from "../../core/model/kinds.js";
import type { Faults } from "../../core/model/faults.js";
import { issueText } from "../../core/model/sealing.js";
import type { Suite } from "../../core/model/suite.js";
import type { Testdata } from "../../core/model/testdata.js";
import { declareInstance } from "../../core/certify/instance.js";
import { BASELINE_REPEATS, runCertifyFull, type SetupSpec } from "../../core/certify/full.js";
import { isDrill, matrixProfiles, runCertifyQuick } from "../../core/certify/quick.js";
import { runCertifyCase, type CertifySelection } from "../../core/certify/runner.js";
import type { FrozenSet } from "../../core/packs/merge.js";
import type { BatchScores, Under } from "../../core/model/score.js";
import { appendHistory, batchLine } from "../../core/trust/scores.js";
import type { LockHold } from "../../ports/locks.js";
import { requireRole, requireStaff, takeLock, type Ctx } from "../context.js";
import { instanceKey } from "./discover.js";
import { load, type DocTarget } from "./documents.js";
import { CliExit, EXIT } from "../exit-codes.js";
import { answer, progress, type Answer } from "../output.js";
import { act, readVersion, type Register } from "../program.js";
import { loadFrozenSetFor } from "./pack.js";
import { effectivePolicy } from "./policy.js";
import { replayModels } from "./replay.js";
import { settingsTarget } from "./settings.js";

/**
 * Parses `<app>/<capability>@<major>` (the newest sealed version of that major, a documented
 * convenience) or `<app>/<capability>@<major>.<minor>.<patch>` (the exact sealed key under
 * test, section 3 §4.9's `pin`). The suite is looked up by major either way.
 */
function parseKey(text: string | undefined): {
  app: string;
  capability: string;
  major: number;
  version: string | undefined;
} {
  const m = /^([a-z][a-z0-9_-]*)\/([a-z][a-z0-9_]*)@(([1-9]\d*)(?:\.\d+\.\d+)?)$/.exec(text ?? "");
  if (m?.[1] === undefined || m[2] === undefined || m[3] === undefined || m[4] === undefined) {
    throw new CliExit(EXIT.usage, "name a capability, like kvfcu/open_share_subaccount@1 or @1.0.0");
  }
  return { app: m[1], capability: m[2], major: Number(m[4]), version: m[3].includes(".") ? m[3] : undefined };
}

/** The approved suite, test data, and faults a certify batch needs (section 9 §9.1 check 3). */
async function loadCertifyInputs(
  ctx: Ctx,
  app: string,
  capability: string,
  major: number,
): Promise<{ suite: Suite; testdata: Testdata; faults: Faults }> {
  const suiteId = `${app}/${capability}@${String(major)}`;
  const suiteTarget: DocTarget<Suite> = {
    store: ctx.wiring.suites,
    kind: suiteKind,
    id: suiteId,
    label: `suite ${suiteId}`,
    scope: "*",
  };
  const suite = await load(suiteTarget, ["approved"]);
  if (!suite) throw new CliExit(EXIT.usage, `${suiteTarget.label} has no approved revision`);

  const testdataId = `${ctx.tenant}/${app}`;
  const testdataTarget: DocTarget<Testdata> = {
    store: ctx.wiring.testdata,
    kind: testdataKind,
    id: testdataId,
    label: `testdata ${testdataId}`,
    scope: ctx.tenant,
  };
  const testdata = await load(testdataTarget, ["approved"]);
  if (!testdata) throw new CliExit(EXIT.usage, `${testdataTarget.label} has no approved revision`);

  const faultsTarget: DocTarget<Faults> = {
    store: ctx.wiring.faults,
    kind: faultsKind,
    id: app,
    label: `faults ${app}`,
    scope: "*",
  };
  const faults = await load(faultsTarget, ["approved"]);
  if (!faults) throw new CliExit(EXIT.usage, `${faultsTarget.label} has no approved revision`);

  return { suite: suite.doc, testdata: testdata.doc, faults: faults.doc };
}

/** `--profile` names a standard fault profile, else a suite `extra` case (updates file §11.1). */
function resolveSelection(profileArg: string, suite: Suite, faults: Faults): CertifySelection {
  const profile = faults.profiles.find((p) => p.id === profileArg);
  if (profile !== undefined) return { kind: "profile", profile };
  const extra = suite.extra.find((e) => e.id === profileArg);
  if (extra !== undefined) return { kind: "extra", extra };
  throw new CliExit(EXIT.usage, `--profile ${profileArg} names no standard profile and no extra case`);
}

/** The batch folder: `state/evidence/<tenant>/batches/<batch_id>/` (section 8 §7.8). */
function batchDir(ctx: Ctx, batchId: string): string {
  return join(ctx.root, ctx.config.state, "evidence", ctx.tenant, "batches", batchId);
}

/** Writes `plan.json` and `report.json` under the batch folder (section 8 §7.8). */
function writeBatchFiles(ctx: Ctx, plan: BatchPlan, report: BatchReport): void {
  const dir = batchDir(ctx, plan.batch_id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "plan.json"), `${JSON.stringify(plan, null, 2)}\n`);
  writeFileSync(join(dir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
}

/** Writes `plan.json` and `report.json`, and prints the same summary `certify case`,
 * `certify rerun`, and `certify report` all use. */
function writeAndAnswer(ctx: Ctx, plan: BatchPlan, report: BatchReport): Answer {
  const dir = batchDir(ctx, plan.batch_id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "plan.json"), `${JSON.stringify(plan, null, 2)}\n`);
  writeFileSync(join(dir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  const c = report.cases[0];
  const lines = [
    `batch ${plan.batch_id} (quick)`,
    `case ${c?.case_id ?? ""}: ${c?.result.status ?? ""}${c?.result.detail !== null && c?.result.detail !== undefined ? ` ${c.result.detail}` : ""}`,
    `verdict: ${c?.verdict ?? ""}`,
    `gate: ${report.gate.passed ? "passed" : "failed"}`,
  ];
  return answer(
    { batch_id: plan.batch_id, plan, report },
    lines.join("\n"),
    report.gate.passed ? EXIT.ok : EXIT.failed,
  );
}

/** What every `certify case`/`rerun` call needs from `ctx.wiring`, assembled once: the ports
 * `runCertifyCase` uses, and the same merged, approved handler set a production replay of this
 * app and app version would load (section 5 §7.4; a production `replay` loads it too, in
 * `cli/commands/replay.ts`). */
async function buildDeps(
  ctx: Ctx,
  app: string,
): Promise<{ deps: Parameters<typeof runCertifyCase>[1]; origin: string; appVersion: string; frozenSet: FrozenSet }> {
  const settings = await load(settingsTarget(ctx), ["approved"]);
  if (!settings) throw new CliExit(EXIT.invalid, `settings ${ctx.tenant} have no approved revision`);
  const appSettings = settings.doc.apps[app];
  if (appSettings === undefined) throw new CliExit(EXIT.usage, `${app} has no settings for tenant ${ctx.tenant}`);
  const sealed = await ctx.wiring.settings.get(settingsTarget(ctx).id, settings.rev);
  if (!sealed.ok) throw new CliExit(EXIT.invalid, `settings ${ctx.tenant}: ${sealed.detail ?? sealed.failure}`);
  const policy = await effectivePolicy(ctx, app);
  const keys = (settings.doc.system_secrets?.request_index_keys ?? []).map((k) => ({
    keyId: k.key_id,
    status: k.status,
    binding: { source: k.source, key: k.key },
  }));
  const deps = {
    evidence: ctx.wiring.evidence,
    clock: ctx.wiring.clock,
    ids: ctx.wiring.ids,
    secrets: ctx.wiring.secrets,
    surface: ctx.wiring.discovery.surface(),
    artifacts: ctx.wiring.candidates,
    requestIndex: { store: ctx.wiring.requestIndexStore, clock: ctx.wiring.clock, secrets: ctx.wiring.secrets, keys },
    harness: ctx.wiring.harness({ origin: appSettings.origin, environment: appSettings.environment }),
    policy,
    settings: { doc: settings.doc, rev: settings.rev, hash: sealed.value.hash },
    engineVersion: readVersion(),
    mailboxOperator: ctx.wiring.discovery.operator,
    // Why: section 8 §7.1. A batch tests the ladder a live run would use, so it gets the models a
    // live replay gets: the reviewer only when the policy switch and the key allow, never a fake jev.
    models: replayModels(ctx, policy.effective.llm.replay_reviewer),
  } satisfies Parameters<typeof runCertifyCase>[1];
  const frozenSet = await loadFrozenSetFor(ctx, ctx.tenant, app, appSettings.app_version);
  return { deps, origin: appSettings.origin, appVersion: appSettings.app_version, frozenSet };
}

/**
 * Writes the batch's `batch` history line and rebuilds the key's record (section 8 §5.4, §5.6).
 * Every certify path calls it. A failed score write never changes the batch's result (section 8
 * §5.6): it prints a warning, and `intyy trust rebuild` repairs the record later.
 */
async function recordBatch(
  ctx: Ctx,
  kind: "quick" | "full" | "regression",
  plan: BatchPlan,
  report: BatchReport,
  facts: {
    appVersion: string;
    engine: string;
    frozenSet: FrozenSet;
    /** A full batch's own `under` facts and scores; a quick batch has neither (section 8 §5.4). */
    under?: Under;
    scores?: BatchScores;
    /** Run IDs of cases that did not pass, for a `degraded` line when a full batch fails its gate. */
    failing?: readonly string[];
  },
): Promise<void> {
  const line = batchLine({
    at: ctx.wiring.clock.now(),
    by: "certify",
    reason: `${kind} batch ${report.gate.passed ? "passed" : "failed"} its gate`,
    batch: plan.batch_id,
    kind,
    gatePassed: report.gate.passed,
    drill: report.drill === true || report.models_off === true,
    report,
    under: facts.under ?? {
      engine: facts.engine,
      handler_set: facts.frozenSet.runStart.hash,
      jev: null,
      session: null,
      check: null,
    },
    ...(facts.scores === undefined ? {} : { scores: facts.scores }),
  });
  const deps = { scores: ctx.wiring.scores, locks: ctx.wiring.locks, artifacts: ctx.wiring.candidates };
  const key = { capability: plan.pin, tenant: ctx.tenant, app_version: facts.appVersion, patch_revision: null };
  const who = { owner: plan.batch_id, command: "certify", staff: ctx.staff };
  const written = await appendHistory(deps, key, line, who);
  // Section 8 §4.2: an approved key whose full batch fails the gate becomes `degraded`, by `certify`.
  // Why not for a drill: section 8 §7.1. A drill's evidence describes an app this tenant does not
  // run, so a drill never changes trust state.
  const drill = report.drill === true || report.models_off === true;
  if (written.ok && kind === "full" && !drill && !report.gate.passed && written.value.state === "approved") {
    const degraded = await appendHistory(
      deps,
      key,
      {
        event: "degraded",
        at: ctx.wiring.clock.now().toISOString(),
        by: "certify",
        reason: `full batch ${plan.batch_id} failed its gate`,
        rule: "certify",
        runs: [...(facts.failing ?? [])],
      },
      who,
    );
    if (!degraded.ok) progress(ctx.io, `warning: the key was not marked degraded (${degraded.failure}). Run intyy trust demote.`);
  }
  if (!written.ok) {
    progress(
      ctx.io,
      `warning: the batch result was not saved to the score store (${written.failure}${written.detail === undefined ? "" : `: ${written.detail}`}). Run intyy trust rebuild after you fix it.`,
    );
  }
}

/** Prints the `needs_at` refusal, with the request steps the baseline found. */
function refuseNeedsAt(detail: string | undefined): never {
  const steps = (detail ?? "").split(", ").filter((s) => s.length > 0);
  throw new CliExit(
    EXIT.usage,
    steps.length > 0
      ? `--profile's anchor is @each_request_step; pass --at @step:<id>, one of: ${steps.join(", ")}`
      : "--profile's anchor is @each_request_step; pass --at @step:<id>, but the baseline sent no request",
  );
}

/** The instance facts as one line, like `variant=keystone strip_semantics=false …`. */
function instanceLine(i: Testdata["instance"]): string {
  return [
    `variant=${i.variant}`,
    `strip_semantics=${String(i.strip_semantics)}`,
    `drop_labels=${String(i.drop_labels)}`,
    `label_seed=${i.label_seed}`,
    `delay_scale=${String(i.delay_scale ?? 1)}`,
  ].join(" ");
}

/** The suite's setup runs, each with its own suite's class (section 8 §6.1). */
async function loadSetups(ctx: Ctx, suite: Suite): Promise<SetupSpec[]> {
  const out: SetupSpec[] = [];
  for (const s of suite.setup) {
    const m = /^([a-z][a-z0-9_-]*)\/([a-z][a-z0-9_]*)@(\d+)$/.exec(s.capability);
    if (m?.[1] === undefined || m[2] === undefined || m[3] === undefined) {
      throw new CliExit(EXIT.invalid, `suite setup ${s.capability} does not fit app/capability@major`);
    }
    const own = await loadCertifyInputs(ctx, m[1], m[2], Number(m[3]));
    const cls = own.suite.classes.find((c) => c.id === s.class);
    if (cls === undefined) throw new CliExit(EXIT.invalid, `suite setup ${s.capability} names class ${s.class}, which its suite lacks`);
    out.push({ app: m[1], capability: m[2], major: Number(m[3]), cls });
  }
  return out;
}

/** The lines `certify --kind full` prints: counts, failed rules, gaps, and the gate (section 9 §9.1). */
function fullSummary(plan: BatchPlan, report: BatchReport): string[] {
  const rules = report.gate.rules;
  const failed = rules === undefined ? [] : Object.entries(rules).filter(([, v]) => !v).map(([k]) => k);
  const v = report.verdicts;
  return [
    `batch ${plan.batch_id} (full${report.drill === true ? ", drill" : ""})`,
    `runs: ${String(report.cases.length)}`,
    ...(v === undefined ? [] : [`verdicts: ${Object.entries(v).map(([k, n]) => `${k} ${String(n)}`).join(", ")}`]),
    `outcome score: ${report.outcome_score === null || report.outcome_score === undefined ? "none" : report.outcome_score.toFixed(2)}`,
    `lowest margin: ${report.margin?.lowest === null || report.margin?.lowest === undefined ? "none" : `${report.margin.lowest.toFixed(2)} at ${report.margin.step ?? ""}`}`,
    `fragile steps: ${report.fragile === undefined || report.fragile.length === 0 ? "none" : report.fragile.join(", ")}`,
    ...(report.coverage_gaps ?? []).map((g) => `gap: ${g}`),
    ...report.cases.filter((c) => c.verdict !== "pass").map((c) => `${c.case_id}: ${c.result.status}${c.result.detail === null ? "" : ` ${c.result.detail}`}, ${c.verdict}`),
    ...(failed.length === 0 ? [] : [`failed rules: ${failed.join(", ")}`]),
    `gate: ${report.gate.passed ? "passed" : "failed"}`,
  ];
}

/** `certify <key> [--kind full|quick]`. `quick`: a baseline, then the commit-step matrix. `full`:
 * baselines, the whole matrix, extras, and drills (section 8 §7.1, §7.2; section 9 §9.1, §9.2).
 * `--plan-only` contacts nothing and writes nothing. */
async function certifyQuick(ctx: Ctx, key: string | undefined, opts: Record<string, unknown>): Promise<Answer> {
  const kind = typeof opts.kind === "string" ? opts.kind : "full";
  if (kind === "regression") {
    throw new CliExit(EXIT.usage, "--kind regression is not built yet; it arrives in M11 (pack regression batches)");
  }
  if (kind !== "quick" && kind !== "full") {
    throw new CliExit(EXIT.usage, `--kind ${kind}: use full or quick`);
  }
  const staff = requireRole(ctx, ctx.tenant, "operator");
  const { app, capability, major, version } = parseKey(key);
  const { suite, testdata, faults } = await loadCertifyInputs(ctx, app, capability, major);
  let instance = testdata.instance;
  let declaration: { by: string; differs: string[] } | undefined;
  if (typeof opts.instance === "string") {
    const declared = declareInstance(opts.instance, testdata.instance);
    if (!declared.ok) throw new CliExit(EXIT.usage, `--instance: ${declared.detail ?? declared.failure}`);
    instance = declared.value.instance;
    declaration = { by: staff, differs: declared.value.differs };
  }
  // Why: section 8 §7.1. A batch run with `--models off` did not test the ladder live runs use, so it is a drill.
  const modelsOff = ctx.flags.models === "off";
  const drill = isDrill(declaration) || modelsOff;
  const { deps, origin, appVersion, frozenSet } = await buildDeps(ctx, app);
  if (deps.settings.doc.apps[app]?.environment !== "test") {
    throw new CliExit(EXIT.invalid, "certify: environment_not_test");
  }
  const className = suite.matrix.class;

  if (opts.planOnly === true) {
    // Why: section 9 §9.1, "stops here with --plan-only". The route map needs a baseline run, so
    // the plan here holds no routes and no run IDs, and no file is written.
    const runs = matrixProfiles(faults.profiles, null).length;
    if (kind === "full") {
      const baselines = suite.classes.length * BASELINE_REPEATS + 1;
      const profiles = suite.matrix.profiles === "standard" ? faults.profiles.length : suite.matrix.profiles.length;
      const lines = [
        `plan for ${app}/${capability}@${String(major)} (full, plan only)`,
        `class: ${className}`,
        `baseline: ${String(suite.classes.length)} classes x ${String(BASELINE_REPEATS)} repeats + 1 twin = ${String(baselines)} runs`,
        `matrix: ${String(profiles)} profiles on every request step and the commit step; the count is known after the baseline`,
        `extra: ${String(suite.extra.length)} cases`,
        `drills: ${String(suite.drills.count)}`,
        `stability: ${String(suite.stability.levels.length)} levels x ${String(suite.stability.seeds)} seeds${suite.stability.twins ? " x 2 twins" : ""} = ${String(suite.stability.levels.length * suite.stability.seeds * (suite.stability.twins ? 2 : 1))} runs`,
        `setup runs: ${String(suite.setup.length)} before each case`,
        `instance: ${instanceLine(instance)}`,
        declaration === undefined
          ? "declared: no, the test data set's instance is used"
          : `declared by ${declaration.by}; differs: ${declaration.differs.join(", ") || "nothing"}`,
        `drill: ${drill ? "yes, never approval-grade" : "no"}`,
      ];
      return answer(
        { plan_only: true, kind, class: className, baselines, profiles, extra: suite.extra.length, drills: suite.drills.count, instance, declaration: declaration ?? null, drill },
        lines.join("\n"),
      );
    }
    const lines = [
      `plan for ${app}/${capability}@${String(major)} (quick, plan only)`,
      `class: ${className}`,
      `cases: 1 baseline + ${String(runs)} commit-step cases = ${String(runs + 1)} runs`,
      `instance: ${instanceLine(instance)}`,
      declaration === undefined
        ? "declared: no, the test data set's instance is used"
        : `declared by ${declaration.by}; differs: ${declaration.differs.join(", ") || "nothing"}`,
      `drill: ${drill ? "yes, never approval-grade" : "no"}`,
    ];
    return answer(
      { plan_only: true, class: className, cases: runs + 1, instance, declaration: declaration ?? null, drill },
      lines.join("\n"),
    );
  }

  const batchId = ctx.wiring.ids.batchId();
  const holds: LockHold[] = [
    await takeLock(ctx, "instance", instanceKey(origin), {
      owner: batchId,
      command: "certify",
      staff: ctx.staff,
      waitMs: 0,
    }),
  ];
  try {
    if (kind === "full") {
      const result = await runCertifyFull(
        {
          batchId,
          tenant: ctx.tenant,
          app,
          capability,
          major,
          ...(version === undefined ? {} : { version }),
          appVersion,
          staff,
          className,
          classes: suite.classes,
          pools: testdata.pools,
          instance,
          frozenSet,
          profiles: faults.profiles,
          matrixProfiles: suite.matrix.profiles,
          extra: suite.extra,
          drills: suite.drills.count,
          setup: await loadSetups(ctx, suite),
          stability: suite.stability,
          ...(faults.explained_endings === undefined ? {} : { explainedEndings: faults.explained_endings }),
          businessDate: testdata.business_date,
          modelsOff,
          ...(declaration === undefined ? {} : { declaration }),
          progress: (line) => {
            progress(ctx.io, `batch ${batchId}: ${line}`);
          },
        },
        deps,
      );
      if (!result.ok) {
        throw new CliExit(EXIT.invalid, `certify: ${result.failure}${result.detail ? `: ${result.detail}` : ""}`);
      }
      const { plan, report, scores, under, failing } = result.value;
      writeBatchFiles(ctx, plan, report);
      await recordBatch(ctx, "full", plan, report, { appVersion, engine: deps.engineVersion, frozenSet, under, scores, failing });
      return answer({ batch_id: plan.batch_id, plan, report }, fullSummary(plan, report).join("\n"), report.gate.passed ? EXIT.ok : EXIT.failed);
    }
    const result = await runCertifyQuick(
      {
        batchId,
        ...(modelsOff ? { modelsOff: true } : {}),
        tenant: ctx.tenant,
        app,
        capability,
        major,
        ...(version === undefined ? {} : { version }),
        appVersion,
        staff,
        className,
        classes: suite.classes,
        pools: testdata.pools,
        instance,
        frozenSet,
        profiles: faults.profiles,
        ...(declaration === undefined ? {} : { declaration }),
        progress: (line) => {
          progress(ctx.io, `batch ${batchId}: ${line}`);
        },
      },
      deps,
    );
    if (!result.ok) {
      throw new CliExit(EXIT.invalid, `certify: ${result.failure}${result.detail ? `: ${result.detail}` : ""}`);
    }
    const { plan, report } = result.value;
    const dir = batchDir(ctx, plan.batch_id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "plan.json"), `${JSON.stringify(plan, null, 2)}\n`);
    writeFileSync(join(dir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
    await recordBatch(ctx, "quick", plan, report, { appVersion, engine: deps.engineVersion, frozenSet });
    const lines = [
      `batch ${plan.batch_id} (quick${report.drill === true ? ", drill" : ""})`,
      ...report.cases.map((c) => `${c.case_id}: ${c.result.status}${c.result.detail === null ? "" : ` ${c.result.detail}`}, ${c.verdict}`),
      ...(report.gate.notes ?? []).map((n) => `note: ${n}`),
      `gate: ${report.gate.passed ? "passed" : "failed"}`,
    ];
    return answer({ batch_id: plan.batch_id, plan, report }, lines.join("\n"), report.gate.passed ? EXIT.ok : EXIT.failed);
  } finally {
    for (const h of holds) await ctx.wiring.locks.release(h);
  }
}

/** Registers the certify commands. */
export const registerCertify: Register = (program: Command, ctxOf) => {
  const certify = program
    .command("certify")
    .description("certify a capability: a full or quick batch, or one fault case on demand")
    .argument("[key]", "app/capability@major, for a batch")
    .option("--kind <kind>", "full (default), quick, or regression (M11)")
    .option("--instance <facts>", "declared instance facts, like strip_semantics=1,drop_labels=0.3")
    .option("--plan-only", "print the plan and stop; contact nothing")
    .action(act(ctxOf, (ctx, args, opts) => certifyQuick(ctx, args[0], opts)));

  certify
    .command("case")
    .argument("<key>", "app/capability@major")
    .option("--class <id>", "the suite class to run; defaults to the extra case's own class")
    .requiredOption("--profile <id>", "a standard fault profile ID, or a suite extra case ID")
    .option("--at <anchor>", "@step:<id>, required only for an @each_request_step profile")
    .option("--operator <who>", "scripted (default) or mailbox: a human answers the case's interventions")
    .description("a quick batch: a clean baseline, then one fault case, judged against the oracle")
    .action(
      act(ctxOf, async (ctx, args, opts) => {
        const staff = requireRole(ctx, ctx.tenant, "operator");
        const { app, capability, major, version } = parseKey(args[0]);
        const { suite, testdata, faults } = await loadCertifyInputs(ctx, app, capability, major);
        const selection = resolveSelection(String(opts.profile), suite, faults);
        const className = typeof opts.class === "string" ? opts.class : undefined;
        const resolvedClassName = className ?? (selection.kind === "extra" ? selection.extra.class : undefined);
        if (resolvedClassName === undefined) {
          throw new CliExit(EXIT.usage, "--class is required for a standard profile");
        }

        const operator = typeof opts.operator === "string" ? opts.operator : "scripted";
        if (operator !== "scripted" && operator !== "mailbox") {
          throw new CliExit(EXIT.usage, "--operator must be scripted or mailbox");
        }
        const { deps, origin, appVersion, frozenSet } = await buildDeps(ctx, app);
        const batchId = ctx.wiring.ids.batchId();
        const holds: LockHold[] = [
          await takeLock(ctx, "instance", instanceKey(origin), {
            owner: batchId,
            command: "certify",
            staff: ctx.staff,
            waitMs: 0,
          }),
        ];
        try {
          if (operator === "mailbox") {
            progress(
              ctx.io,
              `batch ${batchId}: the case run's interventions wait in the mailbox. From another terminal: intyy operator list, then claim, and decide or release.`,
            );
          }
          const result = await runCertifyCase(
            {
              batchId,
              tenant: ctx.tenant,
              app,
              capability,
              major,
              ...(version === undefined ? {} : { version }),
              appVersion,
              staff,
              operator,
              className: resolvedClassName,
              ...(ctx.flags.models === "off" ? { modelsOff: true } : {}),
              selection,
              at: typeof opts.at === "string" ? opts.at : undefined,
              classes: suite.classes,
              pools: testdata.pools,
              instance: testdata.instance,
              frozenSet,
            },
            deps,
          );
          if (!result.ok) {
            if (result.failure === "needs_at") refuseNeedsAt(result.detail);
            throw new CliExit(EXIT.invalid, `certify case: ${result.failure}${result.detail ? `: ${result.detail}` : ""}`);
          }
          const answered = writeAndAnswer(ctx, result.value.plan, result.value.report);
          await recordBatch(ctx, "quick", result.value.plan, result.value.report, {
            appVersion,
            engine: deps.engineVersion,
            frozenSet,
          });
          return answered;
        } finally {
          for (const h of holds) await ctx.wiring.locks.release(h);
        }
      }),
    );

  certify
    .command("rerun")
    .argument("<batch_id>", "the earlier batch")
    .argument("<case_id>", "the case to repeat (section 9 §9.1)")
    .description("a fresh quick batch that repeats one case with the same seed and plan entry")
    .action(
      act(ctxOf, async (ctx, args) => {
        const staff = requireRole(ctx, ctx.tenant, "operator");
        const oldBatchId = args[0] ?? "";
        const caseId = args[1] ?? "";
        const planPath = join(batchDir(ctx, oldBatchId), "plan.json");
        let raw: unknown;
        try {
          raw = JSON.parse(readFileSync(planPath, "utf8"));
        } catch {
          throw new CliExit(EXIT.usage, `${planPath}: cannot be read`);
        }
        const parsedPlan = BatchPlan.safeParse(raw);
        if (!parsedPlan.success) throw new CliExit(EXIT.invalid, `${planPath}: ${issueText(parsedPlan.error)}`);
        const oldPlan = parsedPlan.data;
        const oldCase = oldPlan.cases.find((c) => c.case_id === caseId);
        if (oldCase === undefined || oldCase.profile === null) {
          throw new CliExit(EXIT.usage, `${caseId}: not a fault case in batch ${oldBatchId}`);
        }
        const m = /^([a-z][a-z0-9_-]*)\/([a-z][a-z0-9_]*)@(\d+)$/.exec(oldPlan.capability);
        if (m?.[1] === undefined || m[2] === undefined || m[3] === undefined) {
          throw new CliExit(EXIT.invalid, `${planPath}: capability ${oldPlan.capability} does not fit app/capability@major`);
        }
        const app = m[1];
        const capability = m[2];
        const major = Number(m[3]);
        const { suite, faults } = await loadCertifyInputs(ctx, app, capability, major);
        const selection = resolveSelection(oldCase.profile, suite, faults);
        // The route map's own step ID whose entry matches this case's first resolved fault, so
        // the fresh baseline's `@each_request_step` anchor resolves to the same step again
        // (CONTRACT §5, §6: "counts repeat after a reset").
        const firstFault = oldCase.faults[0];
        const at = firstFault
          ? Object.entries(oldPlan.route_map).find(
              ([, e]) => e.route === firstFault.route && e.nth === firstFault.nth,
            )?.[0]
          : undefined;

        const { deps, origin, appVersion, frozenSet } = await buildDeps(ctx, app);
        const batchId = ctx.wiring.ids.batchId();
        const holds: LockHold[] = [
          await takeLock(ctx, "instance", instanceKey(origin), {
            owner: batchId,
            command: "certify",
            staff: ctx.staff,
            waitMs: 0,
          }),
        ];
        try {
          const result = await runCertifyCase(
            {
              batchId,
              tenant: ctx.tenant,
              app,
              capability,
              major,
              // The plan's own pin, never the newest sealed version (section 9 §9.1: rerun repeats the plan entry).
              version: oldPlan.pin.slice(oldPlan.pin.indexOf("@") + 1),
              appVersion,
              staff,
              className: oldCase.class,
              ...(ctx.flags.models === "off" ? { modelsOff: true } : {}),
              selection,
              at: at === undefined ? undefined : `@step:${at}`,
              classes: suite.classes,
              pools: {},
              instance: oldPlan.instance,
              frozenSet,
              rerun: { batchId: oldBatchId, caseId, inputs: oldCase.inputs, seed: oldCase.seed },
            },
            deps,
          );
          if (!result.ok) {
            if (result.failure === "needs_at") refuseNeedsAt(result.detail);
            throw new CliExit(EXIT.invalid, `certify rerun: ${result.failure}${result.detail ? `: ${result.detail}` : ""}`);
          }
          const answered = writeAndAnswer(ctx, result.value.plan, result.value.report);
          await recordBatch(ctx, "quick", result.value.plan, result.value.report, {
            appVersion,
            engine: deps.engineVersion,
            frozenSet,
          });
          return answered;
        } finally {
          for (const h of holds) await ctx.wiring.locks.release(h);
        }
      }),
    );

  certify
    .command("report")
    .argument("<batch_id>", "the batch to show")
    .description("prints a batch's report.json; writes nothing")
    .action(
      act(ctxOf, (ctx, args) => {
        requireStaff(ctx);
        const batchId = args[0] ?? "";
        const reportPath = join(batchDir(ctx, batchId), "report.json");
        let raw: unknown;
        try {
          raw = JSON.parse(readFileSync(reportPath, "utf8"));
        } catch {
          throw new CliExit(EXIT.usage, `${reportPath}: cannot be read`);
        }
        const parsed = BatchReport.safeParse(raw);
        if (!parsed.success) throw new CliExit(EXIT.invalid, `${reportPath}: ${issueText(parsed.error)}`);
        const c = parsed.data.cases[0];
        const lines = [
          `batch ${parsed.data.batch_id}`,
          `case ${c?.case_id ?? ""}: ${c?.result.status ?? ""}`,
          `verdict: ${c?.verdict ?? ""}`,
          `gate: ${parsed.data.gate.passed ? "passed" : "failed"}`,
        ];
        return Promise.resolve(
          answer({ batch_id: parsed.data.batch_id, report: parsed.data }, lines.join("\n"), parsed.data.gate.passed ? EXIT.ok : EXIT.failed),
        );
      }),
    );
};
