// The design's example files, shared by the schema and merge tests.
// Design section 4 §4.7 (policy layers) and §5.3 (settings), with updates file §3.1.

/** Section 4 §4.7, global example. */
export const globalExample = {
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
export const appExample = {
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
export const tenantExample = {
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
export function settingsExample(): Record<string, unknown> {
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
