// Proves check 4's major rule in `runPrechecks` (design section 8 §11.9 table, section 3 §4.8 check 4):
// past the retire day the request is rejected `capability_not_found` with reason `major_retired`, and
// the message names the successor; before it, with the successor approved here, the outcome carries
// a `major_version_deprecated` warning; with the successor not approved here, nothing at all; a pinned
// run skips the check; a major with no sealed version stays a plain `capability_not_found`. No files.
// M11 task 4.
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { ok, type Outcome } from "../../../src/ports/outcome.js";
import { Artifact as ArtifactSchema } from "../../../src/core/model/artifact.js";
import { AppPolicy, GlobalPolicy, TenantPolicy } from "../../../src/core/model/policy.js";
import type { FailureCode } from "../../../src/core/model/result.js";
import { runPrechecks, type PrecheckInput } from "../../../src/core/orchestrator/prechecks.js";
import type { RequestIdLookup } from "../../../src/core/orchestrator/request-index.js";
import { mergePolicy } from "../../../src/core/safety/policy/merge.js";
import type { MajorStatus } from "../../../src/core/trust/majors.js";
import { MapSecrets } from "../../../src/fakes/secrets.js";
import { artifactExample } from "../../fixtures/design-examples.js";

const CAPABILITY = "open_share_subaccount";
const CAP_LINK = `kvfcu/${CAPABILITY}@1`;
const artifact = ArtifactSchema.parse(artifactExample());

const globalLayer = GlobalPolicy.parse(
  JSON.parse(readFileSync(new URL("../../../library/policy/global/1.json", import.meta.url), "utf8")),
);

function policy() {
  const app = AppPolicy.parse({
    schema: "intyy.policy/1.0",
    scope: { level: "app", app: "kvfcu" },
    revision: 1,
    reason: "Test policy.",
    paths: { allow: artifact.runs_on.paths, case_sensitive: true },
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
  const merged = mergePolicy({ global: globalLayer, app, tenant, appName: "kvfcu" });
  if (!merged.ok) throw new Error("test policy does not merge");
  return merged.value.effective;
}

const alwaysNew = (): Promise<Outcome<RequestIdLookup, FailureCode>> => Promise.resolve(ok({ status: "new" }));
const alwaysRecorded = (): Promise<Outcome<void, FailureCode>> => Promise.resolve(ok(undefined));

/** A supervised request on 2026-09-24. `major` answers with `st`, and `calls` records what it was asked. */
function input(st: MajorStatus | null | "unset", over: Partial<PrecheckInput> = {}): { i: PrecheckInput; calls: unknown[][] } {
  const p = policy();
  const calls: unknown[][] = [];
  const major: PrecheckInput["major"] =
    st === "unset"
      ? undefined
      : (...args) => {
          calls.push(args);
          return Promise.resolve(st);
        };
  const i: PrecheckInput = {
    raw: {
      schema: "intyy.request/1.0",
      request_id: "agt-teller-0001",
      capability: CAP_LINK,
      inputs: { member_id: "100114", deposit: "100.00" },
      mode: "supervised",
    },
    tenant: "keystone",
    agentId: "agent_teller_01",
    runId: "run_2026-09-24_7kq2m9x4tb",
    now: new Date("2026-09-24T10:00:00.000Z"),
    appVersion: "8.4",
    policy: p,
    lookupRequest: alwaysNew,
    recordRequest: alwaysRecorded,
    resolve: () => Promise.resolve(artifact),
    secretSources: {
      declared: p.secrets,
      bindings: { operator_username: { source: "env", key: "OU" }, operator_password: { source: "env", key: "OP" } },
      port: new MapSecrets({ OU: "opuser", OP: "oppass" }),
    },
    ...(major === undefined ? {} : { major }),
    ...over,
  };
  return { i, calls };
}

const status = (retiresOn: string | null): MajorStatus => ({ name: CAP_LINK, successor: 2, retiresOn });

describe("check 4, deprecated major", () => {
  test("past the retire day: rejected capability_not_found, reason major_retired, naming the successor", async () => {
    const { i, calls } = input(status("2026-09-23"));
    const { results, outcome } = await runPrechecks(i);
    expect(calls).toEqual([["kvfcu", CAPABILITY, 1]]);
    expect(outcome).toMatchObject({ status: "rejected", code: "capability_not_found" });
    if (outcome.status !== "rejected") return;
    expect(outcome.errors[0]?.reason).toBe("major_retired");
    expect(outcome.errors[0]?.message).toContain("kvfcu/open_share_subaccount@2");
    expect(results.at(-1)).toMatchObject({ check: "capability", passed: false });
  });

  test("before the day, successor approved here: ok with a major_version_deprecated warning naming the date", async () => {
    const { outcome } = await runPrechecks(input(status("2026-12-31")).i);
    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") return;
    expect(outcome.warnings).toHaveLength(1);
    expect(outcome.warnings?.[0]).toMatchObject({ code: "major_version_deprecated" });
    expect(outcome.warnings?.[0]?.message).toContain("2026-12-31");
  });

  test("successor not approved here: no warning, no rejection", async () => {
    const { outcome } = await runPrechecks(input(status(null)).i);
    expect(outcome.status).toBe("ok");
    if (outcome.status === "ok") expect(outcome.warnings ?? []).toEqual([]);
  });

  test("no record (null), or no major view at all: no warning, no rejection", async () => {
    for (const st of [null, "unset"] as const) {
      const { outcome } = await runPrechecks(input(st).i);
      expect(outcome.status).toBe("ok");
      if (outcome.status === "ok") expect(outcome.warnings ?? []).toEqual([]);
    }
  });

  test("a pinned run skips the check, even past the day", async () => {
    const { i, calls } = input(status("2026-09-23"), { pinned: true });
    const { outcome } = await runPrechecks(i);
    expect(calls).toEqual([]);
    expect(outcome.status).toBe("ok");
    if (outcome.status === "ok") expect(outcome.warnings ?? []).toEqual([]);
  });

  test("a major with no sealed version is plain capability_not_found, with no reason", async () => {
    const { i } = input(status("2026-09-23"), { resolve: () => Promise.resolve(undefined) });
    const { outcome } = await runPrechecks(i);
    expect(outcome).toMatchObject({ status: "rejected", code: "capability_not_found" });
    if (outcome.status === "rejected") expect(outcome.errors[0]?.reason).toBeUndefined();
  });
});
