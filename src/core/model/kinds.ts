// The document kinds the M01 stores hold: policy layers, bank settings, handler packs, and the
// M06 certify inputs (suites, test data, fault profiles).
// Follows design section 9 §5.8 (one store per shape, a schema per record kind) and §6.2.
import { Faults } from "./faults.js";
import { Pack, packScopeId } from "./pack.js";
import { parsePolicy, policyDocId, type Policy } from "./policy.js";
import type { DocKind } from "./sealing.js";
import { Settings } from "./settings.js";
import { Suite } from "./suite.js";
import { Thresholds, thresholdsId } from "./thresholds.js";
import { Testdata } from "./testdata.js";

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

/** Certify suites in `library/suites/`. ID: `<app>/<capability>@<major>` (section 8 §6.1). */
export const suiteKind: DocKind<Suite> = {
  name: "suite",
  parse: (raw) => Suite.safeParse(raw),
  revOf: (s) => String(s.revision),
  idOf: (s) => s.capability,
};

/** Test data sets in `library/testdata/`. ID: `<tenant>/<app>` (section 8 §6.2). */
export const testdataKind: DocKind<Testdata> = {
  name: "testdata",
  parse: (raw) => Testdata.safeParse(raw),
  revOf: (t) => String(t.revision),
  idOf: (t) => `${t.tenant}/${t.app}`,
};

/** Fault profile sets in `library/faults/`. ID: `<app>` (section 8 §6.3). */
export const faultsKind: DocKind<Faults> = {
  name: "faults",
  parse: (raw) => Faults.safeParse(raw),
  revOf: (f) => String(f.revision),
  idOf: (f) => f.app,
};

/** jev threshold records in `library/thresholds/`. ID: `<app>/<jev_version>` (section 8 §14.1). */
export const thresholdsKind: DocKind<Thresholds> = {
  name: "thresholds",
  parse: (raw) => Thresholds.safeParse(raw),
  revOf: (t) => String(t.revision),
  idOf: thresholdsId,
};
