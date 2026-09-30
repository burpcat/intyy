// Proves the demo files (design section 9 §13.2's demo path, steps 4 and 5; section 2 §21's
// full example, `open_share_subaccount`): every input file's field names match the sealed
// contract's own inputs, `bad.json` is rejected by the real pre-run checks, `auth.json` parses
// as an `intyy.request/1.0` authorization block, and none of them names a canary member. M05
// task 13.
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { ok, type Outcome } from "../../../src/ports/outcome.js";
import { Artifact as ArtifactSchema, type Artifact } from "../../../src/core/model/artifact.js";
import { Config } from "../../../src/core/model/config.js";
import { AppPolicy, GlobalPolicy, TenantPolicy } from "../../../src/core/model/policy.js";
import type { FailureCode } from "../../../src/core/model/result.js";
import { Authorization } from "../../../src/core/model/request.js";
import { runPrechecks, type PrecheckInput } from "../../../src/core/orchestrator/prechecks.js";
import type { RequestIdLookup } from "../../../src/core/orchestrator/request-index.js";
import type { EffectivePolicy } from "../../../src/core/safety/policy/merge.js";
import { mergePolicy } from "../../../src/core/safety/policy/merge.js";
import type { SecretSources } from "../../../src/core/safety/secrets/injector.js";
import { MapSecrets } from "../../../src/fakes/secrets.js";
import { artifactExample } from "../../fixtures/design-examples.js";

const APP = "kvfcu";
const CAPABILITY = "open_share_subaccount";
const CAP_LINK = `${APP}/${CAPABILITY}@1`;

/** Reads one demo file under `demo/`, already JSON-parsed. */
function demoFile(name: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(new URL(`../../../demo/${name}`, import.meta.url), "utf8"),
  ) as Record<string, unknown>;
}

/** The repo's own config, for `canary_members` (never hardcoded: CLAUDE.md). */
const CONFIG = Config.parse(
  JSON.parse(readFileSync(new URL("../../../intyy.json", import.meta.url), "utf8")),
);

/** Section 2 §21's full example, `open_share_subaccount`, parsed. Its own `contract.inputs`
 * are the names every demo `--inputs` file must use, since the sealed artifact does not exist
 * yet (M05 owner steps). */
function baseArtifact(): Artifact {
  const parsed = ArtifactSchema.safeParse(artifactExample());
  if (!parsed.success) throw new Error("artifactExample no longer parses");
  return parsed.data;
}

const globalLayer = GlobalPolicy.parse(
  JSON.parse(readFileSync(new URL("../../../library/policy/global/1.json", import.meta.url), "utf8")),
);

/** A merged policy that allows exactly what `baseArtifact()` needs (mirrors
 * tests/unit/orchestrator/prechecks.test.ts's own harness). */
function testPolicy(): EffectivePolicy {
  const app = AppPolicy.parse({
    schema: "intyy.policy/1.0",
    scope: { level: "app", app: APP },
    revision: 1,
    reason: "Test policy.",
    paths: { allow: baseArtifact().runs_on.paths, case_sensitive: true },
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

const alwaysNew = (): Promise<Outcome<RequestIdLookup, FailureCode>> => Promise.resolve(ok({ status: "new" }));
const alwaysRecorded = (): Promise<Outcome<void, FailureCode>> => Promise.resolve(ok(undefined));

/** A `runPrechecks` input for `inputs`, against the §21 contract (no sealed artifact exists
 * yet, so this stands in for the real resolver, section 3 §4.8 checks 4 and 5). */
function precheckInputFor(inputs: Record<string, unknown>): PrecheckInput {
  const policy = testPolicy();
  const artifact = baseArtifact();
  return {
    raw: {
      schema: "intyy.request/1.0",
      request_id: "demo-test-0001",
      capability: CAP_LINK,
      inputs,
      mode: "supervised",
    },
    tenant: "keystone",
    agentId: "agent_teller_01",
    runId: "run_2026-09-28_demofiles01",
    now: new Date("2026-09-28T10:00:00.000Z"),
    appVersion: "8.4",
    policy,
    lookupRequest: alwaysNew,
    recordRequest: alwaysRecorded,
    resolve: (a, c, major) =>
      Promise.resolve(a === APP && c === CAPABILITY && major === 1 ? artifact : undefined),
    secretSources: {
      declared: policy.secrets,
      bindings: {
        operator_username: { source: "env", key: "OU" },
        operator_password: { source: "env", key: "OP" },
      },
      port: new MapSecrets({ OU: "opuser", OP: "oppass" }),
    } satisfies SecretSources,
  };
}

describe("the demo files match section 2 §21's contract", () => {
  const contractInputNames = baseArtifact().contract.inputs.map((i) => i.name).sort();

  test.each(["valid.json", "missing.json", "at_limit.json", "bad.json"])(
    "%s's field names are exactly the contract's own inputs",
    (name) => {
      expect(Object.keys(demoFile(name)).sort()).toEqual(contractInputNames);
    },
  );

  test("auth.json parses as an intyy.request/1.0 authorization block", () => {
    const parsed = Authorization.safeParse(demoFile("auth.json"));
    expect(parsed.success).toBe(true);
  });
});

describe("bad.json is rejected before any browser opens", () => {
  test("member_id's bad format is rejected invalid_input, reason bad_format", async () => {
    const { outcome } = await runPrechecks(precheckInputFor(demoFile("bad.json")));
    expect(outcome).toMatchObject({ status: "rejected", code: "invalid_input" });
    if (outcome.status !== "rejected") throw new Error("expected a rejection");
    expect(outcome.errors).toContainEqual(
      expect.objectContaining({ field: "member_id", reason: "bad_format" }),
    );
  });

  test("valid.json passes the same inputs check", async () => {
    const { results } = await runPrechecks(precheckInputFor(demoFile("valid.json")));
    expect(results.find((r) => r.check === "inputs")).toMatchObject({ passed: true });
  });
});

describe("no demo file names the canary member (CLAUDE.md)", () => {
  test("none of the input files' member_id is in canary_members", () => {
    for (const name of ["valid.json", "missing.json", "at_limit.json", "bad.json"]) {
      const memberId = demoFile(name).member_id;
      expect(CONFIG.canary_members).not.toContain(memberId);
    }
  });
});
