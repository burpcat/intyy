// Proves the M01 schemas accept the design's examples and refuse what the loader checks forbid.
// Design section 9 §6.1, §6.4, §7.7, §12.1; section 4 §4.4, §4.7, §4.8, §5.3, §5.4.
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { Config } from "../../../src/core/model/config.js";
import { policyKind, settingsKind } from "../../../src/core/model/kinds.js";
import { LockFile } from "../../../src/core/model/lock.js";
import { parsePolicy, type Policy } from "../../../src/core/model/policy.js";
import type { DocumentStore } from "../../../src/ports/stores.js";
import { Settings } from "../../../src/core/model/settings.js";
import { hasRole, StaffFile, staffProblems } from "../../../src/core/model/staff.js";
import { IndexLine } from "../../../src/core/model/store-index.js";
import { FakeDocumentStore } from "../../../src/fakes/stores.js";
import { ManualClock } from "../../../src/fakes/clock.js";

/** Section 4 §4.7, global example. */
const globalExample = {
  schema: "intyy.policy/1.0",
  scope: { level: "global" },
  revision: 4,
  reason: "Add 'disburse' to irreversible words.",
  approved: { by: "op_002", at: "2026-09-20T09:00:00Z" },
  actions: {
    types: ["navigate", "click", "type", "select", "set_checked", "press", "read", "scroll"],
    keys: [
      "Enter",
      "Tab",
      "Escape",
      "ArrowUp",
      "ArrowDown",
      "ArrowLeft",
      "ArrowRight",
      "PageUp",
      "PageDown",
    ],
  },
  browser: {
    downloads: "block",
    uploads: "block",
    popups: "allowlist",
    native_dialogs: "surface",
    service_workers: "block",
  },
  risk: {
    irreversible_words: [
      "confirm",
      "submit",
      "transfer",
      "pay",
      "delete",
      "approve",
      "post",
      "save",
      "close account",
    ],
    reversible_words: ["add", "insert", "attach", "logout"],
    safe_words: ["search", "find", "view", "details", "open", "back", "close", "login"],
  },
  redaction: { detectors: ["ssn", "card", "email", "phone", "money"], digit_run_min: 5 },
  formats: {
    date: ["YYYY-MM-DD", "MM/DD/YYYY", "DD/MM/YYYY", "MM/DD/YY", "DD-MMM-YYYY"],
    money: ["0.00", "#,##0.00", "0"],
  },
  correlation: { notes: false },
  llm: { send_screenshots: true, mask_screenshots: true, replay_jev: true, replay_reviewer: true },
  evidence: { level: { options: ["minimal", "standard", "full"], default: "standard" } },
  authorization: { max_lifetime_minutes: { min: 5, max: 120, default: 30 }, require_signed: false },
  escalation: { approval_minutes: { min: 5, max: 120, default: 30 } },
};

/** Section 4 §4.7, app example, with the US format from updates file §3.1. */
const appExample = {
  schema: "intyy.policy/1.0",
  scope: { level: "app", app: "kvfcu" },
  revision: 2,
  reason: "Add the lookup pop-up path.",
  approved: { by: "op_002", at: "2026-09-22T11:00:00Z" },
  paths: {
    allow: [
      "/login",
      "/home",
      "/members/search",
      "/members/*",
      "/accounts/new",
      "/accounts/*",
      "/lookup/branch",
    ],
    deny: ["/admin/*", "/__test__/*"],
    irreversible: ["/accounts/*/close"],
    case_sensitive: true,
  },
  risk: { safe_words: ["enquiry"], key_labels: { F2: "search" } },
  secrets: {
    operator_username: { kind: "username", paths: ["/login"] },
    operator_password: { kind: "password", paths: ["/login"] },
  },
  redaction: {
    formats: [
      { format: "SH99999999", kind: "account" },
      { format: "CU9999999", kind: "member" },
    ],
  },
};

/** Section 4 §4.7, tenant example. */
const tenantExample = {
  schema: "intyy.policy/1.0",
  scope: { level: "tenant", tenant: "keystone" },
  revision: 3,
  reason: "Force approval on all commits. Keep debug files 14 days.",
  approved: { by: "op_017", at: "2026-09-24T08:00:00Z" },
  capabilities: { allow: ["kvfcu/*@1"], deny: ["kvfcu/close_account@*"] },
  approvals: { force_human: ["*"] },
  apps: { kvfcu: { paths: { deny: ["/lookup/branch"] } } },
  evidence: { level: "standard", retention: { debug_days: 14 } },
  discovery: { environments: ["test"] },
};

/** Section 4 §5.3, with build plan §9's locale and time zone. */
function settingsExample(): Record<string, unknown> {
  return {
    schema: "intyy.settings/1.0",
    tenant: "keystone",
    revision: 2,
    apps: {
      kvfcu: {
        origin: "http://127.0.0.1:4100",
        app_version: "8.4",
        environment: "test",
        locale: "en-US",
        time_zone: "America/New_York",
        extra_origins: [],
        secrets: {
          operator_username: { source: "env", key: "INTYY_KEYSTONE_KVFCU_OPERATOR_USERNAME" },
          operator_password: { source: "env", key: "INTYY_KEYSTONE_KVFCU_OPERATOR_PASSWORD" },
        },
      },
    },
    system_secrets: {
      request_index_keys: [
        {
          key_id: "k2",
          source: "env",
          key: "INTYY_KEYSTONE_REQUEST_INDEX_KEY_K2",
          status: "current",
        },
        {
          key_id: "k1",
          source: "env",
          key: "INTYY_KEYSTONE_REQUEST_INDEX_KEY_K1",
          status: "previous",
        },
      ],
    },
  };
}

/** Sets one field on the settings example's kvfcu app. */
function withApp(field: string, value: unknown): Record<string, unknown> {
  const s = settingsExample();
  const apps = s.apps as { kvfcu: Record<string, unknown> };
  apps.kvfcu[field] = value;
  return s;
}

describe("intyy.config/1.0", () => {
  test("the repo's intyy.json parses", () => {
    const raw: unknown = JSON.parse(readFileSync("intyy.json", "utf8"));
    expect(Config.safeParse(raw).success).toBe(true);
  });

  test("an unknown field fails", () => {
    const raw = JSON.parse(readFileSync("intyy.json", "utf8")) as Record<string, unknown>;
    expect(Config.safeParse({ ...raw, extra: 1 }).success).toBe(false);
  });
});

describe("intyy.staff/1.0", () => {
  const staff = StaffFile.parse({
    schema: "intyy.staff/1.0",
    staff: [
      { id: "op_017", roles: { "*": ["operator", "reviewer"] } },
      {
        id: "op_022",
        roles: { keystone: ["approver"], lakeshore: ["approver"], "*": ["operator", "reviewer"] },
      },
      { id: "op_031", roles: { "*": ["approver"] } },
    ],
  });

  test("roles per tenant; `*` covers every tenant; shared scope needs `*`", () => {
    expect(hasRole(staff, "op_017", "keystone", "reviewer")).toBe(true);
    expect(hasRole(staff, "op_022", "keystone", "approver")).toBe(true);
    expect(hasRole(staff, "op_022", "*", "approver")).toBe(false);
    expect(hasRole(staff, "op_031", "*", "approver")).toBe(true);
    expect(hasRole(staff, "op_017", "keystone", "approver")).toBe(false);
    expect(hasRole(staff, "op_999", "keystone", "operator")).toBe(false);
  });

  test("every tenant has an approver", () => {
    expect(staffProblems(staff, ["keystone"])).toEqual([]);
    const noApprover = StaffFile.parse({
      schema: "intyy.staff/1.0",
      staff: [{ id: "op_017", roles: { keystone: ["operator", "reviewer"] } }],
    });
    expect(staffProblems(noApprover)).toEqual(["tenant keystone has no approver"]);
  });

  test("a duplicate staff ID and an unknown role fail", () => {
    const dup = {
      schema: "intyy.staff/1.0",
      staff: [
        { id: "op_017", roles: { "*": ["operator"] } },
        { id: "op_017", roles: { "*": ["approver"] } },
      ],
    };
    expect(StaffFile.safeParse(dup).success).toBe(false);
    const role = {
      schema: "intyy.staff/1.0",
      staff: [{ id: "op_017", roles: { "*": ["admin"] } }],
    };
    expect(StaffFile.safeParse(role).success).toBe(false);
  });
});

describe("intyy.policy/1.0", () => {
  test("the three section 4 §4.7 examples parse", () => {
    expect(parsePolicy(globalExample).success).toBe(true);
    expect(parsePolicy(appExample).success).toBe(true);
    expect(parsePolicy(tenantExample).success).toBe(true);
  });

  test("a block at a level that forbids it fails (section 4 §4.4)", () => {
    expect(parsePolicy({ ...globalExample, paths: { allow: ["/login"] } }).success).toBe(false);
    expect(parsePolicy({ ...globalExample, secrets: {} }).success).toBe(false);
    expect(parsePolicy({ ...appExample, escalation: { approval_minutes: 30 } }).success).toBe(
      false,
    );
    expect(parsePolicy({ ...appExample, capabilities: { allow: ["kvfcu/*@1"] } }).success).toBe(
      false,
    );
    expect(parsePolicy({ ...tenantExample, paths: { allow: ["/login"] } }).success).toBe(false);
  });

  test("global correlation stays off", () => {
    expect(parsePolicy({ ...globalExample, correlation: { notes: true } }).success).toBe(false);
  });

  test("an unknown field or schema fails", () => {
    expect(parsePolicy({ ...tenantExample, surprise: true }).success).toBe(false);
    expect(parsePolicy({ ...tenantExample, schema: "intyy.policy/2.0" }).success).toBe(false);
    expect(parsePolicy({ ...tenantExample, scope: { level: "bank" } }).success).toBe(false);
  });

  test("words are lower case, one to three words", () => {
    const risk = (words: string[]) => ({ ...globalExample, risk: { irreversible_words: words } });
    expect(
      parsePolicy(risk(["close account", "mother's maiden name", "a/c no", "e-mail"])).success,
    ).toBe(true);
    expect(parsePolicy(risk(["Confirm"])).success).toBe(false);
    expect(parsePolicy(risk(["one two three four"])).success).toBe(false);
    expect(parsePolicy(risk([""])).success).toBe(false);
  });

  test("path patterns start with /; secrets need a kind and a path", () => {
    expect(parsePolicy({ ...appExample, paths: { allow: ["login"] } }).success).toBe(false);
    expect(
      parsePolicy({ ...appExample, secrets: { pin: { kind: "password", paths: [] } } }).success,
    ).toBe(false);
    expect(
      parsePolicy({ ...appExample, secrets: { pin: { kind: "pin", paths: ["/login"] } } }).success,
    ).toBe(false);
  });

  test("a bound needs min <= default <= max", () => {
    const bad = {
      ...globalExample,
      escalation: { approval_minutes: { min: 5, max: 120, default: 200 } },
    };
    expect(parsePolicy(bad).success).toBe(false);
  });

  test("errors name the field of the level the file declares", () => {
    const result = parsePolicy({ ...tenantExample, capabilities: { allow: ["not a pattern"] } });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["capabilities", "allow", 0]);
  });

  test("the store refuses a layer filed under another layer's ID", async () => {
    const store: DocumentStore<Policy> = new FakeDocumentStore(policyKind, new ManualClock());
    const candidate: Record<string, unknown> = { ...tenantExample };
    delete candidate.approved;
    const parsed = parsePolicy(candidate);
    if (!parsed.success) throw new Error("example did not parse");
    expect(await store.putCandidate("tenant/lakeshore", parsed.data, "op_017")).toMatchObject({
      ok: false,
      failure: "invalid",
      detail: "the file names tenant/keystone, but it is stored as tenant/lakeshore",
    });
    expect((await store.putCandidate("tenant/keystone", parsed.data, "op_017")).ok).toBe(true);
  });
});

describe("intyy.settings/1.0", () => {
  test("the section 4 §5.3 example parses, with locale and time zone", () => {
    expect(Settings.safeParse(settingsExample()).success).toBe(true);
  });

  test("origin uses https, except a loopback host", () => {
    expect(Settings.safeParse(withApp("origin", "https://kvfcu.keystone.example")).success).toBe(
      true,
    );
    expect(Settings.safeParse(withApp("origin", "http://localhost:8080")).success).toBe(true);
    expect(Settings.safeParse(withApp("origin", "http://kvfcu.keystone.example")).success).toBe(
      false,
    );
  });

  test("origin holds no path, user name, or password", () => {
    expect(Settings.safeParse(withApp("origin", "http://127.0.0.1:8080/login")).success).toBe(
      false,
    );
    expect(Settings.safeParse(withApp("origin", "http://127.0.0.1:8080/")).success).toBe(false);
    expect(
      Settings.safeParse(withApp("origin", "https://teller:pw@kvfcu.keystone.example")).success,
    ).toBe(false);
  });

  test("environment is test or production", () => {
    expect(Settings.safeParse(withApp("environment", "staging")).success).toBe(false);
  });

  test("locale and time zone must be real", () => {
    expect(Settings.safeParse(withApp("locale", "english")).success).toBe(false);
    expect(Settings.safeParse(withApp("time_zone", "Mars/Olympus_Mons")).success).toBe(false);
  });

  test("only the env source is built; a value-looking field fails", () => {
    const vault = { operator_password: { source: "vault", path: "kv/keystone/teller" } };
    expect(Settings.safeParse(withApp("secrets", vault)).success).toBe(false);
    const value = { operator_password: { source: "env", key: "hunter2" } };
    expect(Settings.safeParse(withApp("secrets", value)).success).toBe(false);
    const inline = { operator_password: { source: "env", key: "INTYY_X", value: "hunter2" } };
    expect(Settings.safeParse(withApp("secrets", inline)).success).toBe(false);
  });

  test("reserved tenant IDs fail (updates file §12)", () => {
    for (const tenant of ["artifacts", "trust", "tests"]) {
      expect(Settings.safeParse({ ...settingsExample(), tenant }).success).toBe(false);
    }
  });

  test("exactly one request index key is current", () => {
    const s = settingsExample();
    const keys = (s.system_secrets as { request_index_keys: { status: string }[] })
      .request_index_keys;
    for (const k of keys) k.status = "current";
    expect(Settings.safeParse(s).success).toBe(false);
  });

  test("the settings kind names the tenant as its store ID", () => {
    const parsed = Settings.parse(settingsExample());
    expect(settingsKind.idOf?.(parsed)).toBe("keystone");
    expect(settingsKind.revOf(parsed)).toBe("2");
  });
});

describe("intyy.index/1.0 and intyy.lock/1.0", () => {
  test("the section 9 §6.4 index line parses", () => {
    const line = {
      event: "sealed",
      kind: "artifact",
      id: "kvfcu/open_share_subaccount",
      rev: "1.0.0",
      path: "kvfcu/open_share_subaccount/1.0.0/artifact.json",
      hash: `sha256:${"9c1e".repeat(16)}`,
      by: "op_017",
      at: "2026-09-26T08:00:00Z",
    };
    expect(IndexLine.safeParse(line).success).toBe(true);
    expect(IndexLine.safeParse({ ...line, hash: "sha256:9c1e…" }).success).toBe(false);
  });

  test("a lock file holds owner, process, host, command, staff, and start time", () => {
    const lock = {
      schema: "intyy.lock/1.0",
      owner: "run_2026-09-24_7kq2m9x4tb",
      pid: 4242,
      host: "teller-mac",
      command: "replay",
      staff: "op_017",
      started_at: "2026-09-24T10:15:19.530Z",
    };
    expect(LockFile.safeParse(lock).success).toBe(true);
    expect(LockFile.safeParse({ ...lock, pid: 0 }).success).toBe(false);
  });
});
