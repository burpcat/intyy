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

/** Section 2 §21, full example. Illustrative: the screens below are invented. */
export function artifactExample(): Record<string, unknown> {
  return {
    schema: "intyy.artifact/1.0",

    identity: {
      app: "kvfcu",
      capability: "open_share_subaccount",
      version: "1.0.0",
    },

    runs_on: {
      surface: "web",
      app_versions: ["8.*"],
      viewport: { width: 1280, height: 800, scale: 1 },
      entry: "/login",
      paths: ["/login", "/home", "/members/search", "/members/*", "/accounts/new"],
      session: null,
    },

    about: {
      title: "Open share sub-account",
      summary: "Opens a share sub-account for a member and returns its number.",
      when_to_use: "Use when a member asks to open a new share account.",
      limits: "Does not move money from other banks.",
    },

    contract: {
      inputs: [
        {
          name: "member_id",
          type: "string",
          description: "The member's ID number",
          required: true,
          sensitivity: "pii",
          constraints: { format: "digits", length: { min: 5, max: 8 } },
        },
        {
          name: "deposit",
          type: "money",
          description: "Opening deposit",
          required: true,
          sensitivity: "financial",
          constraints: { range: { min: "1.00", max: "10000.00" } },
        },
      ],
      outputs: [
        {
          name: "account_number",
          type: "string",
          description: "The new account's number",
          sensitivity: "financial",
        },
      ],
      outcomes: [
        {
          code: "member_not_found",
          description: "No member has this ID",
          condition: "no_member_text",
        },
      ],
      effect: "commits",
    },

    targets: [
      {
        id: "username_box",
        description: "User ID box on the login page",
        clues: { role: "textbox", name: "User ID", label: "User ID" },
      },
      {
        id: "password_box",
        description: "Password box on the login page",
        clues: { role: "textbox", name: "Password", label: "Password" },
      },
      {
        id: "login_button",
        description: "Login button",
        clues: { role: "button", name: "Login", text: "Login" },
      },
      {
        id: "search_panel",
        description: "Member search panel on the home page",
        clues: { role: "form", name: "Member Search" },
      },
      {
        id: "member_id_box",
        description: "Member ID box in the search panel",
        within: "search_panel",
        clues: { role: "textbox", label: "Member ID" },
      },
      {
        id: "search_button",
        description: "The Search button in the member panel",
        within: "search_panel",
        clues: {
          role: "button",
          name: "Search",
          text: "Search",
          region: { x: 0.72, y: 0.31, w: 0.08, h: 0.04 },
          image: "crops/search_button.png",
          path: "frame[main] > form > table > tr[2] > td[3] > input",
        },
      },
      {
        id: "results_table",
        description: "Search results table",
        clues: { role: "table", name: "Search results" },
      },
      {
        id: "member_row",
        description: "The result row for this member",
        within: "results_table",
        clues: { role: "row", text: "{input.member_id}" },
      },
      {
        id: "open_account_button",
        description: "Open New Account button on the member page",
        clues: { role: "button", name: "Open New Account" },
      },
      {
        id: "account_type_list",
        description: "Account type dropdown",
        clues: { role: "combobox", label: "Account Type" },
      },
      {
        id: "deposit_box",
        description: "Opening deposit box",
        clues: { role: "textbox", label: "Opening Deposit" },
      },
      {
        id: "notes_box",
        description: "Remarks box, used for the correlation reference",
        clues: { role: "textbox", label: "Remarks" },
      },
      {
        id: "confirm_button",
        description: "Confirm button on the account form",
        clues: { role: "button", name: "Confirm" },
      },
      {
        id: "confirmation_message",
        description: "Message that shows the new account number",
        clues: { text: "created", region: { x: 0.3, y: 0.2, w: 0.4, h: 0.05 } },
      },
    ],

    conditions: [
      {
        id: "login_page_shown",
        check: "all_of",
        description: "The login page is showing",
        checks: [
          { check: "location", pattern: "/login" },
          { check: "element_visible", target: "username_box" },
        ],
      },
      {
        id: "username_filled",
        check: "field_value",
        description: "The user ID box is not empty",
        target: "username_box",
        value: "*",
        match: "wildcard",
      },
      {
        id: "password_filled",
        check: "field_value",
        description: "The password box is not empty",
        target: "password_box",
        value: "*",
        match: "wildcard",
      },
      {
        id: "home_page_shown",
        check: "element_visible",
        description: "The member search box is showing",
        target: "member_id_box",
      },
      {
        id: "member_id_entered",
        check: "field_value",
        description: "The member ID box holds the input",
        target: "member_id_box",
        value: "{input.member_id}",
        match: "exact",
      },
      {
        id: "one_result_row",
        check: "count",
        description: "The results table has exactly one row",
        within: "results_table",
        item: "row",
        op: "equals",
        value: 1,
      },
      {
        id: "no_member_text",
        check: "text_visible",
        description: "The app says no member was found",
        text: "No member found",
        match: "contains",
      },
      {
        id: "member_page_shown",
        check: "all_of",
        description: "The member's page is showing",
        checks: [
          { check: "location", pattern: "/members/*" },
          { check: "text_visible", text: "{input.member_id}", match: "contains" },
        ],
      },
      {
        id: "account_form_shown",
        check: "element_visible",
        description: "The new account form is showing",
        target: "deposit_box",
      },
      {
        id: "savings_selected",
        check: "field_value",
        description: "Savings is chosen as the account type",
        target: "account_type_list",
        value: "Savings",
        match: "exact",
      },
      {
        id: "deposit_entered",
        check: "field_value",
        description: "The deposit box holds the input",
        target: "deposit_box",
        value: "{input.deposit}",
        match: "exact",
      },
      {
        id: "reference_entered",
        check: "field_value",
        description: "The remarks box holds the run ID",
        target: "notes_box",
        value: "{system.run_id}",
        match: "exact",
      },
      {
        id: "form_ready",
        check: "all_of",
        description: "The form is complete and Confirm is enabled",
        checks: [
          { ref: "savings_selected" },
          { ref: "deposit_entered" },
          { ref: "reference_entered" },
          { check: "element_state", target: "confirm_button", state: "enabled" },
        ],
      },
      {
        id: "confirmation_shown",
        check: "text_visible",
        description: "The app confirms the new account",
        text: "Account * created",
        match: "wildcard",
        within: "confirmation_message",
      },
    ],

    steps: [
      {
        id: "type_username",
        intent: "Enter the operator user ID",
        action: { type: "type", target: "username_box", value: "{secret.operator_username}" },
        precondition: "login_page_shown",
        checkpoint: "username_filled",
        outcomes: [],
        risk: "idempotent",
        timeout_ms: 5000,
      },
      {
        id: "type_password",
        intent: "Enter the operator password",
        action: { type: "type", target: "password_box", value: "{secret.operator_password}" },
        precondition: "login_page_shown",
        checkpoint: "password_filled",
        outcomes: [],
        risk: "idempotent",
        timeout_ms: 5000,
      },
      {
        id: "click_login",
        intent: "Log in",
        action: { type: "click", target: "login_button" },
        precondition: "password_filled",
        checkpoint: "home_page_shown",
        outcomes: [],
        risk: "idempotent",
        timeout_ms: 8000,
      },
      {
        id: "type_member_id",
        intent: "Enter the member ID",
        action: { type: "type", target: "member_id_box", value: "{input.member_id}" },
        precondition: "home_page_shown",
        checkpoint: "member_id_entered",
        outcomes: [],
        risk: "idempotent",
        timeout_ms: 5000,
      },
      {
        id: "click_search",
        intent: "Search for the member",
        action: { type: "click", target: "search_button" },
        precondition: "member_id_entered",
        checkpoint: "one_result_row",
        outcomes: ["member_not_found"],
        risk: "idempotent",
        timeout_ms: 8000,
      },
      {
        id: "open_member",
        intent: "Open the member's page",
        action: { type: "click", target: "member_row" },
        precondition: "one_result_row",
        checkpoint: "member_page_shown",
        outcomes: [],
        risk: "idempotent",
        timeout_ms: 8000,
      },
      {
        id: "open_account_form",
        intent: "Open the new account form",
        action: { type: "click", target: "open_account_button" },
        precondition: "member_page_shown",
        checkpoint: "account_form_shown",
        outcomes: [],
        risk: "idempotent",
        timeout_ms: 8000,
      },
      {
        id: "select_savings",
        intent: "Choose the savings account type",
        action: { type: "select", target: "account_type_list", value: "Savings" },
        precondition: "account_form_shown",
        checkpoint: "savings_selected",
        outcomes: [],
        risk: "idempotent",
        timeout_ms: 5000,
      },
      {
        id: "type_deposit",
        intent: "Enter the opening deposit",
        action: { type: "type", target: "deposit_box", value: "{input.deposit}" },
        precondition: "account_form_shown",
        checkpoint: "deposit_entered",
        outcomes: [],
        risk: "idempotent",
        timeout_ms: 5000,
      },
      {
        id: "type_reference",
        intent: "Write the run ID into Remarks for later matching",
        action: { type: "type", target: "notes_box", value: "{system.run_id}" },
        precondition: "account_form_shown",
        checkpoint: "reference_entered",
        outcomes: [],
        risk: "idempotent",
        timeout_ms: 5000,
      },
      {
        id: "click_confirm",
        intent: "Confirm and open the account",
        action: { type: "click", target: "confirm_button" },
        precondition: "form_ready",
        checkpoint: "confirmation_shown",
        outcomes: [],
        risk: "irreversible",
        timeout_ms: 15000,
      },
      {
        id: "read_account_number",
        intent: "Read the new account number",
        action: {
          type: "read",
          target: "confirmation_message",
          source: "text",
          output: "account_number",
          pattern: "Account * created",
        },
        precondition: "confirmation_shown",
        checkpoint: "confirmation_shown",
        outcomes: [],
        risk: "idempotent",
        timeout_ms: 5000,
      },
    ],

    recovery: {
      commit_point: "click_confirm",
      reconciliation: {
        check: {
          capability: "kvfcu/find_account_by_reference@1",
          inputs: { member_id: "{input.member_id}", reference: "{system.run_id}" },
          not_found_outcomes: ["not_found"],
          outputs: { account_number: "{result.account_number}" },
        },
      },
      compensated_by: {
        capability: "kvfcu/close_account@1",
        inputs: { account_number: "{output.account_number}" },
      },
    },

    provenance: {
      runs: [
        {
          run_id: "run_2026-09-24_7kq2m9x4tb",
          kind: "discovery",
          goal:
            "Open a share sub-account for member {input.member_id} with {input.deposit}. Return the new account number.",
          model: "claude-sonnet-5",
          recorder_version: "0.3.0",
        },
        {
          run_id: "run_2026-09-24_3hv8n0pzr6",
          kind: "negative_discovery",
          goal: "Look up member {input.member_id}",
          expected_outcome: "member_not_found",
          model: "claude-sonnet-5",
          recorder_version: "0.3.0",
        },
      ],
      derived_from: null,
      actions: [
        {
          run_id: "run_2026-09-24_7kq2m9x4tb",
          seq: 5,
          llm_tag: "flow_step",
          human_tag: "flow_step",
          decided_by: "op_017",
          became: "step:click_search",
        },
        {
          run_id: "run_2026-09-24_7kq2m9x4tb",
          seq: 6,
          llm_tag: "flow_step",
          human_tag: "incidental",
          decided_by: "op_017",
          became: "handler_draft:stay_signed_in",
        },
        {
          run_id: "run_2026-09-24_7kq2m9x4tb",
          seq: 9,
          llm_tag: "exploration",
          human_tag: "exploration",
          decided_by: "op_017",
          became: "dropped",
        },
      ],
      decisions: [
        {
          what: "risk",
          subject: "click_confirm",
          value: "irreversible",
          by: "op_017",
          at: "2026-09-24T14:02:00Z",
        },
        {
          what: "sensitivity",
          subject: "account_number",
          value: "financial",
          by: "op_017",
          at: "2026-09-24T14:03:00Z",
        },
        {
          what: "outcome_name",
          subject: "no_member_text",
          value: "member_not_found",
          by: "op_017",
          at: "2026-09-24T14:05:00Z",
        },
      ],
      sealed: { by: "op_017", at: "2026-09-24T14:10:00Z" },
    },
  };
}
