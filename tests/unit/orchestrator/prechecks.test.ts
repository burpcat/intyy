// Proves the ten pre-run checks (section 3 §4.8) run in order, that checks 6 to 9 report
// every problem they find at once, and that the first failing check stops the pipeline.
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import type { Artifact } from "../../../src/core/model/artifact.js";
import { Artifact as ArtifactSchema } from "../../../src/core/model/artifact.js";
import { AppPolicy, GlobalPolicy, TenantPolicy } from "../../../src/core/model/policy.js";
import {
  patternNames,
  runPrechecks,
  type PrecheckInput,
  type RequestIdLookup,
} from "../../../src/core/orchestrator/prechecks.js";
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
    capabilities: { allow: [CAP_LINK] },
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

/** Resolves from a fixed `app/capability@major` map, standing in for Task 3's resolver. */
function resolverFrom(map: Record<string, Artifact>) {
  return (app: string, capability: string, major: number): Artifact | undefined =>
    map[`${app}/${capability}@${String(major)}`];
}

const alwaysNew = (): RequestIdLookup => ({ status: "new" });

function baseInput(overrides: Partial<PrecheckInput> = {}): PrecheckInput {
  const policy = basePolicy();
  return {
    raw: baseRequest(),
    tenant: "keystone",
    agentId: "agent_teller_01",
    now: new Date("2026-09-24T10:00:00.000Z"),
    appVersion: "8.4",
    policy,
    lookupRequest: alwaysNew,
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
  test("discovery's no-major call ignores any major in the pattern (unchanged behavior)", () => {
    expect(patternNames("kvfcu/*@1", "kvfcu", "sign_in")).toBe(true);
    expect(patternNames("kvfcu/sign_in@2", "kvfcu", "sign_in")).toBe(true);
  });

  test("replay's major-aware call checks the pattern's major too", () => {
    expect(patternNames("kvfcu/*@1", "kvfcu", "open_share_subaccount", 1)).toBe(true);
    expect(patternNames("kvfcu/*@1", "kvfcu", "open_share_subaccount", 2)).toBe(false);
    expect(patternNames("kvfcu/*@*", "kvfcu", "open_share_subaccount", 2)).toBe(true);
    expect(patternNames("*", "anything", "anything", 9)).toBe(true);
  });
});

describe("runPrechecks", () => {
  test("a fully valid supervised request, with no authorization, passes every check", async () => {
    const { results, outcome } = await runPrechecks(baseInput());
    expect(results.map((r) => r.check)).toEqual(CHECK_ORDER);
    expect(results.every((r) => r.passed)).toBe(true);
    expect(outcome.status).toBe("ok");
  });

  test("check 1: an unknown field is rejected as invalid_request; no later check runs", async () => {
    const { results, outcome } = await runPrechecks(
      baseInput({ raw: { ...baseRequest(), extra: true } }),
    );
    expect(outcome).toMatchObject({ status: "rejected", code: "invalid_request" });
    expect(results.map((r) => r.check)).toEqual(["format"]);
  });

  test("check 3: the same request ID reused with different content is rejected", async () => {
    const { results, outcome } = await runPrechecks(
      baseInput({ lookupRequest: (): RequestIdLookup => ({ status: "reused" }) }),
    );
    expect(outcome).toMatchObject({ status: "rejected", code: "request_id_reused" });
    expect(results.map((r) => r.check)).toEqual(["format", "request_id"]);
  });

  test("check 3: a true repeat returns the stored result, and stops before check 4", async () => {
    const stored = { schema: "intyy.result/1.0", status: "success" };
    const { results, outcome } = await runPrechecks(
      baseInput({ lookupRequest: (): RequestIdLookup => ({ status: "repeat", result: stored }) }),
    );
    expect(outcome).toEqual({ status: "duplicate", result: stored });
    expect(results.map((r) => r.check)).toEqual(["format", "request_id"]);
  });

  test("check 4: an unresolvable capability is capability_not_found", async () => {
    const { outcome } = await runPrechecks(baseInput({ resolve: resolverFrom({}) }));
    expect(outcome).toMatchObject({ status: "rejected", code: "capability_not_found" });
  });

  test("check 5: a sealed version that does not fit this app version is no_version_for_context", async () => {
    const { outcome } = await runPrechecks(baseInput({ appVersion: "5.0" }));
    expect(outcome).toMatchObject({ status: "rejected", code: "no_version_for_context" });
  });

  test("check 5: an unresolvable session link is no_version_for_context, naming the link", async () => {
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
  });

  test("check 6: every input problem is reported at once, and stops the pipeline there", async () => {
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
  });

  test("check 7, thin: an unattended request is always context_not_approved", async () => {
    const raw = { ...baseRequest(), mode: "unattended" };
    const { outcome } = await runPrechecks(baseInput({ raw }));
    expect(outcome).toMatchObject({
      status: "rejected",
      code: "context_not_approved",
      errors: [{ reason: "not_approved" }],
    });
  });

  test("check 7, thin: a supervised request always passes, authorization or not", async () => {
    const { results } = await runPrechecks(baseInput());
    expect(results.find((r) => r.check === "approval")).toMatchObject({ passed: true });
  });

  test("check 8: every authorization problem is reported at once", async () => {
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
  });

  test("check 8: authorization already expired is rejected", async () => {
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
  });

  test("check 9: a path the policy no longer allows is policy_denied", async () => {
    const narrowed = basePolicy(["/login", "/home", "/members/search", "/members/*"]);
    const { outcome } = await runPrechecks(baseInput({ policy: narrowed, secretSources: baseSecretSources(narrowed) }));
    expect(outcome).toMatchObject({
      status: "rejected",
      code: "policy_denied",
      errors: [{ reason: "path_not_allowed" }],
    });
  });

  test("check 9: covers the session artifact's paths too", async () => {
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
  });

  test("check 10: a missing secret value fails the run, but does not reject it", async () => {
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
  });
});
