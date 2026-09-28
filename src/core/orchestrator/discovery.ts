// The discovery run lifecycle: pre-run checks, frozen facts, `run_start`, the browser behind
// the gate, the loop, and the end. Follows design section 6 §4 (discovery in one view), §6
// (run spec), §7.2 (checks at run start), §10.4 (how a run ends), section 3 §4.8 (pre-run checks),
// §6.4 and §6.5 (event types, frozen facts), §7.1 (evidence layout), and section 4 §10.6.
import type { Clock, Ids } from "../../ports/clock.js";
import type { Marker } from "../../ports/marker.js";
import type { OperatorPort } from "../../ports/operator.js";
import type { Planner } from "../../ports/models.js";
import type { Secrets } from "../../ports/secrets.js";
import type { EvidenceStore, RunFolder } from "../../ports/stores.js";
import type { LeaseToken, SurfaceFactory, Viewport } from "../../ports/surface.js";
import { runLoop, type LoopEnd } from "../discovery/loop.js";
import { OperatorSupervisor } from "../discovery/supervisor.js";
import { PROMPTS } from "../discovery/prompts/index.js";
import { checkSpec } from "../discovery/spec-checks.js";
import { taskView } from "../discovery/task-view.js";
import type { HeldInput } from "../discovery/tools.js";
import { fullLimits, type RunSpec } from "../model/runspec.js";
import type { Settings } from "../model/settings.js";
import { openGate } from "../safety/gate/gate.js";
import { buildAllowlist } from "../safety/policy/allowlist.js";
import type { MergeResult } from "../safety/policy/merge.js";
import { fact, Redactor, redactionRules } from "../safety/redaction/redactor.js";
import { startCheck, type SecretSources } from "../safety/secrets/injector.js";
import { RunLog } from "./run-log.js";

/** The browser window size for discovery. Fixed, so boxes and crops stay comparable. */
export const DISCOVERY_VIEWPORT: Viewport = { width: 1280, height: 800 };

/** What one discovery run starts from. The CLI loads and checks each file first. */
export type DiscoveryInput = {
  spec: RunSpec;
  tenant: string;
  /** The operator who started it. */
  staff: string;
  /** The merged approved policy for this tenant and app. */
  policy: MergeResult;
  settings: { doc: Settings; rev: string; hash: string };
  engineVersion: string;
  /** Reserved member numbers (`canary_members` in `intyy.json`). A spec may not use them. */
  canaries: readonly string[];
  /** Show the browser window. Discovery is supervised (section 6 §4); tests run headless. */
  visible: boolean;
};

/** The ports one discovery run uses. */
export type DiscoveryDeps = {
  evidence: EvidenceStore;
  clock: Clock;
  ids: Ids;
  secrets: Secrets;
  surface: SurfaceFactory;
  marker: Marker;
  planner: Planner;
  /** The operator port for this run. The mailbox lives in the run folder (section 9 §10.5). */
  operator: (run: { runId: string; tenant: string }) => OperatorPort;
  signal?: AbortSignal;
};

/** How the run ended. `runId` is set even for a rejected run (section 3 §4.8). */
export type DiscoveryResult = {
  runId: string;
  status: LoopEnd["status"] | "rejected";
  code: string | null;
  /** The pre-run problems, one line each, for a rejected or failed start. */
  problems: string[];
};

/** One pre-run check's result, as the `precheck` line records it. */
type Check = { check: string; passed: boolean; detail?: string };

/** True when a capability pattern like `kvfcu/*@1` names this app and capability, any major. */
function patternNames(pattern: string, app: string, capability: string): boolean {
  if (pattern === "*") return true;
  const [name = ""] = pattern.split("@");
  const [pa = "", pc = ""] = name.split("/");
  const part = (p: string, v: string): boolean =>
    new RegExp(`^${p.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`).test(v);
  return part(pa, app) && part(pc, capability);
}

/**
 * The pre-run checks for discovery, in order (section 3 §4.8, section 6 §7.2). Checks 1 to 3
 * reject; the secret check fails the run instead, as check 10 does.
 */
async function prechecks(
  input: DiscoveryInput,
  deps: DiscoveryDeps,
  sources: SecretSources,
): Promise<{ checks: Check[]; code: string | null; status: "rejected" | "failed" | null }> {
  const { spec, policy } = input;
  const app = input.settings.doc.apps[spec.app];
  const checks: Check[] = [];
  const add = (check: string, problems: string[]): boolean => {
    const passed = problems.length === 0;
    checks.push(passed ? { check, passed } : { check, passed, detail: problems.join("\n") });
    return passed;
  };

  const today = new Intl.DateTimeFormat("en-CA", { timeZone: app?.time_zone ?? "UTC" }).format(
    deps.clock.now(),
  );
  const report = checkSpec(spec, {
    today,
    canaries: input.canaries,
    labels: policy.effective.redaction.labels,
    environment: app?.environment ?? null,
  });
  const scope: string[] = [];
  // Why: M05 builds the sign-in prelude. Until then only a session capability itself runs.
  if (spec.session !== null) scope.push("session: a linked session capability runs from M05");
  if (spec.entry !== "/") scope.push("entry: only / until M05 builds the prelude");
  const specOk = add("spec", [...report.problems, ...scope]);

  const denied: string[] = [];
  for (const m of policy.missing) denied.push(`policy layer ${m} has no approved revision`);
  const envs = policy.effective.discovery.environments ?? "test";
  // Why: section 4 §10.6, discovery runs on test apps unless the bank opts in.
  if (app !== undefined && ![envs].flat().includes(app.environment))
    denied.push(`discovery is not allowed on a ${app.environment} app`);
  const caps = policy.effective.capabilities;
  if (!caps.allow.some((p) => patternNames(p, spec.app, spec.capability)))
    denied.push(`capability_not_allowed: tenant does not list ${spec.app}/${spec.capability}`);
  if (caps.deny.some((p) => patternNames(p, spec.app, spec.capability)))
    denied.push(`capability_denied: a deny rule names ${spec.app}/${spec.capability}`);
  const policyOk = add("policy", denied);

  if (!specOk) return { checks, code: "invalid_request", status: "rejected" };
  if (!policyOk) return { checks, code: "policy_denied", status: "rejected" };
  const got = await startCheck(Object.keys(sources.declared), sources, deps.signal);
  if (!add("secrets", got.ok ? [] : [got.detail ?? "a secret has no value"]))
    return { checks, code: "secret_unavailable", status: "failed" };
  return { checks, code: null, status: null };
}

/** The frozen facts for a discovery `run_start` line (section 3 §6.5, discovery form). */
function frozenFacts(input: DiscoveryInput, runKind: "discovery"): unknown {
  const { spec, policy, settings } = input;
  const app = settings.doc.apps[spec.app];
  const masks: Record<string, string> = {};
  for (const i of spec.inputs) {
    // Why: section 3 §6.5, `[pii]` and `[financial]` are the final mask for run_start inputs.
    masks[i.name] = i.sensitivity === "none" ? `{input.${i.name}}` : `[${i.sensitivity}]`;
  }
  const limits = fullLimits(spec);
  return {
    schema: "intyy.log/1.0",
    kind: runKind,
    parent_run_id: null,
    purpose: null,
    batch_id: null,
    request_id: null,
    tenant: input.tenant,
    agent_id: input.staff,
    mode: "supervised",
    inputs: masks,
    authorization: null,
    frozen: {
      artifact: null,
      patch: null,
      session: null,
      app_version: app?.app_version ?? null,
      engine_version: input.engineVersion,
      policy: { layers: policy.layers, hash: fact(policy.hash) },
      settings: { revision: Number(settings.rev), hash: fact(settings.hash) },
      evidence_level: policy.effective.evidence.level,
      spec: {
        kind: spec.kind,
        capability: spec.capability,
        goal: spec.goal,
        inputs: masks,
        outputs: spec.outputs.map((o) => o.name),
        expected_effect: spec.expected_effect,
        correlation: spec.correlation ?? null,
        session: spec.session,
        entry: spec.entry,
        limits,
      },
      models: { discovery: spec.model, prompt: spec.prompt },
    },
    fault_profile: null,
  };
}

/** The known value for one input (section 4 §9.6). The kind names the token for short values. */
function knownInput(i: RunSpec["inputs"][number]): Parameters<Redactor["addKnown"]>[0] {
  const type = i.type === "money" ? "money" : i.type === "date" ? "date" : "text";
  const kind =
    i.sensitivity === "financial" || i.type === "money"
      ? "money"
      : i.type === "date"
        ? "dob"
        : "member";
  return { ref: `input.${i.name}`, value: i.example, label: i.sensitivity, type, kind };
}

/** Writes `run.json` and the index line for the end state. */
async function finish(
  folder: RunFolder,
  deps: DiscoveryDeps,
  r: Redactor,
  input: DiscoveryInput,
  facts: {
    startedAt: string;
    status: DiscoveryResult["status"];
    code: string | null;
    loop: LoopEnd | null;
  },
): Promise<void> {
  const at = deps.clock.now().toISOString();
  await folder.writeRunJson(
    r.value({
      schema: "intyy.run/1.0",
      run_id: fact(folder.runId),
      tenant: input.tenant,
      kind: "discovery",
      capability: `${input.spec.app}/${input.spec.capability}`,
      status: facts.status,
      code: facts.code,
      started_at: fact(facts.startedAt),
      ended_at: fact(at),
      counts:
        facts.loop === null
          ? null
          : {
              turns: facts.loop.turns,
              actions: facts.loop.actions,
              blocked: facts.loop.blocked,
              invalid: facts.loop.invalid,
            },
    }),
    deps.signal,
  );
  await deps.evidence.appendIndex(
    input.tenant,
    r.value({
      run_id: fact(folder.runId),
      at: fact(at),
      status: facts.status,
      code: facts.code,
      kind: "discovery",
      capability: `${input.spec.app}/${input.spec.capability}`,
    }),
    deps.signal,
  );
}

/**
 * Runs one discovery (section 6 §4). A rejected run still gets a run ID and three log lines:
 * `run_start`, `precheck`, `run_end` (section 3 §6.4). The browser opens only after every check.
 */
export async function runDiscovery(
  input: DiscoveryInput,
  deps: DiscoveryDeps,
): Promise<DiscoveryResult> {
  const { spec, policy } = input;
  const prompt = PROMPTS[spec.prompt];
  const app = input.settings.doc.apps[spec.app];
  const runId = deps.ids.runId();
  const created = await deps.evidence.createRun(input.tenant, runId, deps.signal);
  if (!created.ok) return { runId, status: "failed", code: "evidence_write_failed", problems: [] };
  const folder = created.value;
  const r = new Redactor(redactionRules(policy.effective));
  for (const i of spec.inputs) r.addKnown(knownInput(i));
  const log = new RunLog(folder, r, deps.clock);
  const startedMs = deps.clock.now().getTime();
  const startedAt = deps.clock.now().toISOString();
  const capability = `${spec.app}/${spec.capability}`;
  await deps.evidence.appendIndex(
    input.tenant,
    r.value({
      run_id: fact(runId),
      at: fact(startedAt),
      status: "running",
      code: null,
      kind: "discovery",
      capability,
    }),
    deps.signal,
  );
  await log.append(
    { event: "run_start", step: null, by: "engine", data: frozenFacts(input, "discovery") },
    true,
  );

  const sources: SecretSources = {
    declared: policy.effective.secrets,
    bindings: app?.secrets ?? {},
    port: deps.secrets,
  };
  const pre = await prechecks(input, deps, sources);
  await log.append({ event: "precheck", step: null, by: "engine", data: { checks: pre.checks } });
  if (pre.status !== null || prompt === undefined || app === undefined) {
    const status = pre.status ?? "rejected";
    const code = pre.code ?? "invalid_request";
    await log.append({ event: "run_end", step: null, by: "engine", data: { status, code } }, true);
    await finish(folder, deps, r, input, { startedAt, status, code, loop: null });
    const problems = pre.checks
      .filter((c) => !c.passed)
      .flatMap((c) => (c.detail ?? "").split("\n"));
    return { runId, status, code, problems };
  }

  const cfg = {
    origin: app.origin,
    allowlist: buildAllowlist({
      origin: app.origin,
      extraOrigins: app.extra_origins,
      paths: policy.effective.paths,
      browser: policy.effective.browser,
    }),
    viewport: DISCOVERY_VIEWPORT,
    locale: app.locale,
    timeZone: app.time_zone,
    visible: input.visible,
  };
  // ponytail: one fixed lease token per run; M07 builds real leases and takeovers.
  const lease = deps.ids.leaseToken() as unknown as LeaseToken;
  const opened = await openGate(
    deps.surface,
    cfg,
    {
      policy: policy.effective,
      redactor: r,
      run: {
        kind: "discovery",
        readOnly: spec.expected_effect === "read_only",
        forceHuman: false,
        authorizationValid: () => false,
        declaredPaths: null,
      },
      lease: () => lease,
      log: (line) => void log.append(line),
      secrets: sources,
    },
    deps.signal,
  );
  if (!opened.ok) {
    const code = "app_unreachable";
    await log.append(
      { event: "run_end", step: null, by: "engine", data: { status: "failed", code } },
      true,
    );
    await finish(folder, deps, r, input, { startedAt, status: "failed", code, loop: null });
    return { runId, status: "failed", code, problems: [opened.failure] };
  }
  const { eyes, gate } = opened.value;
  await log.append({
    event: "session",
    step: null,
    by: "engine",
    data: { state: "open", location: "/" },
  });

  const inputs = new Map<string, HeldInput>(
    spec.inputs.map((i) => [i.name, { value: i.example, type: i.type, label: i.sensitivity }]),
  );
  let loop: LoopEnd;
  try {
    loop = await runLoop({
      eyes,
      gate,
      marker: deps.marker,
      planner: deps.planner,
      supervisor: new OperatorSupervisor(
        deps.operator({ runId, tenant: input.tenant }),
        deps.clock,
        r,
        {
          runId,
          tenant: input.tenant,
          capability,
          // Why a fallback of 5: a missing bound counts as its strictest value (M01 decision).
          deadlineMinutes: policy.effective.escalation.approval_minutes ?? 5,
        },
      ),
      redactor: r,
      clock: deps.clock,
      log,
      folder,
      prompt,
      spec,
      limits: fullLimits(spec),
      system: prompt.system(taskView(spec, r, Object.keys(policy.effective.secrets))),
      inputs,
      runId,
      formats: policy.effective.formats,
      lease,
      sendScreenshots: policy.effective.llm.send_screenshots,
      status: async (s) => {
        await deps.evidence.appendIndex(
          input.tenant,
          r.value({
            run_id: fact(runId),
            at: fact(deps.clock.now().toISOString()),
            status: s,
            code: null,
            kind: "discovery",
            capability,
          }),
          deps.signal,
        );
      },
      ...(deps.signal === undefined ? {} : { signal: deps.signal }),
    });
  } finally {
    await gate.close();
  }
  await log.append({ event: "session", step: null, by: "engine", data: { state: "closed" } });
  const counts = {
    turns: loop.turns,
    actions: loop.actions,
    blocked: loop.blocked,
    invalid: loop.invalid,
    commits: loop.commits,
  };
  const wall = deps.clock.now().getTime() - startedMs;
  await log.append(
    {
      event: "run_end",
      step: null,
      by: "engine",
      data: {
        status: loop.status,
        code: loop.code,
        counts,
        durations: { wall_ms: wall, human_ms: loop.humanMs },
      },
    },
    true,
  );
  await finish(folder, deps, r, input, { startedAt, status: loop.status, code: loop.code, loop });
  return { runId, status: loop.status, code: loop.code, problems: [] };
}
