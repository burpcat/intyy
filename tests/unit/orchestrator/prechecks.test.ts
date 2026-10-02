// Proves the ten pre-run checks (section 3 §4.8) run in order, that checks 6 to 9 report
// every problem they find at once, and that the first failing check stops the pipeline.
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { ok, type Outcome } from "../../../src/ports/outcome.js";
import type { Artifact } from "../../../src/core/model/artifact.js";
import { Artifact as ArtifactSchema } from "../../../src/core/model/artifact.js";
import { matchesAnyPattern } from "../../../src/core/model/artifact-checks-shared.js";
import { AppPolicy, GlobalPolicy, TenantPolicy } from "../../../src/core/model/policy.js";
import type { FailureCode } from "../../../src/core/model/result.js";
import {
  patternNames,
  runPrechecks,
  type PrecheckInput,
} from "../../../src/core/orchestrator/prechecks.js";
import type { RequestIdLookup } from "../../../src/core/orchestrator/request-index.js";
import type { EffectivePolicy } from "../../../src/core/safety/policy/merge.js";
import { mergePolicy } from "../../../src/core/safety/policy/merge.js";
import type { SecretSources } from "../../../src/core/safety/secrets/injector.js";
import { MapSecrets } from "../../../src/fakes/secrets.js";
import { artifactExample } from "../../fixtures/design-examples.js";

const APP = "kvfcu";
const CAPABILITY = "open_share_subaccount";
const CAP_LINK = `${APP}/${CAPABILITY}@1`;

/** The design's full artifact example, parsed (section 2, `open_share_subaccount`). */
function baseArtifact(): Artifact {
  const parsed = ArtifactSchema.safeParse(artifactExample());
  if (!parsed.success) throw new Error("artifactExample no longer parses");
  return parsed.data;
}

/** The reconciliation check capability `baseArtifact()` links, if any. */
const CHECK_LINK = baseArtifact().recovery?.reconciliation?.check?.capability;

const globalLayer = GlobalPolicy.parse(
  JSON.parse(
    readFileSync(new URL("../../../library/policy/global/1.json", import.meta.url), "utf8"),
  ),
);

/** A merged policy that allows exactly what `baseArtifact()` needs: its paths, its two
 * secrets, and the capability itself, at major 1. */
function basePolicy(paths = baseArtifact().runs_on.paths): EffectivePolicy {
  const app = AppPolicy.parse({
    schema: "intyy.policy/1.0",
    scope: { level: "app", app: APP },
    revision: 1,
    reason: "Test policy.",
    paths: { allow: paths, case_sensitive: true },
    secrets: {
      operator_username: { kind: "username", paths: ["/login"] },
      operator_password: { kind: "password", paths: ["/login"] },
    },
  });
  const tenant = TenantPolicy.parse({
    schema: "intyy.policy/1.0",
    scope: { level: "tenant", tenant: "keystone" },
    revision: 1,
    reason: "Test policy.",
    // Why the check's link too: check 9 also requires the tenant to list the linked reconciliation
    // check capability, because the replay runs it as a child run (section 3 §4.8).
    capabilities: { allow: [CAP_LINK, ...(CHECK_LINK === undefined ? [] : [CHECK_LINK])] },
  });
  const merged = mergePolicy({ global: globalLayer, app, tenant, appName: APP });
  if (!merged.ok) throw new Error(`test policy does not merge: ${merged.detail ?? ""}`);
  return merged.value.effective;
}

/** Secret sources that resolve both of `baseArtifact()`'s declared secrets. */
function baseSecretSources(policy: EffectivePolicy): SecretSources {
  return {
    declared: policy.secrets,
    bindings: {
      operator_username: { source: "env", key: "OU" },
      operator_password: { source: "env", key: "OP" },
    },
    port: new MapSecrets({ OU: "opuser", OP: "oppass" }),
  };
}

function baseRequest(): Record<string, unknown> {
  return {
    schema: "intyy.request/1.0",
    request_id: "agt-teller-0001",
    capability: CAP_LINK,
    inputs: { member_id: "100114", deposit: "100.00" },
    mode: "supervised",
  };
}

/** Resolves from a fixed `app/capability@major` map, standing in for Task 3's real resolver
 * (`catalogResolve`, tested against `resolveMajor` directly in `capabilities.test.ts`). Mirrors
 * its app-version fit check, so wiring tests here still exercise that behavior. */
function resolverFrom(map: Record<string, Artifact>) {
  return (app: string, capability: string, major: number, appVersion?: string): Promise<Artifact | undefined> => {
    const found = map[`${app}/${capability}@${String(major)}`];
    if (found === undefined || appVersion === undefined) return Promise.resolve(found);
    return Promise.resolve(matchesAnyPattern(found.runs_on.app_versions, appVersion) ? found : undefined);
  };
}

const alwaysNew = (): Promise<Outcome<RequestIdLookup, FailureCode>> => Promise.resolve(ok({ status: "new" }));
const alwaysRecorded = (): Promise<Outcome<void, FailureCode>> => Promise.resolve(ok(undefined));

function baseInput(overrides: Partial<PrecheckInput> = {}): PrecheckInput {
  const policy = basePolicy();
  return {
    raw: baseRequest(),
    tenant: "keystone",
    agentId: "agent_teller_01",
    runId: "run_2026-09-24_7kq2m9x4tb",
    now: new Date("2026-09-24T10:00:00.000Z"),
    appVersion: "8.4",
    policy,
    lookupRequest: alwaysNew,
    recordRequest: alwaysRecorded,
    resolve: resolverFrom({ [CAP_LINK]: baseArtifact() }),
    secretSources: baseSecretSources(policy),
    ...overrides,
  };
}

const CHECK_ORDER = [
  "format",
  "request_id",
  "capability",
  "version",
  "inputs",
  "approval",
  "authorization",
  "policy",
  "secrets",
];

describe("patternNames", () => {
  test("patternNames ignores the major in discovery and checks it in replay", () => {
    // discovery's no-major call ignores any major in the pattern (unchanged behavior)
    {
      expect(patternNames("kvfcu/*@1", "kvfcu", "sign_in")).toBe(true);
      expect(patternNames("kvfcu/sign_in@2", "kvfcu", "sign_in")).toBe(true);
    }
    // replay's major-aware call checks the pattern's major too
    {
      expect(patternNames("kvfcu/*@1", "kvfcu", "open_share_subaccount", 1)).toBe(true);
      expect(patternNames("kvfcu/*@1", "kvfcu", "open_share_subaccount", 2)).toBe(false);
      expect(patternNames("kvfcu/*@*", "kvfcu", "open_share_subaccount", 2)).toBe(true);
      expect(patternNames("*", "anything", "anything", 9)).toBe(true);
    }
  });
});

describe("runPrechecks", () => {
  test("runPrechecks check 1 to 3 and the index: format, request ID, and writes", async () => {
    // a fully valid supervised request, with no authorization, passes every check
    {
      const { results, outcome } = await runPrechecks(baseInput());
      expect(results.map((r) => r.check)).toEqual(CHECK_ORDER);
      expect(results.every((r) => r.passed)).toBe(true);
      expect(outcome.status).toBe("ok");
    }
    // check 1: an unknown field is rejected as invalid_request; no later check runs
    {
      const { results, outcome } = await runPrechecks(
        baseInput({ raw: { ...baseRequest(), extra: true } }),
      );
      expect(outcome).toMatchObject({ status: "rejected", code: "invalid_request" });
      expect(results.map((r) => r.check)).toEqual(["format"]);
    }
    // check 3: the same request ID reused with different content is rejected
    {
      const { results, outcome } = await runPrechecks(
        baseInput({ lookupRequest: () => Promise.resolve(ok({ status: "reused" })) }),
      );
      expect(outcome).toMatchObject({ status: "rejected", code: "request_id_reused" });
      expect(results.map((r) => r.check)).toEqual(["format", "request_id"]);
    }
    // check 3: a true repeat returns the original run ID, and stops before check 4
    {
      const { results, outcome } = await runPrechecks(
        baseInput({
          lookupRequest: () =>
            Promise.resolve(ok({ status: "repeat", runId: "run_2026-09-20_aaaaaaaaaa" })),
        }),
      );
      expect(outcome).toEqual({ status: "duplicate", runId: "run_2026-09-20_aaaaaaaaaa" });
      expect(results.map((r) => r.check)).toEqual(["format", "request_id"]);
    }
    // check 3 to 9 passing, then a failed write to the index, fails the run
    {
      const { outcome } = await runPrechecks(
        baseInput({ recordRequest: () => Promise.resolve({ ok: false, failure: "evidence_write_failed" }) }),
      );
      expect(outcome).toMatchObject({ status: "failed", code: "evidence_write_failed" });
    }
    // missing K1 fails the run as secret_unavailable, at the lookup itself
    {
      const { outcome } = await runPrechecks(
        baseInput({ lookupRequest: () => Promise.resolve({ ok: false, failure: "secret_unavailable" }) }),
      );
      expect(outcome).toMatchObject({ status: "failed", code: "secret_unavailable" });
    }
  });

  test("runPrechecks check 4 to 6: capability, version, and inputs", async () => {
    // check 4: an unresolvable capability is capability_not_found
    {
      const { outcome } = await runPrechecks(baseInput({ resolve: resolverFrom({}) }));
      expect(outcome).toMatchObject({ status: "rejected", code: "capability_not_found" });
    }
    // check 5: a sealed version that does not fit this app version is no_version_for_context
    {
      const { outcome } = await runPrechecks(baseInput({ appVersion: "5.0" }));
      expect(outcome).toMatchObject({ status: "rejected", code: "no_version_for_context" });
    }
    // check 5: an unresolvable session link is no_version_for_context, naming the link
    {
      const withSession: Artifact = {
        ...baseArtifact(),
        runs_on: { ...baseArtifact().runs_on, session: "kvfcu/sign_in@1" },
      };
      const { outcome } = await runPrechecks(
        baseInput({ resolve: resolverFrom({ [CAP_LINK]: withSession }) }),
      );
      expect(outcome.status).toBe("rejected");
      if (outcome.status === "rejected") {
        expect(outcome.code).toBe("no_version_for_context");
        expect(outcome.errors[0]?.message).toContain("kvfcu/sign_in@1");
      }
    }
    // check 6: every input problem is reported at once, and stops the pipeline there
    {
      const raw = { ...baseRequest(), inputs: { deposit: "999999.00" } };
      const { results, outcome } = await runPrechecks(baseInput({ raw }));
      expect(outcome.status).toBe("rejected");
      if (outcome.status === "rejected") {
        expect(outcome.code).toBe("invalid_input");
        const reasons = outcome.errors.map((e) => e.reason);
        expect(reasons).toContain("missing");
        expect(reasons).toContain("out_of_range");
        expect(outcome.errors.length).toBeGreaterThanOrEqual(2);
      }
      expect(results.map((r) => r.check)).toEqual(["format", "request_id", "capability", "version", "inputs"]);
    }
  });

  test("runPrechecks check 7 to 10: approval, authorization, policy, and secrets", async () => {
    // check 7, thin: an unattended request is always context_not_approved
    {
      const raw = { ...baseRequest(), mode: "unattended" };
      const { outcome } = await runPrechecks(baseInput({ raw }));
      expect(outcome).toMatchObject({
        status: "rejected",
        code: "context_not_approved",
        errors: [{ reason: "not_approved" }],
      });
    }
    // check 7, thin: a supervised request always passes, authorization or not
    {
      const { results } = await runPrechecks(baseInput());
      expect(results.find((r) => r.check === "approval")).toMatchObject({ passed: true });
    }
    // check 8: every authorization problem is reported at once
    {
      const raw = {
        ...baseRequest(),
        authorization: {
          consent_ref: "consent_1",
          granted_by: "staff",
          granted_at: "2026-09-24T09:00:00Z",
          expires_at: "2026-09-24T09:05:00Z",
          capability: "kvfcu/other_capability@1",
        },
      };
      const { outcome } = await runPrechecks(baseInput({ raw }));
      expect(outcome.status).toBe("rejected");
      if (outcome.status === "rejected") {
        expect(outcome.code).toBe("authorization_invalid");
        const reasons = outcome.errors.map((e) => e.reason);
        expect(reasons).toContain("capability_mismatch");
        expect(reasons).toContain("missing_field");
        expect(outcome.errors.length).toBeGreaterThanOrEqual(2);
      }
    }
    // check 8: authorization already expired is rejected
    {
      const raw = {
        ...baseRequest(),
        authorization: {
          consent_ref: "consent_1",
          granted_by: "member",
          granted_at: "2026-09-24T09:00:00Z",
          expires_at: "2026-09-24T09:05:00Z",
          capability: CAP_LINK,
        },
      };
      const { outcome } = await runPrechecks(baseInput({ raw }));
      expect(outcome).toMatchObject({ status: "rejected", code: "authorization_invalid" });
      if (outcome.status === "rejected") {
        expect(outcome.errors.some((e) => e.reason === "expired")).toBe(true);
      }
    }
    // check 9: a path the policy no longer allows is policy_denied
    {
      const narrowed = basePolicy(["/login", "/home", "/members/search", "/members/*"]);
      const { outcome } = await runPrechecks(baseInput({ policy: narrowed, secretSources: baseSecretSources(narrowed) }));
      expect(outcome).toMatchObject({
        status: "rejected",
        code: "policy_denied",
        errors: [{ reason: "path_not_allowed" }],
      });
    }
    // check 9: covers the session artifact's paths too
    {
      const sessionArtifact: Artifact = {
        ...baseArtifact(),
        identity: { ...baseArtifact().identity, capability: "sign_in" },
        runs_on: { ...baseArtifact().runs_on, paths: ["/login", "/not-allowed"] },
      };
      const withSession: Artifact = {
        ...baseArtifact(),
        runs_on: { ...baseArtifact().runs_on, session: "kvfcu/sign_in@1" },
      };
      const { outcome } = await runPrechecks(
        baseInput({
          resolve: resolverFrom({ [CAP_LINK]: withSession, "kvfcu/sign_in@1": sessionArtifact }),
        }),
      );
      expect(outcome).toMatchObject({ status: "rejected", code: "policy_denied" });
      if (outcome.status === "rejected") {
        expect(outcome.errors.some((e) => e.reason === "path_not_allowed" && e.message.includes("/not-allowed"))).toBe(
          true,
        );
      }
    }
    // check 10: a missing secret value fails the run, but does not reject it
    {
      const policy = basePolicy();
      const secretSources: SecretSources = {
        declared: policy.secrets,
        bindings: { operator_username: { source: "env", key: "OU" } },
        port: new MapSecrets({ OU: "opuser" }),
      };
      const { results, outcome } = await runPrechecks(baseInput({ policy, secretSources }));
      expect(outcome).toMatchObject({ status: "failed", code: "secret_unavailable" });
      expect(results.map((r) => r.check)).toEqual(CHECK_ORDER);
      expect(results.at(-1)).toMatchObject({ check: "secrets", passed: false });
    }
  });
});

describe("the checks run in order, and the first failing check is the one reported (section 3 §4.8; M05 gate row)", () => {
  /** Inputs that fail check 6. */
  const badInputs = { deposit: "999999.00" };
  /** An authorization that fails check 8 (the wrong capability, and fields missing). */
  const badAuthorization = {
    consent_ref: "consent_1",
    granted_by: "staff",
    granted_at: "2026-09-24T09:00:00Z",
    expires_at: "2026-09-24T09:05:00Z",
    capability: "kvfcu/other_capability@1",
  };
  /** A policy that fails check 9 (a path the artifact needs is gone). */
  const narrowed = basePolicy(["/login", "/home", "/members/search", "/members/*"]);
  const narrowedSources = baseSecretSources(narrowed);

  // Each row fails its own check AND every later one it can, so only an ordered pipeline passes.
  const rows: { name: string; code: string; last: string; input: () => PrecheckInput }[] = [
    {
      name: "check 1",
      code: "invalid_request",
      last: "format",
      input: () => baseInput({ raw: { ...baseRequest(), extra: true, inputs: badInputs, authorization: badAuthorization, mode: "unattended" }, lookupRequest: () => Promise.resolve(ok({ status: "reused" })), resolve: resolverFrom({}) }),
    },
    {
      name: "check 3",
      code: "request_id_reused",
      last: "request_id",
      input: () => baseInput({ raw: { ...baseRequest(), inputs: badInputs }, lookupRequest: () => Promise.resolve(ok({ status: "reused" })), resolve: resolverFrom({}), appVersion: "5.0" }),
    },
    {
      name: "check 4",
      code: "capability_not_found",
      last: "capability",
      input: () => baseInput({ raw: { ...baseRequest(), inputs: badInputs, authorization: badAuthorization }, resolve: resolverFrom({}), appVersion: "5.0" }),
    },
    {
      name: "check 5",
      code: "no_version_for_context",
      last: "version",
      input: () => baseInput({ raw: { ...baseRequest(), inputs: badInputs, authorization: badAuthorization, mode: "unattended" }, appVersion: "5.0", policy: narrowed, secretSources: narrowedSources }),
    },
    {
      name: "check 6",
      code: "invalid_input",
      last: "inputs",
      input: () => baseInput({ raw: { ...baseRequest(), inputs: badInputs, authorization: badAuthorization, mode: "unattended" }, policy: narrowed, secretSources: narrowedSources }),
    },
    {
      name: "check 7",
      code: "context_not_approved",
      last: "approval",
      input: () => baseInput({ raw: { ...baseRequest(), authorization: badAuthorization, mode: "unattended" }, policy: narrowed, secretSources: narrowedSources }),
    },
    {
      name: "check 8",
      code: "authorization_invalid",
      last: "authorization",
      input: () => baseInput({ raw: { ...baseRequest(), authorization: badAuthorization }, policy: narrowed, secretSources: narrowedSources }),
    },
    {
      name: "check 9",
      code: "policy_denied",
      last: "policy",
      input: () => baseInput({ policy: narrowed, secretSources: narrowedSources }),
    },
  ];

  test("each earlier problem fails first: only its own code is reported, and no later check runs", async () => {
    for (const { name, code, last, input } of rows) {
      const { results, outcome } = await runPrechecks(input());
      expect(outcome, name).toMatchObject({ status: "rejected", code });
      if (outcome.status !== "rejected") throw new Error(`expected rejected: ${name}`);
      // Every error belongs to the one failing check, not to a later one.
      expect(outcome.errors.every((e) => e.code === code), name).toBe(true);
      expect(results.at(-1), name).toMatchObject({ check: last, passed: false });
      expect(results.map((r) => r.check), name).toEqual(CHECK_ORDER.slice(0, CHECK_ORDER.indexOf(last) + 1));
      expect(results.slice(0, -1).every((r) => r.passed), name).toBe(true);
    }
  });
});

// A commit retry meets check 8 again, after the human wait (section 7 §11.3: "The authorization is
// checked again. Expired: approval at the commit point."; section 3 §4.6: expiry at the commit
// point pauses the run for a human, it does not fail). So the retry skips only the `expired` reason.
describe("check 8 with allowExpiredAuthorization (the commit retry)", () => {
  /** An authorization for the task, valid at 09:00 to 09:05 and so expired at the input's 10:00. */
  const expired = (over: Record<string, unknown> = {}) => ({
    ...baseRequest(),
    authorization: {
      consent_ref: "consent_1",
      granted_by: "member",
      granted_at: "2026-09-24T09:00:00Z",
      expires_at: "2026-09-24T09:05:00Z",
      capability: CAP_LINK,
      ...over,
    },
  });
  const reasonsOf = async (input: PrecheckInput): Promise<string[] | string> => {
    const { outcome } = await runPrechecks(input);
    return outcome.status === "rejected" ? outcome.errors.map((e) => e.reason ?? "") : outcome.status;
  };

  test("an expired authorization passes only with the flag, which skips nothing else", async () => {
    // an expired authorization passes with the flag, and is rejected as expired without it
    {
      expect(await reasonsOf(baseInput({ raw: expired(), allowExpiredAuthorization: true }))).toBe("ok");
      expect(await reasonsOf(baseInput({ raw: expired() }))).toEqual(["expired"]);
      expect(await reasonsOf(baseInput({ raw: expired(), allowExpiredAuthorization: false }))).toEqual(["expired"]);
    }
    // the flag skips nothing but expiry: a wrong capability still rejects
    {
      const raw = expired({ capability: "kvfcu/other_capability@1" });
      expect(await reasonsOf(baseInput({ raw, allowExpiredAuthorization: true }))).toEqual(["capability_mismatch"]);
    }
    // the flag skips nothing but expiry: a lifetime over the policy cap still rejects
    {
      const raw = expired({ granted_at: "2026-09-24T07:00:00Z", expires_at: "2026-09-24T09:00:00Z" });
      expect(await reasonsOf(baseInput({ raw, allowExpiredAuthorization: true }))).toEqual(["lifetime_too_long"]);
    }
    // the flag skips nothing but expiry: a missing staff ID still rejects
    {
      const raw = expired({ granted_by: "staff" });
      expect(await reasonsOf(baseInput({ raw, allowExpiredAuthorization: true }))).toEqual(["missing_field"]);
    }
    // a still-valid authorization passes with or without the flag
    {
      const raw = expired({ granted_at: "2026-09-24T09:55:00Z", expires_at: "2026-09-24T10:10:00Z" });
      expect(await reasonsOf(baseInput({ raw }))).toBe("ok");
      expect(await reasonsOf(baseInput({ raw, allowExpiredAuthorization: true }))).toBe("ok");
    }
  });
});
