// Proves the policy merge: loosening fails loudly, bounds hold, and the hash is stable.
// Design section 4 §4.2, §4.3, §4.5, §4.8; M01 test gate "Policy merge".
import { describe, expect, test } from "vitest";
import {
  AppPolicy,
  GlobalPolicy,
  TenantPolicy,
  type AppPolicy as AppLayer,
  type GlobalPolicy as GlobalLayer,
  type TenantPolicy as TenantLayer,
} from "../../../src/core/model/policy.js";
import { mergePolicy, type MergeInput } from "../../../src/core/safety/policy/merge.js";
import { appExample, globalExample, tenantExample } from "../../fixtures/design-examples.js";

/** Deep copy of an example, changed by `edit`, then parsed. */
function layer<T>(
  schema: { parse(raw: unknown): T },
  example: object,
  edit?: (d: Record<string, unknown>) => void,
): T {
  const d = structuredClone(example) as Record<string, unknown>;
  edit?.(d);
  return schema.parse(d);
}

/** The global example plus the bounds the tenant example picks from. */
function global(edit?: (d: Record<string, unknown>) => void): GlobalLayer {
  return layer(GlobalPolicy, globalExample, (d) => {
    d.evidence = {
      level: { options: ["minimal", "standard", "full"], default: "standard" },
      retention: { debug_days: { min: 7, max: 30, default: 30 } },
    };
    d.discovery = { environments: { options: ["test", "production"], default: ["test"] } };
    edit?.(d);
  });
}
const app = (edit?: (d: Record<string, unknown>) => void): AppLayer =>
  layer(AppPolicy, appExample, edit);
const tenant = (edit?: (d: Record<string, unknown>) => void): TenantLayer =>
  layer(TenantPolicy, tenantExample, edit);

/** The merge's problem lines, or [] when it passed. */
function problems(input: MergeInput): string[] {
  const r = mergePolicy(input);
  return r.ok ? [] : (r.detail ?? "").split("\n");
}

describe("policy merge", () => {
  test("the three example layers merge and record each revision", () => {
    const r = mergePolicy({ global: global(), app: app(), tenant: tenant() });
    if (!r.ok) throw new Error(r.detail);
    expect(r.value.layers).toEqual({ global: 4, "app:kvfcu": 2, "tenant:keystone": 3 });
    expect(r.value.missing).toEqual([]);
    expect(r.value.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    const e = r.value.effective;
    // Why both: the tenant adds a deny instead of narrowing allow. M02's path matcher reads both lists.
    expect(e.paths.allow).toContain("/lookup/branch");
    expect(e.paths.deny).toContain("/lookup/branch");
    expect(e.risk.safe_words).toContain("enquiry");
    expect(e.capabilities).toEqual({ allow: ["kvfcu/*@1"], deny: ["kvfcu/close_account@*"] });
    expect(e.evidence).toEqual({ level: "standard", retention: { debug_days: 14 } });
    expect(e.escalation).toEqual({ approval_minutes: 30 });
    expect(e.secrets.operator_password).toEqual({ kind: "password", paths: ["/login"] });
  });

  test("section 4 §4.3's example: a tenant allowing /admin/* fails with the exact message", () => {
    const t = tenant((d) => {
      d.apps = { kvfcu: { paths: { allow: ["/login", "/admin/*"] } } };
    });
    expect(problems({ global: global(), app: app(), tenant: t })).toEqual([
      "paths.allow: /admin/* is not allowed by app:kvfcu",
    ]);
  });

  test("allow lists: a lower layer may remove items, never add them", () => {
    const a = app((d) => {
      d.actions = { keys: ["Enter", "F5"] };
    });
    expect(problems({ global: global(), app: a })).toEqual([
      "actions.keys: F5 is not allowed by global",
    ]);
    const narrowed = mergePolicy({
      global: global(),
      app: app((d) => (d.actions = { types: ["click", "read"] })),
    });
    expect(narrowed.ok && narrowed.value.effective.actions.types).toEqual(["click", "read"]);
  });

  test("restriction lists: a lower layer adds, and cannot remove", () => {
    const t = tenant((d) => {
      d.risk = { irreversible_words: ["open account"] };
    });
    const r = mergePolicy({ global: global(), app: app(), tenant: t });
    expect(r.ok && r.value.effective.risk.irreversible_words).toEqual(
      expect.arrayContaining(["confirm", "close account", "open account"]),
    );
  });

  test("safe words: the app may add them; the tenant may only remove them", () => {
    const addByTenant = tenant((d) => {
      d.risk = { safe_words: ["search", "proceed"] };
    });
    expect(problems({ global: global(), app: app(), tenant: addByTenant })).toEqual([
      "risk.safe_words: proceed is not allowed by app:kvfcu",
    ]);
    const removeByTenant = mergePolicy({
      global: global(),
      app: app(),
      tenant: tenant((d) => (d.risk = { safe_words: ["search"] })),
    });
    expect(removeByTenant.ok && removeByTenant.value.effective.risk.safe_words).toEqual(["search"]);
  });

  test("reversible words: no layer may add one, because it lowers risk", () => {
    const a = app((d) => {
      d.risk = { reversible_words: ["add", "apply"] };
    });
    expect(problems({ global: global(), app: a })).toEqual([
      "risk.reversible_words: apply is not allowed by global",
    ]);
  });

  test("switches: a lower layer may only turn stricter", () => {
    const a = app((d) => {
      d.browser = { popups: "block" };
      d.llm = { send_screenshots: false };
    });
    const t = tenant((d) => {
      d.browser = { popups: "allowlist" };
      d.llm = { send_screenshots: true, mask_screenshots: false, replay_jev: false };
    });
    expect(problems({ global: global(), app: a, tenant: t })).toEqual([
      "browser.popups: allowlist is looser than block in app:kvfcu",
      "llm.send_screenshots: true is looser than false in app:kvfcu",
      "llm.mask_screenshots: false is looser than true in app:kvfcu",
    ]);
  });

  test("correlation: the app may turn notes on; the tenant may only turn them off", () => {
    const on = app((d) => (d.correlation = { notes: true }));
    const r = mergePolicy({ global: global(), app: on });
    expect(r.ok && r.value.effective.correlation.notes).toBe(true);
    const tOn = tenant((d) => (d.correlation = { notes: true }));
    expect(problems({ global: global(), app: app(), tenant: tOn })).toEqual([
      "correlation.notes: true is looser than false in app:kvfcu",
    ]);
  });

  test("redaction: detectors and labels only add; digit_run_min only goes down", () => {
    const t = tenant(
      (d) =>
        (d.redaction = { detectors: ["ssn"], digit_run_min: 6, labels: { name: ["nickname"] } }),
    );
    expect(problems({ global: global(), app: app(), tenant: t })).toEqual([
      "redaction.digit_run_min: 6 masks less than 5 in app:kvfcu",
    ]);
    const ok = mergePolicy({
      global: global(),
      app: app(),
      tenant: tenant((d) => (d.redaction = { digit_run_min: 4, labels: { name: ["nickname"] } })),
    });
    expect(ok.ok && ok.value.effective.redaction.digit_run_min).toBe(4);
    expect(ok.ok && ok.value.effective.redaction.labels.name).toEqual(["nickname"]);
    expect(ok.ok && ok.value.effective.redaction.detectors).toHaveLength(5);
  });

  test("display formats: a lower layer picks a subset", () => {
    const a = app((d) => (d.formats = { date: ["MM/DD/YYYY", "YYYY/MM/DD"] }));
    expect(problems({ global: global(), app: a })).toEqual([
      "formats.date: YYYY/MM/DD is not allowed by global",
    ]);
  });

  test("secrets: the tenant may narrow paths, never widen them or add a name", () => {
    const t = tenant((d) => {
      d.apps = {
        kvfcu: {
          secrets: {
            operator_password: { paths: ["/login", "/home"] },
            pin: { paths: ["/login"] },
          },
        },
      };
    });
    expect(problems({ global: global(), app: app(), tenant: t })).toEqual([
      "secrets.operator_password.paths: /home is not allowed by app:kvfcu",
      "secrets.pin: not declared by app:kvfcu",
    ]);
  });

  test("a secret path must be on the allowlist (section 4 §4.8)", () => {
    const a = app(
      (d) => (d.secrets = { operator_password: { kind: "password", paths: ["/signin"] } }),
    );
    expect(problems({ global: global(), app: a })).toEqual([
      "secrets.operator_password.paths: /signin is not on paths.allow",
    ]);
  });

  test("capabilities: deny lists add up at every layer", () => {
    const a = app((d) => (d.capabilities = { deny: ["kvfcu/delete_member@*"] }));
    const r = mergePolicy({ global: global(), app: a, tenant: tenant() });
    expect(r.ok && r.value.effective.capabilities.deny).toEqual([
      "kvfcu/close_account@*",
      "kvfcu/delete_member@*",
    ]);
  });
});

describe("bounds", () => {
  test("a pick inside the range holds; a missing pick takes the default", () => {
    const r = mergePolicy({
      global: global(),
      tenant: tenant((d) => (d.escalation = { approval_minutes: 20 })),
    });
    expect(r.ok && r.value.effective.escalation).toEqual({ approval_minutes: 20 });
    const def = mergePolicy({ global: global(), tenant: tenant() });
    expect(def.ok && def.value.effective.authorization.max_lifetime_minutes).toBe(30);
  });

  test("a pick outside the range fails", () => {
    const t = tenant((d) => {
      d.escalation = { approval_minutes: 200 };
      d.authorization = { max_lifetime_minutes: 1 };
    });
    expect(problems({ global: global(), tenant: t })).toEqual([
      "escalation.approval_minutes: 200 is outside 5 to 120 set by global",
      "authorization.max_lifetime_minutes: 1 is outside 5 to 120 set by global",
    ]);
  });

  test("an option outside the list fails", () => {
    const t = tenant((d) => {
      d.evidence = { level: "verbose" };
      d.discovery = { environments: ["test", "staging"] };
    });
    expect(problems({ global: global(), tenant: t })).toEqual([
      "discovery.environments: staging is not one of test, production set by global",
      "evidence.level: verbose is not one of minimal, standard, full set by global",
    ]);
  });

  test("a pick with no bound in global fails: the §4.7 short-form global has no retention bound", () => {
    expect(problems({ global: layer(GlobalPolicy, globalExample), tenant: tenant() })).toEqual([
      "discovery.environments: global sets no bound, so no layer may pick a value",
      "evidence.retention.debug_days: global sets no bound, so no layer may pick a value",
    ]);
  });

  test("require_signed may only turn on", () => {
    const g = global(
      (d) =>
        (d.authorization = {
          max_lifetime_minutes: { min: 5, max: 120, default: 30 },
          require_signed: true,
        }),
    );
    expect(
      problems({ global: g, tenant: tenant((d) => (d.authorization = { require_signed: false })) }),
    ).toEqual(["authorization.require_signed: false is looser than true in global"]);
  });
});

describe("missing layers", () => {
  test("with no app layer yet, the merge names it and allows no paths", () => {
    const r = mergePolicy({
      global: global(),
      tenant: tenant((d) => delete d.apps),
      appName: "kvfcu",
    });
    if (!r.ok) throw new Error(r.detail);
    expect(r.value.missing).toEqual(["app:kvfcu"]);
    expect(r.value.layers).toEqual({ global: 4, "tenant:keystone": 3 });
    expect(r.value.effective.paths.allow).toEqual([]);
  });

  test("a tenant cannot allow a path when no app layer allows it", () => {
    const t = tenant((d) => (d.apps = { kvfcu: { paths: { allow: ["/login"] } } }));
    expect(problems({ global: global(), tenant: t, appName: "kvfcu" })).toEqual([
      "paths.allow: /login is not allowed by global",
    ]);
  });

  test("a missing global value is the strictest", () => {
    const g = layer(GlobalPolicy, {
      schema: "intyy.policy/1.0",
      scope: { level: "global" },
      revision: 1,
      reason: "Empty floor.",
    });
    const r = mergePolicy({ global: g });
    if (!r.ok) throw new Error(r.detail);
    expect(r.value.effective.actions.types).toEqual([]);
    expect(r.value.effective.browser.popups).toBe("block");
    expect(r.value.effective.llm).toEqual({
      send_screenshots: false,
      mask_screenshots: true,
      replay_jev: false,
      replay_reviewer: false,
    });
    expect(r.value.effective.authorization.require_signed).toBe(true);
  });
});

describe("hash", () => {
  test("the same rules always give the same hash, whatever the key or list order", () => {
    const a = mergePolicy({ global: global(), app: app(), tenant: tenant() });
    const shuffled = global((d) => {
      const risk = d.risk as Record<string, string[]>;
      d.risk = {
        safe_words: [...(risk.safe_words ?? [])].reverse(),
        reversible_words: risk.reversible_words,
        irreversible_words: risk.irreversible_words,
      };
    });
    const b = mergePolicy({ tenant: tenant(), app: app(), global: shuffled });
    expect(a.ok && b.ok && a.value.hash === b.value.hash).toBe(true);
  });

  test("a different rule gives a different hash; a new reason alone does not", () => {
    const base = mergePolicy({ global: global(), tenant: tenant() });
    const stricter = mergePolicy({
      global: global(),
      tenant: tenant((d) => (d.approvals = { force_human: ["*", "kvfcu/*@1"] })),
    });
    const reworded = mergePolicy({
      global: global(),
      tenant: tenant((d) => (d.reason = "Same rules, new words.")),
    });
    expect(base.ok && stricter.ok && base.value.hash !== stricter.value.hash).toBe(true);
    expect(base.ok && reworded.ok && base.value.hash === reworded.value.hash).toBe(true);
  });
});
