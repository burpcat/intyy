// The policy file (`intyy.policy/1.0`): one schema per layer, global, app, and tenant.
// Follows design section 4 §4.4 (blocks per level), §4.5 (head fields), §4.7, §4.8, §8.2,
// and the updates file §3 (US detectors and labels). Every block is optional (§4.4).
import { z } from "zod";
import {
  AppId,
  CapabilityPattern,
  KeyName,
  PathPattern,
  SecretName,
  TenantId,
  Word,
} from "./common.js";
import { Approval } from "./store-index.js";

/** Action types (section 4 §6.9). */
export const ActionType = z.enum([
  "navigate",
  "click",
  "type",
  "select",
  "set_checked",
  "press",
  "read",
  "scroll",
]);

/** Built-in detectors, US set (updates file §3.1). */
export const Detector = z.enum(["ssn", "card", "email", "phone", "money"]);

/** Redaction kinds that labels and ID formats may name (section 4 §9.7, updates file §3). */
export const RedactionKind = z.enum([
  "name",
  "address",
  "ssn",
  "dob",
  "phone",
  "email",
  "member",
  "account",
  "money",
  "card",
]);

const Words = z.array(Word);
const Patterns = z.array(PathPattern);
const CapPatterns = z.array(CapabilityPattern);

/** A number range a lower layer picks inside (section 4 §4.2, bounded setting). */
export const RangeBound = z
  .object({ min: z.number().int(), max: z.number().int(), default: z.number().int() })
  .strict()
  .refine((b) => b.min <= b.default && b.default <= b.max, "min <= default <= max");

/** A list of options a lower layer picks from. */
export const OptionsBound = z
  .object({
    options: z.array(z.string().min(1)).min(1),
    default: z.union([z.string(), z.array(z.string())]),
  })
  .strict()
  .refine(
    (b) => [b.default].flat().every((d) => b.options.includes(d)),
    "the default is one of the options",
  );

/** Any bound. */
export const Bound = z.union([RangeBound, OptionsBound]);

/** A value picked inside a bound: a number, one option, or several options. */
export const Pick = z.union([z.number().int(), z.string(), z.array(z.string())]);

const Actions = z
  .object({ types: z.array(ActionType).optional(), keys: z.array(KeyName).optional() })
  .strict();

/** Browser switches (section 4 §6.10). Only the values the design names. */
const Browser = z
  .object({
    downloads: z.enum(["block"]).optional(),
    uploads: z.enum(["block"]).optional(),
    popups: z.enum(["allowlist", "block"]).optional(),
    native_dialogs: z.enum(["surface"]).optional(),
    service_workers: z.enum(["block"]).optional(),
  })
  .strict();

const RiskWords = {
  irreversible_words: Words.optional(),
  reversible_words: Words.optional(),
  safe_words: Words.optional(),
};

/** One ID shape pattern for masking (section 4 §9.8). Example: `{ "format": "SH99999999", "kind": "account" }`. */
const IdFormat = z.object({ format: z.string().min(1), kind: RedactionKind }).strict();

const Redaction = z
  .object({
    detectors: z.array(Detector).optional(),
    digit_run_min: z.number().int().positive().optional(),
    formats: z.array(IdFormat).optional(),
    /** Sensitive label words per kind (section 4 §9.7; field name per docs/decisions.md, M01). */
    labels: z.partialRecord(RedactionKind, Words).optional(),
  })
  .strict();

/** Named display formats (section 4 §4.4, `formats`). */
const Formats = z
  .object({
    date: z.array(z.string().min(1)).optional(),
    money: z.array(z.string().min(1)).optional(),
  })
  .strict();

const Approvals = z.object({ force_human: CapPatterns.optional() }).strict();

const Llm = z
  .object({
    send_screenshots: z.boolean().optional(),
    mask_screenshots: z.boolean().optional(),
    replay_jev: z.boolean().optional(),
    replay_reviewer: z.boolean().optional(),
  })
  .strict();

/** Fields every policy file starts with (section 4 §4.5). */
const head = {
  schema: z.literal("intyy.policy/1.0"),
  revision: z.number().int().positive(),
  reason: z.string().min(1),
  approved: Approval.optional(),
};

/** The global layer: the floor for everyone. */
export const GlobalPolicy = z
  .object({
    ...head,
    scope: z.object({ level: z.literal("global") }).strict(),
    actions: Actions.optional(),
    browser: Browser.optional(),
    risk: z.object(RiskWords).strict().optional(),
    redaction: Redaction.optional(),
    formats: Formats.optional(),
    correlation: z
      .object({ notes: z.literal(false) })
      .strict()
      .optional(),
    capabilities: z.object({ deny: CapPatterns.optional() }).strict().optional(),
    approvals: Approvals.optional(),
    escalation: z.record(z.string(), RangeBound).optional(),
    discovery: z.record(z.string(), Bound).optional(),
    evidence: z
      .object({
        level: OptionsBound.optional(),
        retention: z.record(z.string(), RangeBound).optional(),
      })
      .strict()
      .optional(),
    authorization: z
      .object({
        max_lifetime_minutes: RangeBound.optional(),
        require_signed: z.boolean().optional(),
      })
      .strict()
      .optional(),
    llm: Llm.optional(),
    request_index: z.record(z.string(), Bound).optional(),
  })
  .strict();

/** The app layer: facts about one vendor app. */
export const AppPolicy = z
  .object({
    ...head,
    scope: z.object({ level: z.literal("app"), app: AppId }).strict(),
    actions: Actions.optional(),
    paths: z
      .object({
        allow: Patterns.optional(),
        deny: Patterns.optional(),
        irreversible: Patterns.optional(),
        case_sensitive: z.boolean().optional(),
      })
      .strict()
      .optional(),
    browser: Browser.optional(),
    risk: z
      .object({ ...RiskWords, key_labels: z.record(KeyName, Word).optional() })
      .strict()
      .optional(),
    secrets: z
      .record(
        SecretName,
        z
          .object({ kind: z.enum(["username", "password", "code"]), paths: Patterns.min(1) })
          .strict(),
      )
      .optional(),
    redaction: Redaction.optional(),
    formats: Formats.optional(),
    correlation: z.object({ notes: z.boolean() }).strict().optional(),
    capabilities: z.object({ deny: CapPatterns.optional() }).strict().optional(),
    approvals: Approvals.optional(),
    llm: Llm.optional(),
  })
  .strict();

/** A tenant's per-app narrowing (section 4 §4.1: app-specific parts sit under `apps.<app>`). */
const TenantApp = z
  .object({
    paths: z
      .object({
        allow: Patterns.optional(),
        deny: Patterns.optional(),
        irreversible: Patterns.optional(),
      })
      .strict()
      .optional(),
    secrets: z.record(SecretName, z.object({ paths: Patterns }).strict()).optional(),
  })
  .strict();

/** The tenant layer: one bank's restrictions and choices. It only tightens. */
export const TenantPolicy = z
  .object({
    ...head,
    scope: z.object({ level: z.literal("tenant"), tenant: TenantId }).strict(),
    actions: Actions.optional(),
    browser: Browser.optional(),
    risk: z.object(RiskWords).strict().optional(),
    redaction: Redaction.optional(),
    formats: Formats.optional(),
    correlation: z.object({ notes: z.boolean() }).strict().optional(),
    capabilities: z
      .object({ allow: CapPatterns.optional(), deny: CapPatterns.optional() })
      .strict()
      .optional(),
    approvals: Approvals.optional(),
    escalation: z.record(z.string(), z.number().int()).optional(),
    discovery: z.record(z.string(), Pick).optional(),
    evidence: z
      .object({
        level: z.string().optional(),
        retention: z.record(z.string(), z.number().int()).optional(),
      })
      .strict()
      .optional(),
    authorization: z
      .object({
        max_lifetime_minutes: z.number().int().optional(),
        require_signed: z.boolean().optional(),
      })
      .strict()
      .optional(),
    llm: Llm.optional(),
    request_index: z.record(z.string(), Pick).optional(),
    apps: z.record(AppId, TenantApp).optional(),
  })
  .strict();

/** Any policy layer. */
export const Policy = z.union([GlobalPolicy, AppPolicy, TenantPolicy]);

/** The global layer. */
export type GlobalPolicy = z.infer<typeof GlobalPolicy>;
/** An app layer. */
export type AppPolicy = z.infer<typeof AppPolicy>;
/** A tenant layer. */
export type TenantPolicy = z.infer<typeof TenantPolicy>;
/** Any policy layer. */
export type Policy = z.infer<typeof Policy>;

/**
 * Parses a policy with the schema its `scope.level` names, so errors name the right fields.
 * A missing or unknown level falls back to the union's error.
 */
export function parsePolicy(raw: unknown): z.ZodSafeParseResult<Policy> {
  const level =
    raw !== null &&
    typeof raw === "object" &&
    "scope" in raw &&
    raw.scope !== null &&
    typeof raw.scope === "object" &&
    "level" in raw.scope
      ? raw.scope.level
      : undefined;
  if (level === "global") return GlobalPolicy.safeParse(raw);
  if (level === "app") return AppPolicy.safeParse(raw);
  if (level === "tenant") return TenantPolicy.safeParse(raw);
  return Policy.safeParse(raw);
}

/** The layer's name in errors and logs. Examples: `global`, `app:kvfcu`, `tenant:keystone`. */
export function layerName(p: Policy): string {
  if (p.scope.level === "global") return "global";
  return p.scope.level === "app" ? `app:${p.scope.app}` : `tenant:${p.scope.tenant}`;
}

/** The layer's ID in the policy store. Examples: `global`, `app/kvfcu`, `tenant/keystone`. */
export function policyDocId(p: Policy): string {
  return layerName(p).replace(":", "/");
}
