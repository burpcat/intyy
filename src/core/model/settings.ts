// The bank settings file (`intyy.settings/1.0`): where apps live, which version, secret sources.
// Follows design section 4 §5 and §8.3, §8.11; the updates file §12 (reserved tenant IDs).
import { z } from "zod";
import { AppId, Origin, SecretName, TenantId } from "./common.js";
import { Approval } from "./store-index.js";

/** Tenant IDs that clash with folders under `evidence/` (updates file §12). */
export const RESERVED_TENANTS = ["artifacts", "trust", "tests"] as const;

/**
 * A secret binding's variable name. Why the `INTYY_` prefix: it follows section 4 §8.3's
 * convention, and a secret value pasted by mistake fails the load (§5.4).
 */
const BindingKey = z
  .string()
  .regex(/^INTYY_[A-Z0-9_]+$/, "a variable name like INTYY_KEYSTONE_KVFCU_OPERATOR_PASSWORD");

/** Where one secret value comes from. `env` is built; `vault` is design only (section 4 §8.3). */
export const SecretBinding = z.object({ source: z.literal("env"), key: BindingKey }).strict();

/** A BCP 47 locale, language and optional region. Example: `en-US`. */
const Locale = z.string().regex(/^[a-z]{2,3}(-[A-Z]{2})?$/, "a locale like en-US");

/** An IANA time zone this Node knows. Example: `America/New_York`. */
const TimeZone = z.string().refine((tz) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}, "an IANA time zone like America/New_York");

/** One app at this bank (section 4 §5.2). `locale` and `time_zone` per docs/decisions.md (M01). */
export const AppSettings = z
  .object({
    origin: Origin,
    app_version: z.string().min(1),
    environment: z.enum(["test", "production"]),
    locale: Locale,
    time_zone: TimeZone,
    extra_origins: z.array(Origin),
    secrets: z.record(SecretName, SecretBinding),
  })
  .strict();

/** One request index key (section 4 §8.11). */
const RequestIndexKey = z
  .object({
    key_id: z.string().regex(/^k\d+$/, "a key ID like k1"),
    source: z.literal("env"),
    key: BindingKey,
    status: z.enum(["current", "previous"]),
  })
  .strict();

/** The settings file for one tenant. Facts only, never rules. */
export const Settings = z
  .object({
    schema: z.literal("intyy.settings/1.0"),
    tenant: TenantId.refine(
      (t) => !(RESERVED_TENANTS as readonly string[]).includes(t),
      "this tenant ID is reserved under evidence/",
    ),
    revision: z.number().int().positive(),
    apps: z.record(AppId, AppSettings),
    system_secrets: z
      .object({
        request_index_keys: z
          .array(RequestIndexKey)
          .refine(
            (keys) => keys.filter((k) => k.status === "current").length === 1,
            "exactly one request index key is current",
          ),
      })
      .strict()
      .optional(),
    approved: Approval.optional(),
  })
  .strict();

/** A settings file. */
export type Settings = z.infer<typeof Settings>;

/** Every secret binding in a settings file, with a label for output. Values never appear. */
export function settingsBindings(s: Settings): { label: string; key: string }[] {
  const out: { label: string; key: string }[] = [];
  for (const [app, a] of Object.entries(s.apps)) {
    for (const [name, b] of Object.entries(a.secrets))
      out.push({ label: `${app}.${name}`, key: b.key });
  }
  for (const k of s.system_secrets?.request_index_keys ?? []) {
    out.push({ label: `request_index_key.${k.key_id}`, key: k.key });
  }
  return out;
}
