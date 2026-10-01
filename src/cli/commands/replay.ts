// `intyy replay <app/capability@major> --mode … --inputs <file> […]` and `intyy replay
// --request <file>`: replays one sealed artifact and returns its typed result. Follows design
// section 9 §10.1 to §10.3 (replay, waiting, stopping), §7.3 (`--reveal-outputs`), §7.5 (exit
// codes); section 4 §9.14 (the reveal rules); section 7 §13.2, §13.3 (the start confirmation);
// M05 task 9.
import { readFileSync } from "node:fs";
import type { Command } from "commander";
import { readArtifact } from "../../core/catalog/artifacts.js";
import type { ContractSensitivity } from "../../core/model/artifact/contract.js";
import type { RequestIndexKeySource } from "../../core/orchestrator/request-index.js";
import { issueText } from "../../core/model/sealing.js";
import { Request } from "../../core/model/request.js";
import type { Result } from "../../core/model/result.js";
import { draftTakeovers } from "../../core/handoff/drafts.js";
import { runReplay, type ReplayDeps, type ReplayInput, type ReplayOutcome } from "../../core/replay/executor.js";
import { redactionRules, Redactor } from "../../core/safety/redaction/redactor.js";
import type { LockHold } from "../../ports/locks.js";
import { takeLock, type Ctx } from "../context.js";
import { instanceKey } from "./discover.js";
import { load, orExit } from "./documents.js";
import { CliExit, EXIT, exitForStatus } from "../exit-codes.js";
import { progress, type Answer } from "../output.js";
import { act, readVersion, type Register } from "../program.js";
import { loadFrozenSetFor } from "./pack.js";
import { effectivePolicy } from "./policy.js";
import { settingsTarget } from "./settings.js";
import { driftDeps, driftTenants } from "./trust-shared.js";
import { raiseLiveWriteFailed, scanDrift } from "../../core/trust/alerts.js";

/** Splits `app/capability@major`. Only called once the request has passed `Request`'s schema
 * (the `MajorCapabilityLink` regex), so a mismatch here is a bug (CLAUDE.md: only bugs throw). */
function splitCapabilityLink(link: string): { app: string } {
  const m = /^([a-z][a-z0-9_-]*)\//.exec(link);
  if (m?.[1] === undefined) throw new Error(`replay: ${link} does not fit app/capability@major`);
  return { app: m[1] };
}

/** True when `origin`'s host is loopback (section 4 §9.14, section 9 §7.3). */
function isLoopback(origin: string): boolean {
  const host = new URL(origin).hostname;
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

/** Reads a file, or standard input for `-`. Never a flag value (docs/decisions.md, M04). */
async function readTextInput(ctx: Ctx, flag: string, path: string): Promise<string> {
  if (path === "-") return ctx.io.stdin.readAll();
  try {
    return readFileSync(path, "utf8");
  } catch {
    throw new CliExit(EXIT.usage, `${flag} ${path}: cannot be read`);
  }
}

/** Reads and parses one JSON file or standard input. A bad file is a usage error naming it. */
async function readJsonInput(ctx: Ctx, flag: string, path: string): Promise<unknown> {
  const text = await readTextInput(ctx, flag, path);
  try {
    return JSON.parse(text);
  } catch {
    throw new CliExit(EXIT.usage, `${flag} ${path}: not valid JSON`);
  }
}

/** Waits `ms`, or returns early when `signal` aborts. CLI code only; core never uses a timer. */
function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(t);
      resolve();
    }, { once: true });
  });
}

/**
 * The two request forms (section 9 §10.1). `--request <file>` replaces the capability argument
 * and every flag that would otherwise build the request body.
 */
function buildRawRequest(
  ctx: Ctx,
  args: string[],
  opts: Record<string, unknown>,
  runId: string,
): Promise<unknown> {
  const usingRequestFile = typeof opts.request === "string";
  const flagsGiven =
    args[0] !== undefined ||
    opts.mode !== undefined ||
    opts.inputs !== undefined ||
    opts.authorization !== undefined ||
    opts.requestId !== undefined;
  if (usingRequestFile && flagsGiven) {
    throw new CliExit(
      EXIT.usage,
      "--request replaces the capability argument and --mode/--inputs/--authorization/--request-id; do not mix the two forms",
    );
  }
  if (usingRequestFile) return readJsonInput(ctx, "--request", opts.request as string);
  if (args[0] === undefined) {
    throw new CliExit(EXIT.usage, "name a capability, like kvfcu/open_share_subaccount@1, or use --request <file>");
  }
  if (opts.mode !== "supervised" && opts.mode !== "unattended") {
    throw new CliExit(EXIT.usage, "--mode takes supervised or unattended");
  }
  if (typeof opts.inputs !== "string") {
    throw new CliExit(EXIT.usage, "name --inputs <file|->, the input values as JSON");
  }
  return (async () => {
    const inputs = await readJsonInput(ctx, "--inputs", opts.inputs as string);
    const authorization =
      typeof opts.authorization === "string" ? await readJsonInput(ctx, "--authorization", opts.authorization) : undefined;
    // Why the run ID's own shape: docs/decisions.md, M05. A `cli-<staff>-<epoch-ms>` default (the
    // literal S9 §10.1 text) has a long digit run that the redactor's digit-run rule (§9.9)
    // mangles wherever the request ID is logged, breaking re-reads. The run ID shape is already
    // a recognized `Fact` (section 3 §7.2, §6.7): reusing this run's own ID survives masking,
    // has no `:`, is unique per call, and is printed already, so a caller can still resend it.
    const requestId = typeof opts.requestId === "string" ? opts.requestId : runId;
    return {
      schema: "intyy.request/1.0",
      request_id: requestId,
      capability: args[0],
      inputs,
      mode: opts.mode,
      ...(authorization === undefined ? {} : { authorization }),
    };
  })();
}

/** Polls for the run's own `start_confirmation` mailbox request, prompts on standard error, and
 * writes the answer straight through the desk (docs/decisions.md, M05: "the answer is written
 * as the mailbox's decision.json, through the same desk"). Stops once `signal` aborts. */
async function answerStartConfirmationOnTerminal(
  ctx: Ctx,
  redactor: Redactor,
  runId: string,
  signal: AbortSignal,
): Promise<void> {
  while (!signal.aborted) {
    const got = await ctx.wiring.desk.openRequest(ctx.tenant, runId);
    if (got.ok && got.value !== null && !got.value.decided) {
      const req = got.value.request as { kind?: unknown };
      if (req.kind === "start_confirmation") {
        const line = await ctx.io.stdin.question(`run ${runId}: start this run? [y/N] `);
        const decision = /^y/i.test(line.trim()) ? "approved" : "declined";
        const body = redactor.value({
          schema: "intyy.decision/1.0",
          staff_id: ctx.staff ?? "cli",
          at: ctx.wiring.clock.now().toISOString(),
          decision,
          outcome: null,
          note: null,
        });
        await ctx.wiring.desk.decide(ctx.tenant, runId, got.value.folder, body);
        return;
      }
    }
    await delay(200, signal);
  }
}

/** Each output's own sensitivity, from the sealed artifact's contract (section 2 §12.5). A
 * lookup failure (no version resolved, or the artifact cannot be read) answers `undefined` for
 * every output; the caller then masks it as `pii` — unsure means `pii` (section 6 §6.1). */
export async function outputSensitivity(
  ctx: Ctx,
  capability: { name: string; version: string | null },
): Promise<(output: string) => ContractSensitivity | undefined> {
  const none = (): undefined => undefined;
  if (capability.version === null) return none;
  const cut = capability.name.indexOf("/");
  if (cut < 0) return none;
  const app = capability.name.slice(0, cut);
  const cap = capability.name.slice(cut + 1);
  const got = await readArtifact(ctx.wiring.candidates, app, cap, capability.version);
  if (!got.ok) return none;
  const byName = new Map(got.value.contract.outputs.map((o) => [o.name, o.sensitivity]));
  return (output) => byName.get(output);
}

/**
 * Masked delivery (section 3 §5.13): an output labelled `pii` or `financial` comes back as the
 * literal `[pii]`/`[financial]`, never its value; `none` stays raw. Unknown sensitivity (the
 * contract could not be read) counts as `pii`. Adds warning `outputs_masked` when anything
 * changed. No redactor: a fixed placeholder per label can never leak the value itself. Shared by
 * `replay`'s non-raw view and `run status`/`show`.
 */
export function maskOutputsForDelivery(
  result: Result,
  sensitivityOf: (output: string) => ContractSensitivity | undefined,
): Result {
  if (result.status !== "success") return result;
  let changed = false;
  const outputs: typeof result.outputs = {};
  for (const [name, value] of Object.entries(result.outputs)) {
    const label = sensitivityOf(name) ?? "pii";
    if (label === "none") {
      outputs[name] = value;
      continue;
    }
    outputs[name] = `[${label}]`;
    changed = true;
  }
  if (!changed) return result;
  const already = result.warnings.some((w) => w.code === "outputs_masked");
  const warnings = already
    ? result.warnings
    : [
        ...result.warnings,
        { code: "outputs_masked" as const, message: "sensitive outputs are masked; this is not a live delivery" },
      ];
  return { ...result, outputs, warnings };
}

/** One line per field of a final result, for the human summary. Shared with `run show`. */
export function outputLines(result: Result): string[] {
  const lines = [`run ${result.run_id}`, result.status];
  if (result.status === "success") {
    for (const [k, v] of Object.entries(result.outputs)) lines.push(`${k}: ${String(v)}`);
  } else if (result.status === "business_outcome") {
    lines.push(`${result.outcome.code}: ${result.outcome.description}`);
  } else if (result.status === "failed") {
    lines.push(`${result.failure.code}: ${result.failure.message}`);
  } else if (result.status === "rejected") {
    for (const e of result.rejection.errors) lines.push(`${e.code}: ${e.message}`);
  }
  return lines;
}

/**
 * The models a replay run may use (section 5 §8.7, §8.8). There is no jev adapter, so rung 2 is
 * never wired. The reviewer is built only when policy `llm.replay_reviewer` is on, the run is not
 * `--models off`, and the key variable `intyy.json` names is set (never read from a file).
 * `certify` uses it too, so a batch tests the ladder a live run gets (section 8 §7.1).
 */
export function replayModels(ctx: Ctx, reviewerSwitch: boolean): NonNullable<ReplayDeps["models"]> {
  if (ctx.flags.models === "off") return { off: true };
  if (!reviewerSwitch) return {};
  const name = ctx.config.model_keys.claude;
  const key = ctx.io.env[name];
  if (key === undefined || key === "") {
    progress(ctx.io, `the reviewer is off for this run: set ${name} to turn it on.`);
    return {};
  }
  return { reviewer: ctx.wiring.reviewer(key) };
}

/**
 * Checks `--pin` (section 8 §11.5): an operator may pin an exact key, supervised only. The pin must
 * name the request's own capability and major. A patch pin (`+p3`) waits for patch keys. Callers
 * never reach this: a request file has no pin field, and an agent's request names a major only.
 */
function pinOf(pin: unknown, request: Request): string | null {
  if (pin === undefined) return null;
  if (typeof pin !== "string") throw new CliExit(EXIT.usage, "--pin takes a key, like kvfcu/open_share_subaccount@1.0.0");
  if (request.mode !== "supervised") throw new CliExit(EXIT.usage, "--pin works only with --mode supervised");
  if (!/^[a-z][a-z0-9_-]*\/[a-z][a-z0-9_]*@\d+\.\d+\.\d+$/.test(pin)) {
    throw new CliExit(EXIT.usage, "--pin: write an exact key, like kvfcu/open_share_subaccount@1.0.0 (patch pins are not built yet)");
  }
  if (!pin.startsWith(`${request.capability}.`)) {
    throw new CliExit(EXIT.usage, `--pin ${pin}: not a version of ${request.capability}`);
  }
  return pin;
}

/** Registers `replay`. */
export const registerReplay: Register = (program: Command, ctxOf) => {
  program
    .command("replay")
    .argument("[capability]", "the capability to run, like kvfcu/open_share_subaccount@1")
    .option("--mode <mode>", "supervised or unattended")
    .option("--inputs <file>", "the input values as JSON, from a file, or - for standard input")
    .option("--authorization <file>", "a file holding the authorization block, if any")
    .option("--request-id <id>", "the caller's own idempotency key (default: cli-<staff>-<time>)")
    .option("--agent <id>", "the calling agent's ID (default: INTYY_AGENT, or cli:<staff>)")
    .option("--request <file>", "a whole intyy.request/1.0 file, instead of a capability and flags")
    .option("--pin <key>", "supervised only: run this exact key, like kvfcu/open_share_subaccount@1.0.0")
    .description("replay one sealed artifact: sign in, do the task, and return a typed result")
    .action(
      act(ctxOf, async (ctx, args, opts) => {
        // Why generated first: the default request ID (below) reuses this exact value.
        const runId = ctx.wiring.ids.runId();
        const rawRequest = await buildRawRequest(ctx, args, opts, runId);
        const parsedRequest = Request.safeParse(rawRequest);
        if (!parsedRequest.success) {
          throw new CliExit(EXIT.usage, `request: ${issueText(parsedRequest.error)}`);
        }
        const request = parsedRequest.data;
        const { app: appName } = splitCapabilityLink(request.capability);
        const pin = pinOf(opts.pin, request);

        const t = settingsTarget(ctx);
        const settings = await load(t, ["approved"]);
        if (settings === undefined) {
          throw new CliExit(EXIT.invalid, `settings ${ctx.tenant} have no approved revision`);
        }
        const sealed = orExit(await t.store.get(t.id, settings.rev), `settings ${ctx.tenant}`);
        const app = settings.doc.apps[appName];
        const policy = await effectivePolicy(ctx, appName);

        if (ctx.flags.revealOutputs) {
          const allowed = app !== undefined && app.environment === "test" && isLoopback(app.origin);
          if (!allowed) {
            throw new CliExit(EXIT.usage, "--reveal-outputs needs environment: test and a loopback origin");
          }
        }

        const agentId =
          typeof opts.agent === "string"
            ? opts.agent
            : (ctx.io.env.INTYY_AGENT ?? (ctx.staff !== null ? `cli:${ctx.staff}` : "cli"));

        const holds: LockHold[] = [];
        // Why only when `app` resolves: with no origin there is nothing to key an instance lock
        // by, and pre-run checks reject the request before any browser could need one anyway.
        if (app !== undefined) {
          holds.push(
            await takeLock(ctx, "instance", instanceKey(app.origin), {
              owner: runId,
              command: "replay",
              staff: ctx.staff,
              waitMs: 0,
            }),
          );
        }
        holds.push(
          await takeLock(ctx, "run", runId, { owner: runId, command: "replay", staff: ctx.staff, waitMs: 0 }),
        );

        const stop = new AbortController();
        let presses = 0;
        const onInt = (): void => {
          presses += 1;
          if (presses === 1) {
            progress(ctx.io, `run ${runId}: stopping at the next safe point, never mid-commit.`);
            stop.abort();
          } else {
            progress(ctx.io, "A kill now may leave the commit uncertain.");
            process.exit(1);
          }
        };
        process.on("SIGINT", onInt);

        const consumedStdin =
          (typeof opts.request === "string" && opts.request === "-") ||
          (typeof opts.inputs === "string" && opts.inputs === "-");
        const canPromptHere = !consumedStdin && ctx.io.stdin.isTTY === true && ctx.io.stderr.isTTY === true;
        let watcher = Promise.resolve();
        if (request.mode === "supervised") {
          if (canPromptHere) {
            const redactor = new Redactor(redactionRules(policy.effective));
            watcher = answerStartConfirmationOnTerminal(ctx, redactor, runId, stop.signal);
          } else {
            progress(
              ctx.io,
              `run ${runId}: waiting for a start confirmation. Elsewhere, answer with: intyy operator decide ${runId} approved|declined`,
            );
          }
        }

        const keys: RequestIndexKeySource[] = (settings.doc.system_secrets?.request_index_keys ?? []).map((k) => ({
          keyId: k.key_id,
          status: k.status,
          binding: { source: k.source, key: k.key },
        }));
        const deps: ReplayDeps = {
          evidence: ctx.wiring.evidence,
          clock: ctx.wiring.clock,
          ids: ctx.wiring.ids,
          secrets: ctx.wiring.secrets,
          surface: ctx.wiring.discovery.surface(),
          artifacts: ctx.wiring.candidates,
          requestIndex: { store: ctx.wiring.requestIndexStore, clock: ctx.wiring.clock, secrets: ctx.wiring.secrets, keys },
          scores: ctx.wiring.scores,
          locks: ctx.wiring.locks,
          // Why: section 8 §5.6. A live line that cannot be written is said once; the run's result stands.
          // `trust rebuild --from-evidence` repairs it.
          // It also writes an alert (section 8 §5.6); a failed alert write is said, never fatal.
          onLiveFailure: async (f) => {
            progress(ctx.io, `run ${f.runId}: could not write the live line for ${f.key}: ${f.reason}. Repair with: intyy trust rebuild ${f.key} --from-evidence`);
            const raised = await raiseLiveWriteFailed(driftDeps(ctx), { tenant: ctx.tenant, ...f });
            if (!raised.ok) progress(ctx.io, `run ${f.runId}: could not write the alert for ${f.key}: ${raised.detail ?? raised.failure}`);
          },
          alerts: ctx.wiring.alerts,
          // Why: section 8 §13.1, the drift reader runs after every score write.
          afterScoreWrite: async () => {
            await scanDrift(driftDeps(ctx), await driftTenants(ctx));
          },
          operator: ctx.wiring.discovery.operator,
          models: replayModels(ctx, policy.effective.llm.replay_reviewer),
          signal: stop.signal,
        };
        // Section 5 §7.4: the merged, approved handler set for this tenant, app, and app
        // version. `app === undefined` here means pre-run checks reject the request before a
        // frozen set could matter anyway (docs/decisions.md, M06: no pack files → empty set).
        const frozenSet =
          app === undefined ? undefined : await loadFrozenSetFor(ctx, ctx.tenant, appName, app.app_version);
        const input: ReplayInput = {
          runId,
          request,
          tenant: ctx.tenant,
          agentId,
          policy,
          settings: { doc: settings.doc, rev: settings.rev, hash: sealed.hash },
          appVersion: app?.app_version,
          engineVersion: readVersion(),
          outputsRevealed: ctx.io.stdout.isTTY === true || ctx.flags.revealOutputs,
          visible: false,
          ...(pin === null ? {} : { pin }),
          ...(frozenSet === undefined ? {} : { frozenSet }),
        };

        let outcome: ReplayOutcome;
        try {
          outcome = await runReplay(input, deps);
        } finally {
          process.removeListener("SIGINT", onInt);
          stop.abort();
          await watcher.catch(() => undefined);
          for (const h of holds) await ctx.wiring.locks.release(h);
        }

        // Section 7 §16.5: a takeover a human handed back, for an unknown state, drafts a handler.
        // The drafts never change this run's result. A draft that cannot be written is only said.
        if (app !== undefined && outcome.result.interventions.length > 0) {
          const drafted = await draftTakeovers(
            { evidence: ctx.wiring.evidence, drafts: ctx.wiring.drafts },
            { tenant: ctx.tenant, runId, app: appName, appVersion: app.app_version },
          );
          for (const id of drafted.written) progress(ctx.io, `run ${runId}: drafted handler ${appName}/${id} (see: intyy pack draft show ${id}).`);
          for (const id of drafted.failed) progress(ctx.io, `run ${runId}: could not write the draft handler ${id}.`);
        }

        // Fail closed (section 4 §9.14, section 3 §5.13): off a terminal, without a valid
        // `--reveal-outputs`, the non-raw view is always this masked delivery, built straight
        // from the in-memory result and the contract's own output labels — never a fallback to
        // the raw value, and never dependent on how (or whether) `run.json` happened to land.
        const maskedResult = maskOutputsForDelivery(
          outcome.result,
          await outputSensitivity(ctx, outcome.result.capability),
        );

        const answer: Answer = {
          text: (raw) => outputLines(raw ? outcome.result : maskedResult).join("\n"),
          data: (raw) => (raw ? outcome.result : maskedResult),
          code: exitForStatus(outcome.result.status),
        };
        return answer;
      }),
    );
};
