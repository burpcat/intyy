// The caller-request pre-run checks (section 3 §4.8): ten checks, in order. No browser opens
// until every check passes. Checks 6 to 9 each collect every problem they find before the
// pipeline stops, so a caller fixes them all in one pass (§4.8: "Checks 6 to 9 report every
// problem at once"). `patternNames` is shared with discovery's own checks (section 6 §7.2), so
// one capability-pattern rule serves both request kinds.
//
// Check 7 is thin (M05 spec): no score store exists yet (M10). Every context counts as
// `draft`, so an unattended request is always rejected; a supervised request always passes
// this check (the start confirmation, and the commit approval, come later).
//
// Check 3 (a repeat request ID) uses the real request index (section 3 §4.4); the entry is
// written only once checks 1 to 9 pass, just before check 10 (docs/decisions.md, M05). Checks
// 4 and 5 use the real, app-version-aware resolver (`resolveMajor` in `catalog/capabilities.ts`),
// injected as a plain function so this module never imports a store port directly.
import type { ArtifactStore } from "../catalog/artifacts.js";
import { resolveExact, resolveMajor } from "../catalog/capabilities.js";
import type { Artifact } from "../model/artifact.js";
import { scanRefs } from "../model/artifact-checks-shared.js";
import type { Contract, ContractInput } from "../model/artifact/contract.js";
import { ContractValue } from "../model/common.js";
import { Request } from "../model/request.js";
import type { Mode } from "../model/request.js";
import type { FailureCode, RejectionCode } from "../model/result.js";
import type { EffectivePolicy } from "../safety/policy/merge.js";
import { requestIndexOps, type RequestIdLookup, type RequestIndexDeps } from "./request-index.js";
import { startCheck, type SecretSources } from "../safety/secrets/injector.js";
import { type Outcome } from "../../ports/outcome.js";

/**
 * True when a capability pattern like `kvfcu/*@1` names this app, capability, and (when given)
 * a major version. Discovery calls this with no `major`, so every major matches, unchanged
 * since M03 (section 6 §7.2). Replay's check 9 passes its request's major.
 */
export function patternNames(pattern: string, app: string, capability: string, major?: number): boolean {
  if (pattern === "*") return true;
  const [name = "", patternMajor] = pattern.split("@");
  const [pa = "", pc = ""] = name.split("/");
  const part = (p: string, v: string): boolean =>
    new RegExp(`^${p.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`).test(v);
  if (!part(pa, app) || !part(pc, capability)) return false;
  if (major === undefined) return true;
  return patternMajor === "*" || Number(patternMajor) === major;
}

/** Splits `app/capability@major`. The request schema already enforces this shape, so a
 * mismatch here is a bug (only bugs throw, per CLAUDE.md). */
function splitCapabilityLink(link: string): { app: string; capability: string; major: number } {
  const m = /^([a-z][a-z0-9_-]*)\/([a-z][a-z0-9_]*)@([1-9]\d*)$/.exec(link);
  if (m?.[1] === undefined || m[2] === undefined || m[3] === undefined) {
    throw new Error(`splitCapabilityLink: ${link} does not fit app/capability@major`);
  }
  return { app: m[1], capability: m[2], major: Number(m[3]) };
}

/** One rejection error, in the shape `intyy.result/1.0`'s `rejection.errors` records
 * (section 3 §5.6). */
export type PrecheckError = { code: RejectionCode; field?: string; reason?: string; message: string };

/** One check's outcome, for the run log the M05 test gate asks every rejected run to keep
 * ("a rejected request still gets a run ID and a short log", section 3 §4.8). */
export type PrecheckResult = { check: string; passed: boolean; errors: PrecheckError[] };

/**
 * Builds the injected `resolve` function from the real catalog resolver (section 9 §7.2,
 * section 3 §4.8 checks 4 and 5). With no `appVersion`, only existence matters (check 4); with
 * one, the newest sealed version that fits it wins, or nothing does (check 5). A store
 * inconsistency (`"invalid"`) is folded into "not found" too — a known simplification for the
 * minimal M05 resolver; a corrupted sealed artifact should really surface as `internal_error`.
 */
export function catalogResolve(store: ArtifactStore, pin?: string): PrecheckInput["resolve"] {
  // Why: a certify run's `pin` is the exact key under test (section 3 §4.9); the task's own
  // capability then resolves to that sealed version, never the newest of its major.
  const pinned = pin === undefined ? null : /^([a-z][a-z0-9_-]*)\/([a-z][a-z0-9_]*)@((\d+)\.\d+\.\d+)$/.exec(pin);
  return async (app, capability, major, appVersion) => {
    if (pinned?.[1] === app && pinned[2] === capability && Number(pinned[4]) === major && pinned[3] !== undefined) {
      const exact = await resolveExact(store, app, capability, pinned[3], appVersion);
      return exact.ok ? exact.value : undefined;
    }
    const found = await resolveMajor(store, app, capability, major, appVersion);
    return found.ok ? found.value : undefined;
  };
}

/**
 * Builds the injected `lookupRequest`/`recordRequest` functions from the real request index
 * (section 3 §4.4). A thin wrapper over {@link requestIndexOps}, so `runPrechecks` reports
 * either straight through as a `"failed"` outcome.
 */
export function catalogRequestIndex(deps: RequestIndexDeps): Pick<PrecheckInput, "lookupRequest" | "recordRequest"> {
  const ops = requestIndexOps(deps);
  return { lookupRequest: ops.lookup, recordRequest: ops.record };
}

/** What one pre-run check pipeline needs. `resolve`, `lookupRequest`, and `recordRequest` are
 * Task 3's ports, injected as plain functions so this module never imports a store port
 * directly; {@link catalogResolve} and {@link catalogRequestIndex} wire the real ones. */
export type PrecheckInput = {
  /** The request body, not yet checked against its schema (check 1). */
  raw: unknown;
  tenant: string;
  agentId: string;
  /** This request's run ID, made by the caller before any check runs — even a rejected
   * request gets one (section 3 §4.8). */
  runId: string;
  now: Date;
  /** The tenant's app version for the request's app, or `undefined` when the app is not
   * configured here (section 3 §4.2: app version comes from bank settings). */
  appVersion: string | undefined;
  /** The merged, approved policy for this tenant and app (section 4). */
  policy: EffectivePolicy;
  /** Checks 4 and 5, and the session link: a sealed version of one major, filtered to one
   * that fits `appVersion` only when it is given (check 4 asks with no version; check 5 with
   * one). See {@link catalogResolve}. */
  resolve: (app: string, capability: string, major: number, appVersion?: string) => Promise<Artifact | undefined>;
  /** Check 3: is this request ID new, a true repeat, or reused with different content? */
  lookupRequest: (
    tenant: string,
    agentId: string,
    request: Request,
    signal?: AbortSignal,
  ) => Promise<Outcome<RequestIdLookup, FailureCode>>;
  /** Once checks 1 to 9 pass, just before check 10: writes the entry (section 3 §4.4,
   * docs/decisions.md M05). */
  recordRequest: (
    tenant: string,
    agentId: string,
    request: Request,
    runId: string,
    signal?: AbortSignal,
  ) => Promise<Outcome<void, FailureCode>>;
  /** Check 10's secret sources: the app's declared secrets and settings' bindings. */
  secretSources: SecretSources;
};

/** The pipeline's final answer, once every check that ran has passed or the first failure. */
export type PrecheckOutcome =
  | { status: "ok"; artifact: Artifact; sessionArtifact: Artifact | null }
  | { status: "duplicate"; runId: string }
  | { status: "rejected"; code: RejectionCode; errors: PrecheckError[] }
  | { status: "failed"; code: FailureCode; detail: string };

/** Secret names a `type` step fills with `{secret.name}`, whole or joined (section 4 §8.2). */
function secretNamesOf(artifact: Artifact): Set<string> {
  const names = new Set<string>();
  for (const step of artifact.steps) {
    if (step.action.type !== "type") continue;
    for (const r of scanRefs(step.action.value)) if (r.ns === "secret") names.add(r.name);
  }
  return names;
}

/** Check 6: every input matches the contract (section 2 §12.2 to §12.4). */
function checkInputs(inputs: readonly ContractInput[], values: Readonly<Record<string, ContractValue>>): PrecheckError[] {
  const errors: PrecheckError[] = [];
  const declared = new Map(inputs.map((i) => [i.name, i]));
  for (const name of Object.keys(values)) {
    if (!declared.has(name)) {
      errors.push({ code: "invalid_input", field: name, reason: "unknown", message: `${name} is not a declared input` });
    }
  }
  for (const input of inputs) {
    const value = values[input.name];
    if (value === undefined) {
      if (input.required) {
        errors.push({ code: "invalid_input", field: input.name, reason: "missing", message: `${input.name} is required` });
      }
      continue;
    }
    errors.push(...oneInputProblems(input, value));
  }
  return errors;
}

const FORMAT_SHAPES = { digits: /^\d+$/, letters: /^[A-Za-z]+$/, alphanumeric: /^[A-Za-z0-9]+$/ };

/** Compares one value against a range bound, per the field's own type (section 2 §12.4). */
function isBelow(type: ContractInput["type"], v: string | number, bound: string | number): boolean {
  if (type === "date") return String(v) < String(bound);
  return Number(v) < Number(bound);
}

/** Why one field's value breaks its contract, if at all (section 2 §12.2 to §12.4). */
function oneInputProblems(input: ContractInput, value: ContractValue): PrecheckError[] {
  const at = input.name;
  const errors: PrecheckError[] = [];
  const wrongType = (): PrecheckError => ({
    code: "invalid_input",
    field: at,
    reason: "wrong_type",
    message: `${at} must be a ${input.type}`,
  });
  if (input.type === "integer") {
    if (typeof value !== "number" || !Number.isInteger(value)) return [wrongType()];
    return rangeProblems(input, at, value);
  }
  if (input.type === "boolean") {
    return typeof value === "boolean" ? [] : [wrongType()];
  }
  if (typeof value !== "string") return [wrongType()];
  if (input.type === "money" && !/^\d+\.\d{2}$/.test(value)) {
    errors.push({ code: "invalid_input", field: at, reason: "bad_format", message: `${at} must be a money value like 100.00` });
  } else if (input.type === "decimal" && !/^-?\d+(\.\d+)?$/.test(value)) {
    errors.push({ code: "invalid_input", field: at, reason: "bad_format", message: `${at} must be a decimal number` });
  } else if (input.type === "date" && !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    errors.push({ code: "invalid_input", field: at, reason: "bad_format", message: `${at} must be a date like 2026-01-15` });
  }
  const c = input.constraints;
  if (c?.values !== undefined && !c.values.includes(value)) {
    errors.push({ code: "invalid_input", field: at, reason: "not_allowed_value", message: `${at} must be one of the listed values` });
  }
  if (c?.format !== undefined && !FORMAT_SHAPES[c.format].test(value)) {
    errors.push({ code: "invalid_input", field: at, reason: "bad_format", message: `${at} must be ${c.format} only` });
  }
  if (c?.length !== undefined) {
    if (value.length < c.length.min) {
      errors.push({ code: "invalid_input", field: at, reason: "too_short", message: `${at} must be at least ${String(c.length.min)} characters` });
    } else if (value.length > c.length.max) {
      errors.push({ code: "invalid_input", field: at, reason: "too_long", message: `${at} must be at most ${String(c.length.max)} characters` });
    }
  }
  errors.push(...rangeProblems(input, at, value));
  return errors;
}

/** Range constraint problems, shared by numeric and string-typed values. */
function rangeProblems(input: ContractInput, at: string, value: string | number): PrecheckError[] {
  const range = input.constraints?.range;
  if (range === undefined) return [];
  const errors: PrecheckError[] = [];
  if (range.min !== undefined && isBelow(input.type, value, range.min)) {
    errors.push({ code: "invalid_input", field: at, reason: "out_of_range", message: `${at} is below its allowed range` });
  }
  if (range.max !== undefined && isBelow(input.type, range.max, value)) {
    errors.push({ code: "invalid_input", field: at, reason: "out_of_range", message: `${at} is above its allowed range` });
  }
  return errors;
}

/** Check 7, thin (M05 spec): no score store exists, so every context is `draft`. An unattended
 * request is always rejected; a supervised request always passes here (section 3 §4.5). */
function checkApproval(mode: Mode): PrecheckError[] {
  if (mode !== "unattended") return [];
  return [
    {
      code: "context_not_approved",
      reason: "not_approved",
      message: "no context has an approved key yet; run this request supervised",
    },
  ];
}

/** Check 8: authorization is well formed and valid (section 3 §4.6). Missing authorization
 * never fails this check; the run pauses for approval at the commit point instead. */
function checkAuthorization(request: Request, effect: Contract["effect"], maxLifetimeMinutes: number | null, now: Date): PrecheckError[] {
  const auth = request.authorization;
  if (auth === undefined) return [];
  const errors: PrecheckError[] = [];
  if (effect === "read_only") {
    errors.push({ code: "authorization_invalid", reason: "not_needed", message: "authorization is not needed for a read-only capability" });
  }
  if (auth.capability !== request.capability) {
    errors.push({ code: "authorization_invalid", reason: "capability_mismatch", message: "authorization.capability must equal the request's capability" });
  }
  if (auth.granted_by === "staff" && auth.staff_id === undefined) {
    errors.push({ code: "authorization_invalid", reason: "missing_field", message: "staff_id is required when granted_by is staff" });
  }
  const granted = Date.parse(auth.granted_at);
  const expires = Date.parse(auth.expires_at);
  if (Number.isFinite(granted) && Number.isFinite(expires)) {
    if (expires <= granted) {
      errors.push({ code: "authorization_invalid", reason: "lifetime_too_long", message: "expires_at must be after granted_at" });
      // ponytail: a null policy cap (never configured) skips the lifetime check below; add a
      // hard default if a bank ever needs one before its policy sets it.
    } else if (maxLifetimeMinutes !== null && expires - granted > maxLifetimeMinutes * 60_000) {
      errors.push({ code: "authorization_invalid", reason: "lifetime_too_long", message: `the consent's lifetime is over ${String(maxLifetimeMinutes)} minutes` });
    }
    if (expires <= now.getTime()) {
      errors.push({ code: "authorization_invalid", reason: "expired", message: "authorization already expired" });
    }
  }
  return errors;
}

/** One artifact's `runs_on.paths` and referenced secret names against policy (section 3 §4.8
 * check 9: "Check 9 covers the session artifact too: its paths and secret names"). */
function pathsAndSecretsProblems(policy: EffectivePolicy, artifact: Artifact): PrecheckError[] {
  const errors: PrecheckError[] = [];
  for (const p of artifact.runs_on.paths) {
    if (!policy.paths.allow.includes(p)) {
      errors.push({ code: "policy_denied", reason: "path_not_allowed", message: `${p} sits outside the effective allowlist` });
    }
  }
  for (const name of secretNamesOf(artifact)) {
    if (!(name in policy.secrets)) {
      errors.push({ code: "policy_denied", reason: "secret_not_declared", message: `secret ${name} is not declared in the app's policy` });
    }
  }
  return errors;
}

/** Check 9: bank policy allows this capability and its paths (section 3 §4.8). */
function checkPolicy(
  policy: EffectivePolicy,
  app: string,
  capability: string,
  major: number,
  artifact: Artifact,
  sessionArtifact: Artifact | null,
): PrecheckError[] {
  const errors: PrecheckError[] = [];
  if (!policy.capabilities.allow.some((p) => patternNames(p, app, capability, major))) {
    errors.push({ code: "policy_denied", reason: "capability_not_allowed", message: `the tenant does not list ${app}/${capability}@${String(major)}` });
  }
  if (policy.capabilities.deny.some((p) => patternNames(p, app, capability, major))) {
    errors.push({ code: "policy_denied", reason: "capability_denied", message: `a deny rule names ${app}/${capability}@${String(major)}` });
  }
  errors.push(...pathsAndSecretsProblems(policy, artifact));
  if (sessionArtifact !== null) errors.push(...pathsAndSecretsProblems(policy, sessionArtifact));
  for (const step of artifact.steps) {
    if (!policy.actions.types.includes(step.action.type)) {
      errors.push({ code: "policy_denied", reason: "action_not_allowed", message: `step ${step.id} uses action ${step.action.type}, which the policy does not allow` });
    }
    if (step.action.type === "press" && !policy.actions.keys.includes(step.action.key) && !(step.action.key in policy.risk.key_labels)) {
      errors.push({ code: "policy_denied", reason: "action_not_allowed", message: `step ${step.id} presses ${step.action.key}, which the policy does not allow` });
    }
  }
  return errors;
}

/**
 * Runs every pre-run check, in order, for one caller request (section 3 §4.8). Stops at the
 * first failing check; checks 6 to 9 each report every problem they find before that happens.
 * No browser opens until the returned outcome is `"ok"`; that decision belongs to the caller.
 */
export async function runPrechecks(input: PrecheckInput, signal?: AbortSignal): Promise<{ results: PrecheckResult[]; outcome: PrecheckOutcome }> {
  const results: PrecheckResult[] = [];
  const stop = (check: string, code: RejectionCode, errors: PrecheckError[]): PrecheckOutcome => {
    results.push({ check, passed: false, errors });
    return { status: "rejected", code, errors };
  };

  // Check 1: the request matches intyy.request/1.0.
  const parsed = Request.safeParse(input.raw);
  if (!parsed.success) {
    const errors = parsed.error.issues.map((issue) => ({
      code: "invalid_request" as const,
      field: issue.path.join("."),
      message: issue.message,
    }));
    return { results, outcome: stop("format", "invalid_request", errors) };
  }
  results.push({ check: "format", passed: true, errors: [] });
  const request = parsed.data;

  // Check 3: the request ID is new, or a true repeat (section 3 §4.4).
  if (request.request_id !== null) {
    const lookup = await input.lookupRequest(input.tenant, input.agentId, request, signal);
    if (!lookup.ok) {
      return { results, outcome: { status: "failed", code: lookup.failure, detail: lookup.detail ?? lookup.failure } };
    }
    if (lookup.value.status === "repeat") {
      results.push({ check: "request_id", passed: true, errors: [] });
      return { results, outcome: { status: "duplicate", runId: lookup.value.runId } };
    }
    if (lookup.value.status === "reused") {
      const errors: PrecheckError[] = [{ code: "request_id_reused", message: "the same request ID was sent with different content" }];
      return { results, outcome: stop("request_id", "request_id_reused", errors) };
    }
  }
  results.push({ check: "request_id", passed: true, errors: [] });

  // Check 4: the capability and major exist (no app-version filter yet).
  const { app, capability, major } = splitCapabilityLink(request.capability);
  const found = await input.resolve(app, capability, major);
  if (found === undefined) {
    const errors: PrecheckError[] = [{ code: "capability_not_found", message: `${request.capability} has no sealed version here` }];
    return { results, outcome: stop("capability", "capability_not_found", errors) };
  }
  results.push({ check: "capability", passed: true, errors: [] });

  // Check 5: a sealed version fits this bank's app version.
  if (input.appVersion === undefined) {
    const errors: PrecheckError[] = [{ code: "no_version_for_context", message: `${app} is not configured for this tenant` }];
    return { results, outcome: stop("version", "no_version_for_context", errors) };
  }
  const versioned = await input.resolve(app, capability, major, input.appVersion);
  if (versioned === undefined) {
    const errors: PrecheckError[] = [{ code: "no_version_for_context", message: `${request.capability} has no sealed version for this app version` }];
    return { results, outcome: stop("version", "no_version_for_context", errors) };
  }
  let sessionArtifact: Artifact | null = null;
  const sessionLink = versioned.runs_on.session;
  if (sessionLink !== null) {
    const s = splitCapabilityLink(sessionLink);
    const sessionFound = await input.resolve(s.app, s.capability, s.major, input.appVersion);
    if (sessionFound === undefined) {
      // Why: owner decision, 2026-09-29 — a session link that cannot resolve gives
      // `no_version_for_context`, with the message naming the link.
      const errors: PrecheckError[] = [{ code: "no_version_for_context", message: `the session capability ${sessionLink} has no sealed version for this app version` }];
      return { results, outcome: stop("version", "no_version_for_context", errors) };
    }
    sessionArtifact = sessionFound;
  }
  results.push({ check: "version", passed: true, errors: [] });

  // Check 6: every input matches the contract.
  const inputErrors = checkInputs(versioned.contract.inputs, request.inputs);
  if (inputErrors.length > 0) return { results, outcome: stop("inputs", "invalid_input", inputErrors) };
  results.push({ check: "inputs", passed: true, errors: [] });

  // Check 7, thin: every context is draft.
  const approvalErrors = checkApproval(request.mode);
  if (approvalErrors.length > 0) return { results, outcome: stop("approval", "context_not_approved", approvalErrors) };
  results.push({ check: "approval", passed: true, errors: [] });

  // Check 8: authorization is well formed and valid.
  const authErrors = checkAuthorization(request, versioned.contract.effect, input.policy.authorization.max_lifetime_minutes, input.now);
  if (authErrors.length > 0) return { results, outcome: stop("authorization", "authorization_invalid", authErrors) };
  results.push({ check: "authorization", passed: true, errors: [] });

  // Check 9: bank policy allows this capability and its paths.
  const policyErrors = checkPolicy(input.policy, app, capability, major, versioned, sessionArtifact);
  if (policyErrors.length > 0) return { results, outcome: stop("policy", "policy_denied", policyErrors) };
  results.push({ check: "policy", passed: true, errors: [] });

  // The request enters the index only now, once checks 1 to 9 pass, just before check 10
  // (docs/decisions.md, M05). A validation rejection above stores nothing, so a fixed retry
  // with the same ID still runs.
  if (request.request_id !== null) {
    const recorded = await input.recordRequest(input.tenant, input.agentId, request, input.runId, signal);
    if (!recorded.ok) {
      return { results, outcome: { status: "failed", code: recorded.failure, detail: recorded.detail ?? recorded.failure } };
    }
  }

  // Check 10: every required secret has a value source. Not a rejection: a failure here
  // fails the run instead (section 3 §4.8: "intyy's setup problem, not the caller's").
  const required = new Set([...secretNamesOf(versioned), ...(sessionArtifact === null ? [] : secretNamesOf(sessionArtifact))]);
  const secretResult = await startCheck([...required], input.secretSources, signal);
  results.push({ check: "secrets", passed: secretResult.ok, errors: [] });
  if (!secretResult.ok) {
    return { results, outcome: { status: "failed", code: "secret_unavailable", detail: secretResult.detail ?? "a secret has no value" } };
  }

  return { results, outcome: { status: "ok", artifact: versioned, sessionArtifact } };
}
