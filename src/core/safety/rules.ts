// The gate's rule IDs and actors. Every `gate` log line names one rule in `why.ref`.
// Follows design section 4 §3.3 (actors) and §3.6 (rule IDs). The list lives in code (§3.6).

/** Who proposes an action (section 4 §3.3). */
export type Actor = "engine" | "handler" | "llm" | "reviewer" | "human";

/** Every rule ID of section 4 §3.6. A new one is a minor log format change. */
export const RULE_IDS = [
  "lease.not_holder",
  "allowlist.action",
  "allowlist.key",
  "allowlist.host",
  "allowlist.path",
  "allowlist.path_malformed",
  "helper.path",
  "secret.whole_value",
  "secret.path",
  "secret.field_kind",
  "value.mask_token",
  "browser.download",
  "browser.upload",
  "browser.prompt",
  "risk.allowed",
  "risk.unsure",
  "risk.needs_approval",
  "risk.authorized",
  "risk.human_approved",
  "risk.read_only_run",
  "risk.actor",
  "risk.second_commit",
  "risk.in_flight",
  "risk.live_mismatch",
  "human.observed",
] as const;

/** One rule ID. Example: `allowlist.path`. */
export type RuleId = (typeof RULE_IDS)[number];
