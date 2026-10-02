// Proves pre-run check 7 and the key choice inside `runPrechecks` (design section 3 §4.8 check 7,
// §4.5 mode and approval; section 8 §10.10 linked capabilities, §11.3 unattended, §11.4
// supervised, §11.5 operator pin, §11.7): an unattended request needs an approved key for the
// task, then its session, then (a `commits` task with a check link) its reconciliation check, and
// stops at the first rule that fails, with the reason; a waiver needs no check key; unattended runs
// the approved version, not the newest; a supervised request always passes check 7 and gets the key
// the supervised rules choose; a pinned run runs that exact key (even a retired one) and skips
// check 7 but only in supervised mode: an unattended pin is refused in core, not only by the CLI;
// with no `trust` view it is the old thin check. No files. M10 task 6.
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { ok, type Outcome } from "../../../src/ports/outcome.js";
import type { Artifact } from "../../../src/core/model/artifact.js";
import { Artifact as ArtifactSchema } from "../../../src/core/model/artifact.js";
import { matchesAnyPattern } from "../../../src/core/model/artifact-checks-shared.js";
import { AppPolicy, GlobalPolicy, TenantPolicy } from "../../../src/core/model/policy.js";
import type { FailureCode } from "../../../src/core/model/result.js";
import { runPrechecks, type PrecheckInput } from "../../../src/core/orchestrator/prechecks.js";
import type { RequestIdLookup } from "../../../src/core/orchestrator/request-index.js";
import type { EffectivePolicy } from "../../../src/core/safety/policy/merge.js";
import { mergePolicy } from "../../../src/core/safety/policy/merge.js";
import type { SecretSources } from "../../../src/core/safety/secrets/injector.js";
import type { HistoryLine } from "../../../src/core/model/score-history.js";
import type { ScoreRecord } from "../../../src/core/model/score.js";
import { rebuild } from "../../../src/core/trust/rebuild.js";
import { MapSecrets } from "../../../src/fakes/secrets.js";
import { artifactExample } from "../../fixtures/design-examples.js";
import { approved, batch, degraded, HASHES, KEY as BASE_KEY, retired } from "../trust/kit.js";

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
  const check = baseArtifact().recovery?.reconciliation?.check;
  const checkLink = check === undefined ? [] : [check.capability];
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
    // Why the check link too: check 9 requires the tenant to list the linked reconciliation check (section 3 §4.8).
    capabilities: { allow: [CAP_LINK, ...checkLink] },
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

const alwaysNew = (): Promise<Outcome<RequestIdLookup, FailureCode>> => Promise.resolve(ok({ status: "new" }));
const alwaysRecorded = (): Promise<Outcome<void, FailureCode>> => Promise.resolve(ok(undefined));

const SESSION_LINK = "kvfcu/sign_in@1";
const CHECK_LINK = "kvfcu/find_account_by_reference@1";

/** A valid authorization for the task: check 8 passes, so a pass here is a whole-pipeline pass. */
const AUTHORIZATION = {
  consent_ref: "consent_1",
  granted_by: "member",
  granted_at: "2026-09-24T09:59:00Z",
  expires_at: "2026-09-24T10:09:00Z",
  capability: CAP_LINK,
};

/** The design's example artifact, renamed and re-versioned. `edit` changes the raw document first. */
function art(capability: string, version: string, edit: (doc: Record<string, unknown>) => void = () => undefined): Artifact {
  const doc = JSON.parse(JSON.stringify(artifactExample())) as Record<string, unknown>;
  const identity = doc.identity as Record<string, unknown>;
  identity.capability = capability;
  identity.version = version;
  edit(doc);
  return ArtifactSchema.parse(doc);
}

const withSession = (doc: Record<string, unknown>): void => {
  (doc.runs_on as Record<string, unknown>).session = SESSION_LINK;
};
const withWaiver = (doc: Record<string, unknown>): void => {
  (doc.recovery as Record<string, unknown>).reconciliation = { waiver: { reason: "Reviewed by hand each day.", attempt_run: "run_2026-10-01_0123456789" } };
};

/** What is sealed, by `app/capability@major` (newest first), and every score record. */
type World = { sealed: Record<string, Artifact[]>; records: ScoreRecord[] };

/** The task at 1.0.0 (a `commits` task with a check link, no session), its check, and no records. */
function world(over: Partial<World> = {}): World {
  return {
    sealed: {
      [CAP_LINK]: [art(CAPABILITY, "1.0.0")],
      [CHECK_LINK]: [art("find_account_by_reference", "1.0.0")],
      [SESSION_LINK]: [art("sign_in", "1.0.0")],
    },
    records: [],
    ...over,
  };
}

/** The record of `app/capability@version` that the lines give. */
function rec(name: string, version: string, lines: HistoryLine[]): ScoreRecord {
  const r = rebuild({ ...BASE_KEY, capability: `${name}@${version}`, app_version: "8.4" }, HASHES, lines);
  if (!r.ok) throw new Error("test setup: rebuild failed");
  return r.value;
}
const TASK = `kvfcu/${CAPABILITY}`;
const CHECK = "kvfcu/find_account_by_reference";
const SESSION = "kvfcu/sign_in";
const APPROVED = [batch(1, "batch_a"), approved(2)];

function input(w: World, over: Partial<PrecheckInput> = {}, mode: "supervised" | "unattended" = "unattended"): PrecheckInput {
  const policy = basePolicy();
  const fit = (app: string, cap: string, major: number, appVersion: string): Artifact[] =>
    (w.sealed[`${app}/${cap}@${String(major)}`] ?? []).filter((a) => matchesAnyPattern(a.runs_on.app_versions, appVersion));
  return {
    raw: { ...baseRequest(), mode, authorization: AUTHORIZATION },
    tenant: "keystone",
    agentId: "agent_teller_01",
    runId: "run_2026-09-24_7kq2m9x4tb",
    now: new Date("2026-09-24T10:00:00.000Z"),
    appVersion: "8.4",
    policy,
    lookupRequest: alwaysNew,
    recordRequest: alwaysRecorded,
    resolve: (app, cap, major, v) => Promise.resolve(fit(app, cap, major, v ?? "8.4")[0]),
    trust: { records: w.records, fitting: (app, cap, major, v) => Promise.resolve(fit(app, cap, major, v)) },
    secretSources: baseSecretSources(policy),
    ...over,
  };
}

/** The rejection of check 7, as `[code, reason]` pairs, or `null` when it did not reject. */
async function approvalRejection(i: PrecheckInput): Promise<[string, string | undefined][] | null> {
  const { outcome } = await runPrechecks(i);
  return outcome.status === "rejected" ? outcome.errors.map((e) => [outcome.code, e.reason]) : null;
}

describe("check 7, unattended: the task, then its session, then its check", () => {
  test("unattended check 7 approves the task, session, and check in order, and names why it rejects", async () => {
    // task and check approved: the whole pipeline passes and the record is the approved one
    {
      const w = world({ records: [rec(TASK, "1.0.0", APPROVED), rec(CHECK, "1.0.0", APPROVED)] });
      const { results, outcome } = await runPrechecks(input(w));
      expect(results.find((r) => r.check === "approval")).toMatchObject({ passed: true });
      expect(outcome.status).toBe("ok");
      if (outcome.status === "ok") expect(outcome.record?.state).toBe("approved");
    }
    // it runs the approved version, not the newest sealed one
    {
      const w = world({ records: [rec(TASK, "1.0.0", APPROVED), rec(CHECK, "1.0.0", APPROVED)] });
      w.sealed[CAP_LINK] = [art(CAPABILITY, "1.1.0"), art(CAPABILITY, "1.0.0")];
      const { outcome } = await runPrechecks(input(w));
      expect(outcome.status).toBe("ok");
      if (outcome.status === "ok") expect(outcome.artifact.identity.version).toBe("1.0.0");
    }
    // no record: context_not_approved, not_approved
    {
      expect(await approvalRejection(input(world()))).toEqual([["context_not_approved", "not_approved"]]);
    }
    // the latest approved key is degraded: context_not_approved, degraded
    {
      const w = world({ records: [rec(TASK, "1.0.0", [...APPROVED, degraded(3)]), rec(CHECK, "1.0.0", APPROVED)] });
      expect(await approvalRejection(input(w))).toEqual([["context_not_approved", "degraded"]]);
    }
    // the key was retired with no successor: not_approved
    {
      const w = world({ records: [rec(TASK, "1.0.0", [...APPROVED, retired(3)]), rec(CHECK, "1.0.0", APPROVED)] });
      expect(await approvalRejection(input(w))).toEqual([["context_not_approved", "not_approved"]]);
    }
    // a session with no approved key: context_not_approved, session_not_approved
    {
      const w = world({ records: [rec(TASK, "1.0.0", APPROVED), rec(CHECK, "1.0.0", APPROVED)] });
      w.sealed[CAP_LINK] = [art(CAPABILITY, "1.0.0", withSession)];
      expect(await approvalRejection(input(w))).toEqual([["context_not_approved", "session_not_approved"]]);
      const fixed = world({ records: [...w.records, rec(SESSION, "1.0.0", APPROVED)], sealed: w.sealed });
      expect((await runPrechecks(input(fixed))).outcome.status).toBe("ok");
    }
    // a check with no approved key: reconciliation_not_approved, not_approved
    {
      const w = world({ records: [rec(TASK, "1.0.0", APPROVED)] });
      expect(await approvalRejection(input(w))).toEqual([["reconciliation_not_approved", "not_approved"]]);
    }
    // a degraded check: reconciliation_not_approved, degraded
    {
      const w = world({ records: [rec(TASK, "1.0.0", APPROVED), rec(CHECK, "1.0.0", [...APPROVED, degraded(3)])] });
      expect(await approvalRejection(input(w))).toEqual([["reconciliation_not_approved", "degraded"]]);
    }
    // a waiver needs no check key
    {
      const w = world({ records: [rec(TASK, "1.0.0", APPROVED)] });
      w.sealed[CAP_LINK] = [art(CAPABILITY, "1.0.0", withWaiver)];
      const { outcome } = await runPrechecks(input(w));
      expect(outcome.status).toBe("ok");
    }
    // it stops at the first rule: an unapproved task hides the session and the check
    {
      const w = world();
      w.sealed[CAP_LINK] = [art(CAPABILITY, "1.0.0", withSession)];
      const rejection = await approvalRejection(input(w));
      expect(rejection).toEqual([["context_not_approved", "not_approved"]]);
    }
    // a read-only task has no check rule
    {
      const w = world({ records: [rec(TASK, "1.0.0", APPROVED)] });
      w.sealed[CAP_LINK] = [
        art(CAPABILITY, "1.0.0", (doc) => {
          (doc.contract as Record<string, unknown>).effect = "read_only";
          delete doc.recovery;
        }),
      ];
      const { results } = await runPrechecks(input(w));
      expect(results.find((r) => r.check === "approval")).toMatchObject({ passed: true });
    }
  });
});

describe("check 7, supervised", () => {
  test("supervised check 7 passes and picks by the supervised rules", async () => {
    // always passes, with no records at all
    {
      const { results, outcome } = await runPrechecks(input(world(), {}, "supervised"));
      expect(results.find((r) => r.check === "approval")).toMatchObject({ passed: true });
      expect(outcome.status).toBe("ok");
    }
    // picks by the supervised rules: approved, then certified, then the newest without a wrong verdict
    {
      const w = world({ records: [rec(TASK, "1.0.0", APPROVED), rec(TASK, "1.1.0", [batch(1, "batch_b")])] });
      w.sealed[CAP_LINK] = [art(CAPABILITY, "1.1.0"), art(CAPABILITY, "1.0.0")];
      const version = async (records: ScoreRecord[]): Promise<string | null | undefined> => {
        const { outcome } = await runPrechecks(input({ ...w, records }, {}, "supervised"));
        return outcome.status === "ok" ? outcome.artifact.identity.version : outcome.status;
      };
      expect(await version(w.records)).toBe("1.0.0");
      expect(await version([rec(TASK, "1.0.0", [batch(1, "batch_a")]), rec(TASK, "1.1.0", [batch(1, "batch_b")])])).toBe("1.1.0");
      expect(await version([])).toBe("1.1.0");
      expect(await version([rec(TASK, "1.1.0", [batch(1, "batch_b", { gate: "failed", scores: failedScores() })])])).toBe("1.0.0");
    }
    // every version had a wrong verdict: rejected, no_version_for_context
    {
      const lied = (v: string) => rec(TASK, v, [batch(1, `batch_${v}`, { gate: "failed", scores: failedScores() })]);
      const w = world({ records: [lied("1.0.0"), lied("1.1.0")] });
      w.sealed[CAP_LINK] = [art(CAPABILITY, "1.1.0"), art(CAPABILITY, "1.0.0")];
      expect(await approvalRejection(input(w, {}, "supervised"))).toEqual([["no_version_for_context", undefined]]);
    }
    // a retired key is skipped
    {
      const w = world({ records: [rec(TASK, "1.1.0", [...APPROVED, retired(3)])] });
      w.sealed[CAP_LINK] = [art(CAPABILITY, "1.1.0"), art(CAPABILITY, "1.0.0")];
      const { outcome } = await runPrechecks(input(w, {}, "supervised"));
      expect(outcome.status === "ok" ? outcome.artifact.identity.version : outcome.status).toBe("1.0.0");
    }
    // the session resolves by the same rules: its approved version, not its newest
    {
      const w = world({ records: [rec(SESSION, "1.0.0", APPROVED)] });
      w.sealed[CAP_LINK] = [art(CAPABILITY, "1.0.0", withSession)];
      w.sealed[SESSION_LINK] = [art("sign_in", "1.1.0"), art("sign_in", "1.0.0")];
      const { outcome } = await runPrechecks(input(w, {}, "supervised"));
      expect(outcome.status === "ok" ? outcome.sessionArtifact?.identity.version : outcome.status).toBe("1.0.0");
    }
  });
});

/** Scores with one `wrong` verdict. */
function failedScores() {
  return { outcome_score: 0.5, verdicts: { pass: 4, explained: 0, assisted: 0, unexplained: 0, wrong: 1, void: 0 }, margin: { lowest: 0.5, step: null }, fragile: [] };
}

describe("a pinned run", () => {
  const RETIRED = [...APPROVED, retired(3)];

  test("a pinned run uses its exact key and is refused in unattended mode", async () => {
    // supervised: runs that exact key, even a retired one, and skips check 7
    {
      const w = world({ records: [rec(TASK, "1.0.0", RETIRED)] });
      w.sealed[CAP_LINK] = [art(CAPABILITY, "1.0.0")];
      const { results, outcome } = await runPrechecks(input(w, { pinned: true }, "supervised"));
      expect(results.find((r) => r.check === "approval")).toMatchObject({ passed: true });
      expect(outcome.status).toBe("ok");
      if (outcome.status === "ok") {
        expect(outcome.artifact.identity.version).toBe("1.0.0");
        expect(outcome.record?.state).toBe("retired");
      }
    }
    // the pin wins over a newer approved version (the injected resolver returns the pinned one)
    {
      const w = world({ records: [rec(TASK, "1.1.0", APPROVED), rec(TASK, "1.0.0", RETIRED)] });
      w.sealed[CAP_LINK] = [art(CAPABILITY, "1.1.0"), art(CAPABILITY, "1.0.0")];
      const pinnedOne = art(CAPABILITY, "1.0.0");
      const { outcome } = await runPrechecks(input(w, { pinned: true, resolve: () => Promise.resolve(pinnedOne) }, "supervised"));
      expect(outcome.status).toBe("ok");
      if (outcome.status === "ok") expect(outcome.artifact.identity.version).toBe("1.0.0");
    }
    // SAFETY: a pin in unattended mode is refused in core, so a retired key can never run unattended
    {
      const w = world({ records: [rec(TASK, "1.0.0", RETIRED)] });
      const { outcome } = await runPrechecks(input(w, { pinned: true }, "unattended"));
      expect(outcome.status).not.toBe("ok");
    }
  });
});

describe("with no trust view (the old thin check)", () => {
  test("with no trust view, unattended is not approved and supervised passes", async () => {
    // unattended is context_not_approved, not_approved
    {
      const i = input(world());
      delete i.trust;
      expect(await approvalRejection(i)).toEqual([["context_not_approved", "not_approved"]]);
    }
    // supervised passes and gets the newest fitting version
    {
      const i = input(world(), {}, "supervised");
      delete i.trust;
      const { outcome } = await runPrechecks(i);
      expect(outcome.status).toBe("ok");
      if (outcome.status === "ok") expect(outcome.record).toBeNull();
    }
  });
});

// Check 9 and the reconciliation check capability (section 3 §4.8; owner decision 2026-10-01): the
// replay runs the linked check as a child run, so the policy must allow it, in either mode.
describe("check 9: the linked reconciliation check capability meets the policy", () => {
  /** The base policy, but the tenant lists exactly `allow` and denies `deny`. */
  function policyWith(allow: string[], deny: string[] = []): EffectivePolicy {
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
      capabilities: { allow, ...(deny.length > 0 ? { deny } : {}) },
    });
    const merged = mergePolicy({ global: globalLayer, app, tenant, appName: APP });
    if (!merged.ok) throw new Error(`test policy does not merge: ${merged.detail ?? ""}`);
    return merged.value.effective;
  }

  const bothApproved = (): World => world({ records: [rec(TASK, "1.0.0", APPROVED), rec(CHECK, "1.0.0", APPROVED)] });

  /** Check 9's errors, or `null` when the run was not rejected. */
  async function policyErrors(mode: "supervised" | "unattended", policy: EffectivePolicy, w = bothApproved()) {
    const { outcome } = await runPrechecks(input(w, { policy, secretSources: baseSecretSources(policy) }, mode));
    return outcome.status === "rejected" ? outcome.errors.map((e) => ({ code: outcome.code, reason: e.reason, message: e.message })) : null;
  }

  test("check 9 applies the policy to the linked check capability in both modes", async () => {
    // a check capability the tenant does not list is policy_denied, capability_not_allowed
    {
      for (const mode of ["supervised", "unattended"] as const) {
        const errors = await policyErrors(mode, policyWith([CAP_LINK]));
        expect(errors, mode).toHaveLength(1);
        expect(errors?.[0], mode).toMatchObject({ code: "policy_denied", reason: "capability_not_allowed" });
        // The message names the CHECK capability, not the task.
        expect(errors?.[0]?.message, mode).toContain(CHECK_LINK);
        expect(errors?.[0]?.message, mode).not.toContain(CAP_LINK);
      }
    }
    // a deny rule that names the check capability is policy_denied, capability_denied
    {
      for (const mode of ["supervised", "unattended"] as const) {
        const errors = await policyErrors(mode, policyWith([CAP_LINK, CHECK_LINK], [CHECK_LINK]));
        expect(errors, mode).toHaveLength(1);
        expect(errors?.[0], mode).toMatchObject({ code: "policy_denied", reason: "capability_denied" });
        expect(errors?.[0]?.message, mode).toContain(CHECK_LINK);
      }
    }
    // a wildcard allow covers the check, and a wildcard deny on the check's name denies it
    {
      expect(await policyErrors("supervised", policyWith(["kvfcu/*@1"]))).toBeNull();
      const denied = await policyErrors("supervised", policyWith(["kvfcu/*@1"], [`${CHECK}@*`]));
      expect(denied?.map((e) => e.reason)).toEqual(["capability_denied"]);
    }
    // a check capability the policy allows adds no error
    {
      for (const mode of ["supervised", "unattended"] as const) {
        const { outcome } = await runPrechecks(input(bothApproved(), {}, mode));
        expect(outcome.status, mode).toBe("ok");
      }
    }
    // a waiver has no check, so a policy that omits the check capability adds no error
    {
      for (const mode of ["supervised", "unattended"] as const) {
        const w = world({ records: [rec(TASK, "1.0.0", APPROVED)] });
        w.sealed[CAP_LINK] = [art(CAPABILITY, "1.0.0", withWaiver)];
        const policy = policyWith([CAP_LINK]);
        const { outcome } = await runPrechecks(input(w, { policy, secretSources: baseSecretSources(policy) }, mode));
        expect(outcome.status, mode).toBe("ok");
      }
    }
    // the task's own missing allow and the check's missing allow are both reported at once
    {
      const errors = await policyErrors("supervised", policyWith([]));
      expect(errors?.map((e) => e.reason)).toEqual(["capability_not_allowed", "capability_not_allowed"]);
      expect(errors?.[1]?.message).toContain(CHECK_LINK);
    }
    // a count_diff check capability is tested the same way
    {
      const w = bothApproved();
      w.sealed[CAP_LINK] = [
        art(CAPABILITY, "1.0.0", (doc) => {
          const recon = (doc.recovery as Record<string, unknown>).reconciliation as { check: Record<string, unknown> };
          recon.check = { capability: "kvfcu/count_sub@1", mode: "count_diff", count_output: "n", inputs: {}, not_found_outcomes: [], outputs: {} };
        }),
      ];
      // Only the task is listed: the count capability is the one that is missing. Supervised needs no key.
      const errors = await policyErrors("supervised", policyWith([CAP_LINK]), w);
      expect(errors?.[0]).toMatchObject({ code: "policy_denied", reason: "capability_not_allowed" });
      expect(errors?.[0]?.message).toContain("kvfcu/count_sub@1");
    }
  });
});
