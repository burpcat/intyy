// The replay executor: pre-run checks, frozen facts, the prelude, the task's steps, the result,
// and the end of the run. Follows design section 7 §4 (a run, start to end), §10 (the prelude),
// §18 (determinism); section 3 §4.8 (pre-run checks), §6.5 (frozen facts), §6.6 (write-ahead),
// §5 (the result), §7.3 to §7.5 (evidence files and when to capture); section 1 §19 ("Commit
// points"), section 2 §16.6 (commit states). Handlers, packs, retries, and reconciliation are
// M06; in this milestone any unexpected screen is a hard `failed`. Core stays pure: only ports.
import type { Clock, Ids } from "../../ports/clock.js";
import type { Outcome } from "../../ports/outcome.js";
import type { OperatorPort } from "../../ports/operator.js";
import type { Secrets } from "../../ports/secrets.js";
import type { ArtifactStore } from "../catalog/artifacts.js";
import type { EvidenceStore, RunFolder } from "../../ports/stores.js";
import type { Eyes, LeaseToken, SurfaceFactory, Viewport } from "../../ports/surface.js";
import { sha256Hex } from "../model/canonical.js";
import type { Artifact } from "../model/artifact.js";
import type { ContractOutput } from "../model/artifact/contract.js";
import type { Step } from "../model/artifact/steps.js";
import type { ContractValue } from "../model/common.js";
import { Request } from "../model/request.js";
import { Result, type EffectBlock } from "../model/result.js";
import { RunJson } from "../model/run.js";
import type { FrozenSet } from "../packs/merge.js";
import type { MergeResult } from "../safety/policy/merge.js";
import { buildAllowlist } from "../safety/policy/allowlist.js";
import type { Settings } from "../model/settings.js";
import { openGate, type GateRun } from "../safety/gate/gate.js";
import { fact, Redactor, redactionRules, type Fact, type KnownValue } from "../safety/redaction/redactor.js";
import type { SecretSources } from "../safety/secrets/injector.js";
import type { RequestIndexDeps } from "../orchestrator/request-index.js";
import { catalogRequestIndex, catalogResolve, runPrechecks } from "../orchestrator/prechecks.js";
import { RunLog } from "../orchestrator/run-log.js";
import { commitStep, type CommitApproval, type CommitContext } from "./commit.js";
import { OperatorSupervisor } from "../discovery/supervisor.js";
import { capture } from "../capture/capture.js";
import { matchDetectors, runLadder, type LadderStep } from "./ladder.js";
import { PRECONDITION_TIMEOUT_MS, runPrelude, runStep, type StepFailure, type StepRunnerContext } from "./prelude.js";
import { waitForCondition } from "./wait.js";
import type { EvalCtx } from "../targets/evaluate.js";
import { fromObservation } from "../targets/screen.js";

/** No pack files anywhere for this run (docs/decisions.md, M06): the frozen set is empty, not
 * an error. `runReplay` uses this whenever `ReplayInput.frozenSet` is not supplied. */
const EMPTY_FROZEN_SET: FrozenSet = {
  targets: [],
  conditions: [],
  handlers: [],
  handlerScope: new Map(),
  runStart: { ids: [], packs: {}, from: {}, hash: `sha256:${sha256Hex("")}` },
  warnings: [],
};

/** `{system.last_good_path}` (docs/decisions.md, M06): the top-level page's path and query. */
function pathAndQuery(url: string): string {
  if (!URL.canParse(url)) return url;
  const u = new URL(url);
  return `${u.pathname}${u.search}`;
}

/** One `result.recoveries[]` entry (section 3 §5.10). Rung is always `1` in M06: rungs 2 and 3
 * are off (docs/decisions.md). */
type RecoveryLine = { step: string; rung: 1; via: "handler" | "retry"; ref: string; resumed_at: string; at: string };

/** The browser window size for replay. Fixed, so boxes and crops stay comparable. */
export const REPLAY_VIEWPORT: Viewport = { width: 1280, height: 800 };

/** What one replay run starts from. The caller has already validated the request. */
export type ReplayInput = {
  /** Made by the caller before any check runs, like discovery (section 3 §4.8). */
  runId: string;
  request: Request;
  tenant: string;
  agentId: string;
  policy: MergeResult;
  settings: { doc: Settings; rev: string; hash: string };
  /** The tenant's app version for the request's app, or `undefined` when unconfigured. */
  appVersion: string | undefined;
  engineVersion: string;
  /** `run_start.outputs_revealed` (docs/decisions.md, M05): true when the caller asked for raw
   * outputs. The delivery window itself is the caller's own process lifetime. */
  outputsRevealed: boolean;
  /** Show the browser window. Tests run headless. */
  visible: boolean;
  /** The merged handler set for this run (section 5 §7.4). Loading packs from `library/` is not
   * this module's job (docs/decisions.md, M06); a caller with none may omit this, and gets an
   * empty frozen set (not an error). */
  frozenSet?: FrozenSet;
};

/** The ports one replay run uses. */
export type ReplayDeps = {
  evidence: EvidenceStore;
  clock: Clock;
  ids: Ids;
  secrets: Secrets;
  surface: SurfaceFactory;
  artifacts: ArtifactStore;
  requestIndex: RequestIndexDeps;
  operator: (run: { runId: string; tenant: string }) => OperatorPort;
  signal?: AbortSignal;
};

/** How the run ended. */
export type ReplayOutcome = { runId: string; result: Result };

/** A capability block with no version, for a run that never resolved one (section 3 §5.1). */
type CapabilityBlock = { name: string; version: string | null; patch_revision: number | null };

/** Splits `app/capability@major`. The request schema already enforces this shape. */
function splitCapabilityLink(link: string): { app: string; capability: string; major: number } {
  const m = /^([a-z][a-z0-9_-]*)\/([a-z][a-z0-9_]*)@([1-9]\d*)$/.exec(link);
  if (m?.[1] === undefined || m[2] === undefined || m[3] === undefined) {
    throw new Error(`splitCapabilityLink: ${link} does not fit app/capability@major`);
  }
  return { app: m[1], capability: m[2], major: Number(m[3]) };
}

/** One artifact's ID and hash, for `frozen.artifact`/`frozen.session` (section 3 §6.5). */
function artifactRef(a: Artifact): { id: string; hash: ReturnType<typeof fact> } {
  return {
    id: `${a.identity.app}/${a.identity.capability}@${a.identity.version ?? ""}`,
    hash: fact(`sha256:${sha256Hex(JSON.stringify(a))}`),
  };
}

/** The known value for one contract input (section 4 §9.6), mirroring discovery's own. */
function knownInput(input: Artifact["contract"]["inputs"][number], value: ContractValue): KnownValue {
  const type = input.type === "money" ? "money" : input.type === "date" ? "date" : "text";
  const kind =
    input.sensitivity === "financial" || input.type === "money"
      ? "money"
      : input.type === "date"
        ? "dob"
        : "member";
  return { ref: `input.${input.name}`, value: String(value), label: input.sensitivity, type, kind };
}

/** The frozen facts for a replay `run_start` line (section 3 §6.5). `artifact`/`session` are
 * null when pre-run checks stopped before resolving them. */
function frozenFacts(input: ReplayInput, artifact: Artifact | null, session: Artifact | null): unknown {
  const masks: Record<string, string> = {};
  if (artifact !== null) {
    for (const i of artifact.contract.inputs) {
      masks[i.name] = i.sensitivity === "none" ? `{input.${i.name}}` : `[${i.sensitivity}]`;
    }
  } else {
    // Why generic: the contract is not known yet (an early rejection). The digit-run and
    // detector rules still catch most sensitive shapes; assume the worst otherwise.
    for (const k of Object.keys(input.request.inputs)) masks[k] = "[pii]";
  }
  return {
    schema: "intyy.log/1.0",
    kind: "replay",
    parent_run_id: null,
    purpose: null,
    batch_id: null,
    request_id: input.request.request_id,
    tenant: input.tenant,
    agent_id: input.agentId,
    mode: input.request.mode,
    inputs: masks,
    authorization: input.request.authorization ?? null,
    frozen: {
      artifact: artifact === null ? null : artifactRef(artifact),
      patch: null,
      session: session === null ? null : { ...artifactRef(session), patch: null },
      app_version: input.appVersion ?? null,
      engine_version: input.engineVersion,
      policy: { layers: input.policy.layers, hash: fact(input.policy.hash) },
      settings: { revision: Number(input.settings.rev), hash: fact(input.settings.hash) },
      evidence_level: input.policy.effective.evidence.level,
      // Why empty: M05 has no tuning batch yet (section 8, M10).
      timeouts: {},
      timeouts_from: null,
      // Why draft: check 7 is thin until the score store exists (M10; section 3 §4.8 check 7).
      approval: { state: "draft", batch: null, record: null },
      // Why both false: rungs 2 and 3 do not exist until M09; a frozen fact must be true
      // (docs/decisions.md, M06). A climb goes straight to rung 4.
      ladder: { jev: false, reviewer: false },
    },
    fault_profile: null,
    outputs_revealed: input.outputsRevealed,
  };
}

const MS_PER_DAY = 86_400_000;

/** `ms` (epoch milliseconds) as a `YYYY-MM-DD` UTC date. `Intl.DateTimeFormat.format` takes a
 * plain number, so no `Date` object is constructed here (CLAUDE.md core rule). */
function isoDate(ms: number): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "UTC" }).format(ms);
}

/** Reads every listed path back and hashes it, for `run.json.files` (section 3 §7.3). A file
 * this run itself just wrote is always readable; a read failure here is a bug. */
async function fileList(
  folder: RunFolder,
  paths: readonly string[],
  signal?: AbortSignal,
): Promise<{ path: string; sha256: string; bytes: number }[]> {
  const out: { path: string; sha256: string; bytes: number }[] = [];
  for (const path of paths) {
    const read = await folder.readFile(path, signal);
    if (!read.ok) throw new Error(`run.json: ${path} was written but cannot be read back`);
    out.push({ path, sha256: `sha256:${sha256Hex(read.value)}`, bytes: read.value.byteLength });
  }
  return out;
}

/** A run-file path that fits a capture-file fact shape (`screens/`, `dom/`, `a11y/`, …). The
 * bare `events.jsonl` does not, but holds no digit run either, so plain masking leaves it as is. */
function isCapturePath(path: string): boolean {
  return /^(screens|dom|a11y|crops|llm|blobs)\//.test(path);
}

/** An ID string in the run/batch/lease/alert fact shape (section 3 §7.2), the same shape a
 * default request ID now reuses (docs/decisions.md, M05). Anything else — a caller's own
 * `--request-id` text — stays plain, since it may hold sensitive text the redactor must still
 * catch. */
const ID_FACT_RE = /^(run|batch|lease|alert)_\d{4}-\d{2}-\d{2}_[0-9a-hjkmnp-tv-z]{10}$/;

/** Wraps `id` as a fact only when it fits that shape. */
function protectId(id: string | null): string | Fact | null {
  return id !== null && ID_FACT_RE.test(id) ? fact(id) : id;
}

/** Writes `run.json` and the tenant index line for the end state (section 3 §7.3).
 *
 * Why the extra wrapping below: `run_id`, a fact-shaped `request_id`, and each file's own hash
 * and capture path are strings intyy made itself, embedded inside `result` and the envelope
 * that the redactor (§6.7) then masks wholesale for the on-disk copy. Left plain, the digit-run
 * rule (§9.9) can mangle a hash or a random ID's digits, breaking `run.json` on the next read —
 * a real incident the M05 test gate caught. `Fact` (§6.7) is exactly for this; `RunJson.parse`
 * runs again on the masked bytes actually being written, so a broken shape here throws at once
 * instead of silently landing on disk. */
async function finish(
  folder: RunFolder,
  deps: ReplayDeps,
  r: Redactor,
  input: ReplayInput,
  capability: string,
  status: Result["status"],
  code: string | null,
  result: Result,
  files: readonly string[],
): Promise<void> {
  const at = deps.clock.now().toISOString();
  const nowMs = deps.clock.now().getTime();
  const fileEntries = await fileList(folder, [...files, "events.jsonl"], deps.signal);
  const raw = {
    schema: "intyy.run/1.0",
    run_id: fact(folder.runId),
    tenant: input.tenant,
    kind: "replay",
    capability,
    parent_run_id: null,
    batch_id: null,
    request_id: protectId(input.request.request_id),
    status,
    result: { ...(result as unknown as Record<string, unknown>), run_id: fact(result.run_id), request_id: protectId(result.request_id) },
    frozen: JSON.parse(JSON.stringify(r.value(frozenFacts(input, null, null)))) as Record<string, unknown>,
    files: fileEntries.map((f) => ({
      path: isCapturePath(f.path) ? fact(f.path) : f.path,
      sha256: fact(f.sha256),
      bytes: f.bytes,
    })),
    retention: {
      debug_until: isoDate(nowMs + 30 * MS_PER_DAY),
      audit_until: isoDate(nowMs + 365 * MS_PER_DAY),
    },
  };
  const masked = r.value(raw);
  RunJson.parse(masked);
  await folder.writeRunJson(masked, deps.signal);
  await deps.evidence.appendIndex(
    input.tenant,
    r.value({ run_id: fact(folder.runId), at: fact(at), status, code, kind: "replay", capability }),
    deps.signal,
  );
}

/** `not_sent`: nothing has gone out yet (section 3 §5.8, "`null` when `not_sent`"). The starting
 * point for any `commits` capability's run, until the commit step says otherwise. */
function notSentEffect(): EffectBlock {
  return { commit: "not_sent", performed_by: null, sent_at: null, attempts: [] };
}

/** A hard failure's `Result` (section 3 §5.5). `safe_to_retry` is the executor's own call
 * (tester's note, M05): it lives on the failure block, not the effect block. `effect` is
 * present on every non-rejected result of a `commits` capability (section 3 §5.8); `null` for
 * `read_only`, or before the capability's effect is even known. */
function failedResult(
  runId: string,
  capability: CapabilityBlock,
  step: string | null,
  failure: StepFailure,
  location: string,
  safeToRetry: boolean,
  files: readonly string[],
  startedAt: string,
  endedAt: string,
  effect: EffectBlock | null,
): Result {
  return Result.parse({
    schema: "intyy.result/1.0",
    run_id: runId,
    request_id: null,
    capability,
    warnings: [],
    recoveries: [],
    interventions: [],
    timing: { started_at: startedAt, ended_at: endedAt, duration_ms: 0, human_ms: 0 },
    evidence: `runs/${runId}`,
    status: "failed",
    ...(effect === null ? {} : { effect }),
    failure: {
      code: failure.code,
      message: failure.message,
      step,
      phase: failure.phase,
      expected: { condition: failure.phase, description: failure.message },
      observed: { location, checks: [] },
      attempts: 0,
      ladder: { rung: 0, verdict: "hard_failure", ref: failure.phase },
      transient: false,
      safe_to_retry: safeToRetry,
      files: [...files],
    },
  });
}

/** True when `signal` has aborted. A named function, not an inline check, so TypeScript never
 * "remembers" an earlier read across an `await` inside the same loop body. */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

/** The active page's address, or `""` when the screen cannot be read. Never throws. */
async function currentLocation(eyes: Eyes, signal?: AbortSignal): Promise<string> {
  const o = await eyes.observe(signal);
  return o.ok ? o.value.url : "";
}

/** Whether a retry is safe, from the effect block alone (section 3 §5.5, "`safe_to_retry`"). */
function safeToRetryOf(effect: EffectBlock): boolean {
  return effect.commit !== "confirmed" && effect.commit !== "found_by_check" && effect.commit !== "uncertain";
}

/**
 * Runs one replay (section 7 §4). A rejected or failed-before-open request still gets a run ID
 * and a short log: `run_start`, `precheck`, `run_end` (section 3 §4.8).
 */
export async function runReplay(input: ReplayInput, deps: ReplayDeps): Promise<ReplayOutcome> {
  const { app: appName, capability: capName } = splitCapabilityLink(input.request.capability);
  const capabilityStr = `${appName}/${capName}`;
  const app = input.settings.doc.apps[appName];
  const sources: SecretSources = {
    declared: input.policy.effective.secrets,
    bindings: app?.secrets ?? {},
    port: deps.secrets,
  };

  const pre = await runPrechecks(
    {
      raw: input.request,
      tenant: input.tenant,
      agentId: input.agentId,
      runId: input.runId,
      now: deps.clock.now(),
      appVersion: input.appVersion,
      policy: input.policy.effective,
      resolve: catalogResolve(deps.artifacts),
      ...catalogRequestIndex(deps.requestIndex),
      secretSources: sources,
    },
    deps.signal,
  );

  // A true repeat: no new run. The caller reads the stored result of the original run.
  if (pre.outcome.status === "duplicate") {
    const original = await deps.evidence.readRunJson(input.tenant, pre.outcome.runId, deps.signal);
    const parsed = original.ok ? RunJson.safeParse(original.value) : null;
    if (parsed?.success === true && parsed.data.kind === "replay") {
      return { runId: pre.outcome.runId, result: parsed.data.result };
    }
    throw new Error(`request index named ${pre.outcome.runId} as a repeat, but its run.json is unreadable`);
  }

  const runId = input.runId;
  const artifactForFacts = pre.outcome.status === "ok" ? pre.outcome.artifact : null;
  const sessionForFacts = pre.outcome.status === "ok" ? pre.outcome.sessionArtifact : null;
  // Why an effect this early: section 3 §5.8, present on every non-rejected result of a
  // `commits` capability. `null` when the artifact never resolved (a precheck-stage failure).
  const earlyEffect = artifactForFacts?.contract.effect === "commits" ? notSentEffect() : null;

  const created = await deps.evidence.createRun(input.tenant, runId, deps.signal);
  if (!created.ok) {
    const now = deps.clock.now().toISOString();
    const cap: CapabilityBlock = { name: capabilityStr, version: null, patch_revision: null };
    const failure: StepFailure = { code: "evidence_write_failed", phase: "start", message: "could not create the run folder" };
    return { runId, result: failedResult(runId, cap, null, failure, "", true, [], now, now, earlyEffect) };
  }
  const folder = created.value;
  const r = new Redactor(redactionRules(input.policy.effective));
  if (artifactForFacts !== null) {
    for (const i of artifactForFacts.contract.inputs) {
      const v = input.request.inputs[i.name];
      if (v !== undefined) r.addKnown(knownInput(i, v));
    }
  }
  const log = new RunLog(folder, r, deps.clock);
  const startedAt = deps.clock.now().toISOString();
  const capabilityBlock: CapabilityBlock = {
    name: capabilityStr,
    version: artifactForFacts?.identity.version ?? null,
    patch_revision: null,
  };

  await deps.evidence.appendIndex(
    input.tenant,
    r.value({ run_id: fact(runId), at: fact(startedAt), status: "running", code: null, kind: "replay", capability: capabilityStr }),
    deps.signal,
  );
  await log.append(
    { event: "run_start", step: null, by: "engine", data: frozenFacts(input, artifactForFacts, sessionForFacts) },
    true,
  );
  await log.append({ event: "precheck", step: null, by: "engine", data: { checks: pre.results } });

  if (pre.outcome.status !== "ok") {
    const endedAt = deps.clock.now().toISOString();
    const status = pre.outcome.status === "rejected" ? "rejected" : "failed";
    const code = pre.outcome.code;
    const result: Result =
      pre.outcome.status === "rejected"
        ? Result.parse({
            schema: "intyy.result/1.0",
            run_id: runId,
            request_id: input.request.request_id,
            capability: capabilityBlock,
            warnings: [],
            recoveries: [],
            interventions: [],
            timing: { started_at: startedAt, ended_at: endedAt, duration_ms: 0, human_ms: 0 },
            evidence: `runs/${runId}`,
            status: "rejected",
            rejection: { errors: pre.outcome.errors },
          })
        : failedResult(
            runId,
            capabilityBlock,
            null,
            { code: pre.outcome.code, phase: "start", message: pre.outcome.detail },
            "",
            true,
            [],
            startedAt,
            endedAt,
            // Why null: a precheck-stage failure here never resolved the artifact, so the
            // capability's effect (commits or read_only) is not known (a documented gap).
            null,
          );
    await log.append({ event: "run_end", step: null, by: "engine", data: { status, code } }, true);
    await finish(folder, deps, r, input, capabilityStr, status, code, result, []);
    return { runId, result };
  }

  // pre.outcome.status === "ok" from here: a fresh, narrowed destructure (the artifact is never
  // null on this path).
  const { artifact, sessionArtifact } = pre.outcome;

  // Section 3 §5.8: present on every non-rejected result of a `commits` capability. Starts
  // `not_sent`; the commit step (below) updates it once it actually runs.
  let effect: EffectBlock | null = artifact.contract.effect === "commits" ? notSentEffect() : null;

  for (const [name, binding] of Object.entries(sources.bindings)) {
    if (!(name in sources.declared)) continue;
    const got = await deps.secrets.resolve(binding, deps.signal);
    if (got.ok) r.addSecret(name, got.value);
  }

  const captureFiles: string[] = [];
  const evidenceLevel = input.policy.effective.evidence.level;

  const endRun = async (
    status: Result["status"],
    code: string | null,
    result: Result,
    step: string | null,
  ): Promise<ReplayOutcome> => {
    await log.append({ event: "run_end", step, by: "engine", data: { status, code } }, true);
    await finish(folder, deps, r, input, capabilityStr, status, code, result, captureFiles);
    return { runId, result };
  };

  const failEnd = async (
    stepId: string | null,
    failure: StepFailure,
    location: string,
    safeToRetry: boolean,
  ): Promise<ReplayOutcome> => {
    const endedAt = deps.clock.now().toISOString();
    const result = failedResult(runId, capabilityBlock, stepId, failure, location, safeToRetry, captureFiles, startedAt, endedAt, effect);
    return endRun("failed", failure.code, result, stepId);
  };

  if (app === undefined) {
    return failEnd(null, { code: "app_unreachable", phase: "start", message: `${appName} has no bank settings` }, "", true);
  }
  const cfg = {
    origin: app.origin,
    allowlist: buildAllowlist({
      origin: app.origin,
      extraOrigins: app.extra_origins,
      paths: input.policy.effective.paths,
      browser: input.policy.effective.browser,
    }),
    viewport: REPLAY_VIEWPORT,
    locale: app.locale,
    timeZone: app.time_zone,
    visible: input.visible,
  };
  const lease = deps.ids.leaseToken() as unknown as LeaseToken;
  // Owner decision, M05: declared paths are the union of the session and task artifacts' paths.
  const declaredPaths = [...(sessionArtifact?.runs_on.paths ?? []), ...artifact.runs_on.paths];
  const gateRun: GateRun = {
    kind: "replay",
    readOnly: artifact.contract.effect === "read_only",
    forceHuman: false,
    authorizationValid: () => {
      const auth = input.request.authorization;
      return auth !== undefined && Date.parse(auth.expires_at) > deps.clock.now().getTime();
    },
    declaredPaths,
  };
  const opened = await openGate(
    deps.surface,
    cfg,
    {
      policy: input.policy.effective,
      redactor: r,
      run: gateRun,
      lease: () => lease,
      log: (line) => void log.append(line),
      secrets: sources,
      beforeDispatch: async (p): Promise<Outcome<void, "evidence_write_failed">> => {
        const wrote = await log.append(
          { event: "commit_intent", step: p.step, by: "engine", data: { authorization: p.approval !== undefined ? "approved" : "authorized" } },
          true,
        );
        return wrote ? { ok: true, value: undefined } : { ok: false, failure: "evidence_write_failed" };
      },
    },
    deps.signal,
  );
  if (!opened.ok) {
    return failEnd(null, { code: "app_unreachable", phase: "start", message: `could not open the bank app: ${opened.failure}` }, "", true);
  }
  const { eyes, gate } = opened.value;

  try {
    const targets = new Map(artifact.targets.map((t) => [t.id, t]));
    const conditions = new Map(artifact.conditions.map((c) => [c.id, c]));
    const outputs = new Map(artifact.contract.outputs.map((o) => [o.name, o]));
    const refs = new Map(Object.entries(input.request.inputs).map(([k, v]) => [`input.${k}`, String(v)]));

    const captureOnFailure = async (name: string): Promise<void> => {
      if (evidenceLevel === "minimal") return;
      const got = await capture(
        eyes,
        r,
        folder,
        { seq: log.nextSeq, name: name.replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") },
        { screenshot: true, dom: true, a11y: true },
        deps.signal,
      );
      if (got.ok) captureFiles.push(...got.value.files);
    };

    /** Every ladder start saves the masked accessibility snapshot beside the screenshot
     * (docs/decisions.md, M06): no DOM (section 3 §7.5's table names none for this moment). */
    const captureLadderStart = async (name: string): Promise<string[]> => {
      if (evidenceLevel === "minimal") return [];
      const got = await capture(
        eyes,
        r,
        folder,
        { seq: log.nextSeq, name: name.replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") },
        { screenshot: true, dom: false, a11y: true },
        deps.signal,
      );
      if (!got.ok) return [];
      captureFiles.push(...got.value.files);
      return got.value.files;
    };

    // The prelude (section 7 §10), if the artifact links a session capability. `runPreludeAgain`
    // is kept for a `sign_in` handler response later, during the task (section 7 §10, "`sign_in`
    // during the task": "the engine repeats steps 1 to 4 in the same browser").
    const runPreludeAgain = async (signal?: AbortSignal): Promise<boolean> => {
      if (sessionArtifact === null) throw new Error("runLadder: a sign_in response with no session artifact");
      const preludeCtx = {
        eyes,
        gate,
        targets: new Map(sessionArtifact.targets.map((t) => [t.id, t])),
        conditions: new Map(sessionArtifact.conditions.map((c) => [c.id, c])),
        outputs: new Map<string, ContractOutput>(),
        contractOutcomes: sessionArtifact.contract.outcomes,
        refs: undefined,
        redactor: r,
        lease,
        clock: deps.clock,
        ...(signal === undefined ? {} : { signal }),
      };
      const result = await runPrelude(sessionArtifact, preludeCtx);
      return result.kind === "ok";
    };
    if (sessionArtifact !== null) {
      const preludeCtx = {
        eyes,
        gate,
        targets: new Map(sessionArtifact.targets.map((t) => [t.id, t])),
        conditions: new Map(sessionArtifact.conditions.map((c) => [c.id, c])),
        outputs: new Map<string, ContractOutput>(),
        contractOutcomes: sessionArtifact.contract.outcomes,
        refs: undefined,
        redactor: r,
        lease,
        clock: deps.clock,
        ...(deps.signal === undefined ? {} : { signal: deps.signal }),
      };
      const preluded = await runPrelude(sessionArtifact, preludeCtx);
      if (preluded.kind === "failed") {
        await captureOnFailure(`session_${sessionArtifact.identity.capability}_failed`);
        return await failEnd("session:entry", preluded.failure, await currentLocation(eyes), true);
      }
      if (preluded.kind === "outcome") {
        // Never expected: `sign_in` is read_only and declares no outcomes.
        await captureOnFailure("session_unexpected_outcome");
        return await failEnd(
          "session:entry",
          { code: "internal_error", phase: "run", message: `the session artifact declared an unexpected outcome ${preluded.code}` },
          await currentLocation(eyes),
          true,
        );
      }
    }

    // Step 6 (section 7 §4): supervised mode pauses here, after the prelude and before the
    // task's own steps, for a start confirmation. Unattended never reaches this point (check 7
    // always rejects it, above), but the mode check stays so the step reads on its own.
    if (input.request.mode === "supervised") {
      const opening = deps.clock.now().toISOString();
      await log.append({
        event: "escalation",
        step: null,
        by: "engine",
        data: { kind: "start_confirmation", reason: "supervised_mode", state: "open" },
      });
      // Why an index line: `operator list` finds an open request by the tenant index's last
      // status (section 9 §10.4), the same way discovery already marks itself escalated.
      await deps.evidence.appendIndex(
        input.tenant,
        r.value({ run_id: fact(runId), at: fact(opening), status: "escalated", code: null, kind: "replay", capability: capabilityStr }),
        deps.signal,
      );
      const confirmation = new OperatorSupervisor(deps.operator({ runId, tenant: input.tenant }), deps.clock, r, {
        runId,
        tenant: input.tenant,
        capability: capabilityStr,
        // Why a fallback of 15: section 7 §13.3's own default for this deadline.
        deadlineMinutes: input.policy.effective.escalation.start_confirmation_minutes ?? 15,
      });
      const confirmed = await confirmation.startConfirmation(deps.signal);
      await log.append({
        event: "escalation",
        step: null,
        by: confirmed.kind === "approved" || confirmed.kind === "declined" ? "human" : "engine",
        data: {
          kind: "start_confirmation",
          reason: "supervised_mode",
          state: confirmed.kind === "timed_out" ? "timed_out" : confirmed.kind === "run_ended" ? "run_ended" : "resolved",
          decision: confirmed.kind === "approved" ? "approved" : confirmed.kind === "declined" ? "declined" : null,
          ...("staff" in confirmed ? { staff_id: confirmed.staff } : {}),
        },
      });
      await deps.evidence.appendIndex(
        input.tenant,
        r.value({ run_id: fact(runId), at: fact(deps.clock.now().toISOString()), status: "running", code: null, kind: "replay", capability: capabilityStr }),
        deps.signal,
      );
      if (confirmed.kind !== "approved") {
        await captureOnFailure("start_confirmation_failed");
        const code = confirmed.kind === "timed_out" ? "escalation_timeout" : "ended_by_operator";
        const message =
          confirmed.kind === "timed_out"
            ? "the start confirmation timed out"
            : "the operator declined to start the run";
        return await failEnd(null, { code, phase: "escalation", message }, await currentLocation(eyes), true);
      }
    }

    const navToTask = await gate.act(
      { actor: "engine", lease, action: { type: "navigate", to: artifact.runs_on.entry }, step: "entry" },
      deps.signal,
    );
    if (!navToTask.ok || navToTask.value.decision !== "allowed" || navToTask.value.act?.dispatched === false) {
      await captureOnFailure("entry_failed");
      return await failEnd("entry", { code: "app_unreachable", phase: "start", message: "could not navigate to the task's entry" }, await currentLocation(eyes), true);
    }

    const outputsOut = new Map<string, { raw: string; type: ContractOutput["type"] }>();

    // The error ladder (section 5 §8), rung 1. `frozenSet` is the merged handler set for this
    // run (section 5 §7.4); a run with none behaves as an empty set, not an error
    // (docs/decisions.md, M06). Claiming a takeover (rung 4 for real) is task 4's own work: a
    // `climb` or `needs_human` verdict here falls back to the pre-M06 hard failure, so this
    // seam is a one-line change away from a real rung 4 (docs/decisions.md, M06).
    const frozen = input.frozenSet ?? EMPTY_FROZEN_SET;
    const packCtx: EvalCtx = {
      targets: new Map(frozen.targets.map((t) => [t.id, t])),
      conditions: new Map(frozen.conditions.map((c) => [c.id, c])),
    };
    const packTargets = new Map(frozen.targets.map((t) => [t.id, t]));
    const ladderSteps: LadderStep[] = artifact.steps.map((s) => ({
      id: s.id,
      precondition: s.precondition,
      checkpoint: s.checkpoint,
      risk: s.risk,
    }));
    const retriesUsedByStep = new Map<string, number>();
    const handlerAttemptsByStep = new Map<string, Record<string, number>>();
    let handlerAttemptsRun = 0;
    let signInRunsUsed = 0;
    let ladderEntriesUsed = 0;
    let rewindsUsed = 0;
    let lastGoodPath = pathAndQuery(artifact.runs_on.entry);
    const recoveries: RecoveryLine[] = [];

    /** One `runLadder` call for `step`'s trouble, and the counters that go with it. `stepIndex`
     * is the failed step's own index in `artifact.steps` (section 5 §8.6's search range). */
    const attemptLadder = async (
      stepIndex: number,
      step: Step,
      failure: StepFailure,
    ): Promise<{ kind: "resume"; index: number } | { kind: "end"; outcome: ReplayOutcome }> => {
      const startFiles = await captureLadderStart(`${step.id}_ladder`);
      const dispatched = failure.phase === "checkpoint";
      const ladderResult = await runLadder(
        {
          stepId: step.id,
          stepIndex,
          steps: ladderSteps,
          floorIndex: 0,
          trouble: {
            code: failure.code,
            message: failure.message,
            // Why the cast: the caller already checked `failure.phase` is one of these three
            // before calling `attemptLadder` (section 5 §8.1: a gate or extract failure never
            // reaches here).
            phase: failure.phase as "precondition" | "target" | "checkpoint",
            risk: step.risk,
            dispatched,
            // Section 7 §7.3: only a real dispatch (checkpoint phase) can carry one.
            transportEvent: dispatched ? (failure.transportEvent ?? null) : null,
            ambiguous: failure.code === "target_ambiguous",
          },
          captureFiles: startFiles,
          stepOutcomes: artifact.contract.outcomes.filter((o) => step.outcomes.includes(o.code)),
          limits: {
            retriesUsedThisStep: retriesUsedByStep.get(step.id) ?? 0,
            handlerAttemptsThisStep: handlerAttemptsByStep.get(step.id) ?? {},
            handlerAttemptsThisRun: handlerAttemptsRun,
            signInRunsUsed,
            ladderEntriesUsed,
            rewindsUsed,
          },
        },
        {
          eyes,
          gate,
          clock: deps.clock,
          redactor: r,
          lease,
          log: (line) => void log.append(line),
          taskCtx: { targets, conditions, refs },
          packCtx,
          frozen,
          packTargets,
          lastGoodPath,
          runPrelude: runPreludeAgain,
          ...(deps.signal === undefined ? {} : { signal: deps.signal }),
        },
      );
      ladderEntriesUsed += 1;

      if (ladderResult.kind === "business_outcome") {
        const declared = artifact.contract.outcomes.find((o) => o.code === ladderResult.code);
        const endedAt = deps.clock.now().toISOString();
        const result = Result.parse({
          schema: "intyy.result/1.0",
          run_id: runId,
          request_id: input.request.request_id,
          capability: capabilityBlock,
          warnings: [],
          recoveries,
          interventions: [],
          timing: { started_at: startedAt, ended_at: endedAt, duration_ms: 0, human_ms: 0 },
          evidence: `runs/${runId}`,
          status: "business_outcome",
          outcome: { code: ladderResult.code, description: declared?.description ?? ladderResult.code, step: step.id, decided_by: "code", set_by: null },
          ...(effect === null ? {} : { effect }),
        });
        return { kind: "end", outcome: await endRun("business_outcome", ladderResult.code, result, step.id) };
      }

      if (ladderResult.kind === "hard_failure") {
        await captureOnFailure(`${step.id}_failed`);
        const endedAt = deps.clock.now().toISOString();
        const result = failedResult(
          runId,
          capabilityBlock,
          step.id,
          { code: ladderResult.code as StepFailure["code"], phase: failure.phase, message: ladderResult.message },
          await currentLocation(eyes),
          true,
          captureFiles,
          startedAt,
          endedAt,
          effect,
        );
        if (result.status === "failed") {
          result.failure.ladder = { rung: 1, verdict: "hard_failure", ref: ladderResult.ladderRef };
          result.failure.transient = ladderResult.transient;
          result.recoveries = recoveries;
        }
        return { kind: "end", outcome: await endRun("failed", ladderResult.code, result, step.id) };
      }

      if (ladderResult.kind === "climb" || ladderResult.kind === "needs_human") {
        // Rung 4 is a stub in M06 (docs/decisions.md): fall back to the pre-M06 behavior.
        await captureOnFailure(`${step.id}_failed`);
        return { kind: "end", outcome: await failEnd(step.id, failure, await currentLocation(eyes), true) };
      }

      // ladderResult.kind === "recovered"
      if (ladderResult.recovery.via === "retry") {
        retriesUsedByStep.set(step.id, (retriesUsedByStep.get(step.id) ?? 0) + 1);
      } else {
        const handlerId = ladderResult.recovery.ref;
        const perStep = handlerAttemptsByStep.get(step.id) ?? {};
        handlerAttemptsByStep.set(step.id, { ...perStep, [handlerId]: (perStep[handlerId] ?? 0) + 1 });
        handlerAttemptsRun += 1;
        const used = frozen.handlers.find((h) => h.id === handlerId);
        if (used?.class === "recoverable" && used.response.some((a) => a.type === "sign_in")) signInRunsUsed += 1;
      }
      if (ladderResult.index !== stepIndex) rewindsUsed += 1;
      recoveries.push({
        step: step.id,
        rung: 1,
        via: ladderResult.recovery.via,
        ref: ladderResult.recovery.ref,
        resumed_at: ladderResult.log.resume_at ?? step.id,
        at: deps.clock.now().toISOString(),
      });
      return { kind: "resume", index: ladderResult.index };
    };

    let stepIndex = 0;
    while (stepIndex < artifact.steps.length) {
      const step = artifact.steps[stepIndex];
      if (step === undefined) break;
      if (isAborted(deps.signal)) {
        return await failEnd(null, { code: "ended_by_operator", phase: "run", message: "the operator ended the run" }, await currentLocation(eyes), true);
      }

      const isCommit = artifact.recovery?.commit_point === step.id;
      if (!isCommit) {
        const stepCtx: StepRunnerContext = {
          eyes,
          gate,
          targets,
          conditions,
          outputs,
          contractOutcomes: artifact.contract.outcomes,
          refs,
          redactor: r,
          lease,
          clock: deps.clock,
          logPrefix: "",
          ...(deps.signal === undefined ? {} : { signal: deps.signal }),
        };
        const outcome = await runStep(step, stepCtx);
        if (outcome.kind === "failed") {
          if (outcome.failure.phase !== "precondition" && outcome.failure.phase !== "target" && outcome.failure.phase !== "checkpoint") {
            // Section 5 §8.1: a gate block or an extract failure never starts the ladder.
            await captureOnFailure(`${step.id}_failed`);
            return await failEnd(step.id, outcome.failure, await currentLocation(eyes), true);
          }
          const attempted = await attemptLadder(stepIndex, step, outcome.failure);
          if (attempted.kind === "end") return attempted.outcome;
          stepIndex = attempted.index;
          continue;
        }
        if (outcome.kind === "outcome") {
          const declared = artifact.contract.outcomes.find((o) => o.code === outcome.code);
          const endedAt = deps.clock.now().toISOString();
          const result = Result.parse({
            schema: "intyy.result/1.0",
            run_id: runId,
            request_id: input.request.request_id,
            capability: capabilityBlock,
            warnings: [],
            recoveries,
            interventions: [],
            timing: { started_at: startedAt, ended_at: endedAt, duration_ms: 0, human_ms: 0 },
            evidence: `runs/${runId}`,
            status: "business_outcome",
            outcome: { code: outcome.code, description: declared?.description ?? outcome.code, step: step.id, decided_by: "code", set_by: null },
            ...(effect === null ? {} : { effect }),
          });
          return await endRun("business_outcome", outcome.code, result, step.id);
        }
        if (outcome.read !== undefined) {
          const out = outputs.get(outcome.read.output);
          if (out !== undefined) outputsOut.set(outcome.read.output, { raw: outcome.read.raw, type: out.type });
        }
        const loc = await currentLocation(eyes);
        if (loc !== "") lastGoodPath = pathAndQuery(loc);
        stepIndex += 1;
        continue;
      }

      // The commit step: precondition first, then the commit path (section 7 §4 point 7).
      const evalCtx: EvalCtx = { targets, conditions, refs };
      const pre2 = await waitForCondition({ check: "ref", ref: step.precondition }, eyes, evalCtx, PRECONDITION_TIMEOUT_MS, deps.clock, deps.signal);
      if (!pre2.ok || pre2.value.answer !== "true") {
        await captureOnFailure(`${step.id}_failed`);
        return await failEnd(step.id, { code: "precondition_failed", phase: "precondition", message: `commit step ${step.id}'s precondition never became true` }, await currentLocation(eyes), true);
      }
      const observed = await eyes.observe(deps.signal);
      if (!observed.ok) {
        await captureOnFailure(`${step.id}_failed`);
        return await failEnd(step.id, { code: "session_lost", phase: "target", message: "the screen went away just before the commit" }, "", true);
      }

      // The pre-commit sweep (section 5 §8.3): just before the commit action, every frozen
      // detector runs once on the live screen. Nothing is in flight yet, so the window is open;
      // a match goes through the same ladder as an ordinary step's trouble, at phase
      // `precondition` (a business outcome here ends with the commit still `not_sent`, since
      // `effect` has not changed yet).
      const sweepMatched = matchDetectors(frozen.handlers, fromObservation(observed.value), packCtx);
      if (sweepMatched.length > 0) {
        for (const id of sweepMatched) {
          void log.append({ event: "check", step: step.id, by: "engine", data: { condition: id, role: "sweep", passed: true } });
        }
        const swept = await attemptLadder(stepIndex, step, {
          code: "precondition_failed",
          phase: "precondition",
          message: "the pre-commit sweep found a known interruption",
        });
        if (swept.kind === "end") return swept.outcome;
        stepIndex = swept.index;
        continue;
      }

      const approval: CommitApproval = {
        ask: (ask, signal) =>
          new OperatorSupervisor(deps.operator({ runId, tenant: input.tenant }), deps.clock, r, {
            runId,
            tenant: input.tenant,
            capability: capabilityStr,
            deadlineMinutes: input.policy.effective.escalation.approval_minutes ?? 5,
          }).commitApproval(ask, signal),
      };
      const commitCtx: CommitContext = {
        observation: observed.value,
        eyes,
        targets,
        conditions,
        outputs,
        refs,
        redactor: r,
        gate,
        lease,
        clock: deps.clock,
        approval,
        screenshot: null,
      };
      // Why no signal: never abort between commit_intent and the commit step's end.
      const committed = await commitStep(step, artifact.contract.outcomes, commitCtx);
      if (committed.kind !== "effect") {
        await captureOnFailure(`${step.id}_failed`);
        const code = committed.kind === "evidence_write_failed" ? "evidence_write_failed" : "action_failed";
        return await failEnd(step.id, { code, phase: "action", message: `commit step ${step.id} failed: ${committed.kind}` }, await currentLocation(eyes), false);
      }
      // Why update here: the commit path just ran; every result from now on reports what it
      // actually did, not the `not_sent` starting guess (section 3 §5.8).
      effect = committed.effect;
      if (effect.commit === "refused") {
        if (committed.race?.winner !== "outcome") {
          throw new Error("commitStep: refused with no winning outcome");
        }
        const code = committed.race.code;
        const declared = artifact.contract.outcomes.find((o) => o.code === code);
        const endedAt = deps.clock.now().toISOString();
        const result = Result.parse({
          schema: "intyy.result/1.0",
          run_id: runId,
          request_id: input.request.request_id,
          capability: capabilityBlock,
          warnings: [],
          recoveries,
          interventions: [],
          timing: { started_at: startedAt, ended_at: endedAt, duration_ms: 0, human_ms: 0 },
          evidence: `runs/${runId}`,
          status: "business_outcome",
          outcome: { code, description: declared?.description ?? code, step: step.id, decided_by: "code", set_by: null },
          effect,
        });
        return await endRun("business_outcome", code, result, step.id);
      }
      if (effect.commit !== "confirmed") {
        await captureOnFailure(`${step.id}_failed`);
        return await failEnd(step.id, { code: "action_failed", phase: "action", message: `commit step ${step.id} ended ${effect.commit}` }, await currentLocation(eyes), safeToRetryOf(effect));
      }
      if (isAborted(deps.signal)) {
        const endedAt = deps.clock.now().toISOString();
        const result = Result.parse({
          schema: "intyy.result/1.0",
          run_id: runId,
          request_id: input.request.request_id,
          capability: capabilityBlock,
          warnings: [],
          recoveries: [],
          interventions: [],
          timing: { started_at: startedAt, ended_at: endedAt, duration_ms: 0, human_ms: 0 },
          evidence: `runs/${runId}`,
          status: "failed",
          effect,
          failure: {
            code: "ended_by_operator",
            message: "the operator ended the run right after the commit",
            step: step.id,
            phase: "run",
            expected: { condition: "run", description: "the operator ended the run" },
            observed: { location: await currentLocation(eyes), checks: [] },
            attempts: 0,
            ladder: { rung: 0, verdict: "hard_failure", ref: "run" },
            transient: false,
            safe_to_retry: safeToRetryOf(effect),
            files: [...captureFiles],
          },
        });
        return await endRun("failed", "ended_by_operator", result, step.id);
      }
      const loc = await currentLocation(eyes);
      if (loc !== "") lastGoodPath = pathAndQuery(loc);
      stepIndex += 1;
    }

    const endedAt = deps.clock.now().toISOString();
    const outs: Record<string, ContractValue> = {};
    for (const [name, v] of outputsOut) {
      outs[name] = v.type === "integer" ? Number(v.raw) : v.type === "boolean" ? v.raw === "true" : v.raw;
    }
    const result = Result.parse({
      schema: "intyy.result/1.0",
      run_id: runId,
      request_id: input.request.request_id,
      capability: capabilityBlock,
      warnings: [],
      recoveries,
      interventions: [],
      timing: { started_at: startedAt, ended_at: endedAt, duration_ms: 0, human_ms: 0 },
      evidence: `runs/${runId}`,
      status: "success",
      outputs: outs,
      ...(effect === null ? {} : { effect }),
    });
    return await endRun("success", null, result, null);
  } finally {
    await gate.close();
  }
}
