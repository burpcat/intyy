// The document kinds the M01 stores hold: policy layers and bank settings.
// Follows design section 9 §5.8 (one store per shape, a schema per record kind) and §6.2.
import { Pack, packScopeId } from "./pack.js";
import { parsePolicy, policyDocId, type Policy } from "./policy.js";
import type { DocKind } from "./sealing.js";
import { Settings } from "./settings.js";

/** Policy layers in `library/policy/`. IDs: `global`, `app/<app>`, `tenant/<tenant>`. */
export const policyKind: DocKind<Policy> = {
  name: "policy",
  parse: parsePolicy,
  revOf: (p) => String(p.revision),
  idOf: policyDocId,
};

/** Bank settings in `library/settings/`. ID: the tenant. */
export const settingsKind: DocKind<Settings> = {
  name: "settings",
  parse: (raw) => Settings.safeParse(raw),
  revOf: (s) => String(s.revision),
  idOf: (s) => s.tenant,
};

/** Handler packs in `library/packs/`. IDs: `global`, `app/<app>`, `app_version/<app>/<pattern>`,
 * `tenant/<tenant>/<app>` (section 9 §6.2). */
export const packKind: DocKind<Pack> = {
  name: "pack",
  parse: (raw) => Pack.safeParse(raw),
  revOf: (p) => String(p.revision),
  idOf: (p) => packScopeId(p.scope),
};
