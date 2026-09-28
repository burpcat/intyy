// The three-layer policy merge: global, then app, then tenant. Lower layers only tighten.
// Follows design section 4 §4.2 (merge kinds and the two app exceptions), §4.3 (loosening fails
// loudly), §4.4 (blocks), §4.5 (hash), §4.8 (loader checks), and §8.2 (secrets).
import { fail, ok, type Outcome } from "../../../ports/outcome.js";
import { hashJson } from "../../model/canonical.js";
import {
  layerName,
  type AppPolicy,
  type GlobalPolicy,
  type TenantPolicy,
} from "../../model/policy.js";

/** A bounded pick: a number, one option, or several options. */
type Pick = number | string | string[];

/** The one set of rules for a run (section 4 §4.1). Every list is sorted, so the hash is stable. */
export type EffectivePolicy = {
  app: string | null;
  tenant: string | null;
  actions: { types: string[]; keys: string[] };
  paths: { allow: string[]; deny: string[]; irreversible: string[]; case_sensitive: boolean };
  browser: {
    downloads: string;
    uploads: string;
    popups: string;
    native_dialogs: string;
    service_workers: string;
  };
  risk: {
    irreversible_words: string[];
    reversible_words: string[];
    safe_words: string[];
    key_labels: Record<string, string>;
  };
  secrets: Record<string, { kind: string; paths: string[] }>;
  redaction: {
    detectors: string[];
    digit_run_min: number | null;
    formats: { format: string; kind: string }[];
    labels: Record<string, string[]>;
  };
  formats: { date: string[]; money: string[] };
  correlation: { notes: boolean };
  capabilities: { allow: string[]; deny: string[] };
  approvals: { force_human: string[] };
  escalation: Record<string, number>;
  discovery: Record<string, Pick>;
  evidence: { level: string | null; retention: Record<string, number> };
  authorization: { max_lifetime_minutes: number | null; require_signed: boolean };
  llm: {
    send_screenshots: boolean;
    mask_screenshots: boolean;
    replay_jev: boolean;
    replay_reviewer: boolean;
  };
  request_index: Record<string, Pick>;
};

/** The merged rules, the layers that made them, and their hash (section 4 §4.5). */
export type MergeResult = {
  effective: EffectivePolicy;
  /** Each layer's revision. Example: `{ "global": 4, "app:kvfcu": 2, "tenant:keystone": 3 }`. */
  layers: Record<string, number>;
  /** Layers that do not exist yet. Example: `["app:kvfcu"]` before M03. */
  missing: string[];
  /** `sha256:` over the effective policy as canonical JSON. */
  hash: string;
};

/** The layers to merge. `appName` picks the tenant's `apps.<app>` part. */
export type MergeInput = {
  global: GlobalPolicy;
  app?: AppPolicy;
  tenant?: TenantPolicy;
  appName?: string;
};

/**
 * Browser switch values, from loosest to strictest. A missing value is the strictest.
 * Only the values section 4 §4.7 names (docs/decisions.md, M01).
 */
const BROWSER_ORDER = {
  downloads: ["block"],
  uploads: ["block"],
  popups: ["allowlist", "block"],
  native_dialogs: ["surface"],
  service_workers: ["block"],
} as const;

/** Each LLM switch's strict value. Off is stricter for sending and model rungs; on for masking. */
const LLM_STRICT = {
  send_screenshots: false,
  mask_screenshots: true,
  replay_jev: false,
  replay_reviewer: false,
} as const;

/** Sorted, without repeats. */
function set(items: Iterable<string>): string[] {
  return [...new Set(items)].sort();
}

/** Collects every problem, so one load names them all (section 4 §4.3). */
class Problems {
  readonly lines: string[] = [];

  /** A lower layer tried to allow what its parent does not. */
  notAllowed(field: string, item: string, parent: string): void {
    this.lines.push(`${field}: ${item} is not allowed by ${parent}`);
  }

  /** Any other problem. */
  add(line: string): void {
    this.lines.push(line);
  }
}

/** Allow list: a lower layer may remove items only (section 4 §4.2). */
function allowList(
  p: Problems,
  field: string,
  parent: readonly string[],
  child: readonly string[] | undefined,
  parentName: string,
): string[] {
  if (child === undefined) return set(parent);
  for (const item of child) if (!parent.includes(item)) p.notAllowed(field, item, parentName);
  return set(child.filter((i) => parent.includes(i)));
}

/** Restriction list: a lower layer may add items only. */
function restrictionList(
  parent: readonly string[],
  child: readonly string[] | undefined,
): string[] {
  return set([...parent, ...(child ?? [])]);
}

/** Ordered switch: a lower layer may move towards the strict end only. */
function orderedSwitch(
  p: Problems,
  field: string,
  order: readonly string[],
  parent: string,
  child: string | undefined,
  parentName: string,
): string {
  if (child === undefined) return parent;
  if (order.indexOf(child) < order.indexOf(parent)) {
    p.add(`${field}: ${child} is looser than ${parent} in ${parentName}`);
    return parent;
  }
  return child;
}

/** Boolean switch: a lower layer may turn it to `strict` only. */
function boolSwitch(
  p: Problems,
  field: string,
  strict: boolean,
  parent: boolean,
  child: boolean | undefined,
  parentName: string,
): boolean {
  if (child === undefined || child === parent) return parent;
  if (child !== strict) {
    p.add(`${field}: ${String(child)} is looser than ${String(parent)} in ${parentName}`);
    return parent;
  }
  return child;
}

/** A number range bound (section 4 §4.2, bounded setting). */
type Range = { min: number; max: number; default: number };
/** An options bound. */
type Options = { options: string[]; default: string | string[] };

/** Bounded setting: the tenant picks inside the global range, or gets the default. */
function pickIn(
  p: Problems,
  field: string,
  bound: Range | Options | undefined,
  pick: Pick | undefined,
): Pick | undefined {
  if (pick === undefined) return bound?.default;
  if (bound === undefined) {
    p.add(`${field}: global sets no bound, so no layer may pick a value`);
    return undefined;
  }
  if ("min" in bound) {
    if (typeof pick !== "number")
      p.add(`${field}: pick a number from ${String(bound.min)} to ${String(bound.max)}`);
    else if (pick < bound.min || pick > bound.max) {
      p.add(
        `${field}: ${String(pick)} is outside ${String(bound.min)} to ${String(bound.max)} set by global`,
      );
    }
    return pick;
  }
  const picked = [pick].flat();
  if (typeof pick === "number") p.add(`${field}: pick from ${bound.options.join(", ")}`);
  for (const v of picked) {
    if (typeof v === "string" && !bound.options.includes(v)) {
      p.add(`${field}: ${v} is not one of ${bound.options.join(", ")} set by global`);
    }
  }
  return pick;
}

/** Picks every key of a bounded block. */
function pickBlock(
  p: Problems,
  field: string,
  bounds: Record<string, Range | Options> | undefined,
  picks: Record<string, Pick> | undefined,
): Record<string, Pick> {
  const out: Record<string, Pick> = {};
  for (const key of set([...Object.keys(bounds ?? {}), ...Object.keys(picks ?? {})])) {
    const v = pickIn(p, `${field}.${key}`, bounds?.[key], picks?.[key]);
    if (v !== undefined) out[key] = Array.isArray(v) ? set(v) : v;
  }
  return out;
}

/** Numbers only, for blocks whose bounds are all ranges. */
function numbers(block: Record<string, Pick>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(block)) if (typeof v === "number") out[k] = v;
  return out;
}

/** Merges one layer's redaction labels into its parent's: labels only add (section 4 §9.7). */
function labels(
  parent: Record<string, string[]>,
  child: Partial<Record<string, string[]>> | undefined,
): Record<string, string[]> {
  const out: Record<string, string[]> = { ...parent };
  for (const [kind, words] of Object.entries(child ?? {}))
    out[kind] = restrictionList(out[kind] ?? [], words);
  return out;
}

/** The effective policy of the global layer alone. Missing values are the strictest. */
function fromGlobal(g: GlobalPolicy, p: Problems): EffectivePolicy {
  const browser = g.browser ?? {};
  const llm = g.llm ?? {};
  return {
    app: null,
    tenant: null,
    actions: { types: set(g.actions?.types ?? []), keys: set(g.actions?.keys ?? []) },
    paths: { allow: [], deny: [], irreversible: [], case_sensitive: true },
    browser: {
      downloads: browser.downloads ?? "block",
      uploads: browser.uploads ?? "block",
      popups: browser.popups ?? "block",
      native_dialogs: browser.native_dialogs ?? "surface",
      service_workers: browser.service_workers ?? "block",
    },
    risk: {
      irreversible_words: set(g.risk?.irreversible_words ?? []),
      reversible_words: set(g.risk?.reversible_words ?? []),
      safe_words: set(g.risk?.safe_words ?? []),
      key_labels: {},
    },
    secrets: {},
    redaction: {
      detectors: set(g.redaction?.detectors ?? []),
      digit_run_min: g.redaction?.digit_run_min ?? null,
      formats: g.redaction?.formats ?? [],
      labels: labels({}, g.redaction?.labels),
    },
    formats: { date: set(g.formats?.date ?? []), money: set(g.formats?.money ?? []) },
    correlation: { notes: false },
    capabilities: { allow: [], deny: set(g.capabilities?.deny ?? []) },
    approvals: { force_human: set(g.approvals?.force_human ?? []) },
    escalation: numbers(pickBlock(p, "escalation", g.escalation, undefined)),
    discovery: pickBlock(p, "discovery", g.discovery, undefined),
    evidence: {
      level: typeof g.evidence?.level?.default === "string" ? g.evidence.level.default : null,
      retention: numbers(pickBlock(p, "evidence.retention", g.evidence?.retention, undefined)),
    },
    authorization: {
      max_lifetime_minutes: g.authorization?.max_lifetime_minutes?.default ?? null,
      require_signed: g.authorization?.require_signed ?? true,
    },
    llm: {
      send_screenshots: llm.send_screenshots ?? LLM_STRICT.send_screenshots,
      mask_screenshots: llm.mask_screenshots ?? LLM_STRICT.mask_screenshots,
      replay_jev: llm.replay_jev ?? LLM_STRICT.replay_jev,
      replay_reviewer: llm.replay_reviewer ?? LLM_STRICT.replay_reviewer,
    },
    request_index: pickBlock(p, "request_index", g.request_index, undefined),
  };
}

/**
 * Applies the blocks both lower layers share: actions, browser, risk words, redaction, formats,
 * approvals, and llm. `appSafeWords` is the app layer's exception.
 */
function applyShared(
  e: EffectivePolicy,
  l: AppPolicy | TenantPolicy,
  parent: string,
  p: Problems,
  appSafeWords: boolean,
): void {
  e.actions.types = allowList(p, "actions.types", e.actions.types, l.actions?.types, parent);
  e.actions.keys = allowList(p, "actions.keys", e.actions.keys, l.actions?.keys, parent);
  for (const f of Object.keys(BROWSER_ORDER) as (keyof typeof BROWSER_ORDER)[]) {
    e.browser[f] = orderedSwitch(
      p,
      `browser.${f}`,
      BROWSER_ORDER[f],
      e.browser[f],
      l.browser?.[f],
      parent,
    );
  }
  e.risk.irreversible_words = restrictionList(
    e.risk.irreversible_words,
    l.risk?.irreversible_words,
  );
  // Why an allow list: a reversible word lowers an unsure label's class (section 4 §2.4).
  e.risk.reversible_words = allowList(
    p,
    "risk.reversible_words",
    e.risk.reversible_words,
    l.risk?.reversible_words,
    parent,
  );
  // Why: the app layer may add safe words for its app; irreversible words still win (section 4 §4.2).
  e.risk.safe_words = appSafeWords
    ? set([...e.risk.safe_words, ...(l.risk?.safe_words ?? [])])
    : allowList(p, "risk.safe_words", e.risk.safe_words, l.risk?.safe_words, parent);
  const r = l.redaction;
  e.redaction.detectors = restrictionList(e.redaction.detectors, r?.detectors);
  if (r?.digit_run_min !== undefined) {
    const cur = e.redaction.digit_run_min;
    if (cur !== null && r.digit_run_min > cur) {
      p.add(
        `redaction.digit_run_min: ${String(r.digit_run_min)} masks less than ${String(cur)} in ${parent}`,
      );
    } else e.redaction.digit_run_min = r.digit_run_min;
  }
  e.redaction.formats = [...e.redaction.formats, ...(r?.formats ?? [])];
  e.redaction.labels = labels(e.redaction.labels, r?.labels);
  e.formats.date = allowList(p, "formats.date", e.formats.date, l.formats?.date, parent);
  e.formats.money = allowList(p, "formats.money", e.formats.money, l.formats?.money, parent);
  e.approvals.force_human = restrictionList(e.approvals.force_human, l.approvals?.force_human);
  for (const f of Object.keys(LLM_STRICT) as (keyof typeof LLM_STRICT)[]) {
    e.llm[f] = boolSwitch(p, `llm.${f}`, LLM_STRICT[f], e.llm[f], l.llm?.[f], parent);
  }
}

/** Applies the app layer: it defines paths and secrets, and may add safe words. */
function applyApp(e: EffectivePolicy, a: AppPolicy, parent: string, p: Problems): void {
  applyShared(e, a, parent, p, true);
  e.app = a.scope.app;
  e.paths = {
    allow: set(a.paths?.allow ?? []),
    deny: set(a.paths?.deny ?? []),
    irreversible: set(a.paths?.irreversible ?? []),
    case_sensitive: a.paths?.case_sensitive ?? true,
  };
  e.risk.key_labels = { ...(a.risk?.key_labels ?? {}) };
  for (const [secret, s] of Object.entries(a.secrets ?? {})) {
    e.secrets[secret] = { kind: s.kind, paths: set(s.paths) };
  }
  // Why: the app layer is the one that may turn this on (section 4 §4.4, `correlation`).
  e.correlation.notes = a.correlation?.notes ?? false;
  e.capabilities.deny = restrictionList(e.capabilities.deny, a.capabilities?.deny);
}

/** Applies the tenant layer. It only tightens; it has no exceptions (section 4 §4.2). */
function applyTenant(
  e: EffectivePolicy,
  t: TenantPolicy,
  g: GlobalPolicy,
  appName: string | undefined,
  parent: string,
  p: Problems,
): void {
  applyShared(e, t, parent, p, false);
  e.tenant = t.scope.tenant;
  e.correlation.notes = boolSwitch(
    p,
    "correlation.notes",
    false,
    e.correlation.notes,
    t.correlation?.notes,
    parent,
  );
  e.capabilities.allow = set(t.capabilities?.allow ?? []);
  e.capabilities.deny = restrictionList(e.capabilities.deny, t.capabilities?.deny);

  const mine = appName === undefined ? undefined : t.apps?.[appName];
  if (mine?.paths) {
    e.paths.allow = allowList(p, "paths.allow", e.paths.allow, mine.paths.allow, parent);
    e.paths.deny = restrictionList(e.paths.deny, mine.paths.deny);
    e.paths.irreversible = restrictionList(e.paths.irreversible, mine.paths.irreversible);
  }
  for (const [secret, s] of Object.entries(mine?.secrets ?? {})) {
    const declared = e.secrets[secret];
    if (!declared) {
      p.add(`secrets.${secret}: not declared by ${parent}`);
      continue;
    }
    declared.paths = allowList(p, `secrets.${secret}.paths`, declared.paths, s.paths, parent);
  }

  e.escalation = numbers(pickBlock(p, "escalation", g.escalation, t.escalation));
  e.discovery = pickBlock(p, "discovery", g.discovery, t.discovery);
  e.request_index = pickBlock(p, "request_index", g.request_index, t.request_index);
  const level = pickIn(p, "evidence.level", g.evidence?.level, t.evidence?.level);
  e.evidence = {
    level: level === undefined ? null : String(level),
    retention: numbers(
      pickBlock(p, "evidence.retention", g.evidence?.retention, t.evidence?.retention),
    ),
  };
  const life = pickIn(
    p,
    "authorization.max_lifetime_minutes",
    g.authorization?.max_lifetime_minutes,
    t.authorization?.max_lifetime_minutes,
  );
  e.authorization = {
    max_lifetime_minutes: typeof life === "number" ? life : null,
    require_signed: boolSwitch(
      p,
      "authorization.require_signed",
      true,
      e.authorization.require_signed,
      t.authorization?.require_signed,
      "global",
    ),
  };
}

/** Loader check: every secret path is on the allowlist (section 4 §4.8). */
function checkSecretPaths(e: EffectivePolicy, p: Problems): void {
  for (const [secret, s] of Object.entries(e.secrets)) {
    for (const path of s.paths) {
      // ponytail: plain string match. M02's path matcher can also accept a path a pattern covers.
      if (!e.paths.allow.includes(path))
        p.add(`secrets.${secret}.paths: ${path} is not on paths.allow`);
    }
  }
}

/**
 * Merges the layers that exist into the effective policy, and hashes it.
 * Any loosening, out-of-bounds pick, or failed loader check fails the whole merge, with one
 * line per problem naming the field and the rule (section 4 §4.3).
 */
export function mergePolicy(input: MergeInput): Outcome<MergeResult, "loosening"> {
  const p = new Problems();
  const { global: g, app: a, tenant: t } = input;
  const appName = a?.scope.app ?? input.appName;
  if (a && input.appName !== undefined && a.scope.app !== input.appName) {
    throw new Error(`merge asked for app ${input.appName} but got ${layerName(a)}`);
  }
  const e = fromGlobal(g, p);
  const layers: Record<string, number> = { global: g.revision };
  const missing: string[] = [];
  let parent = "global";

  if (a) {
    applyApp(e, a, parent, p);
    layers[layerName(a)] = a.revision;
    parent = layerName(a);
  } else if (appName !== undefined) {
    missing.push(`app:${appName}`);
    e.app = appName;
  }
  if (t) {
    applyTenant(e, t, g, appName, parent, p);
    layers[layerName(t)] = t.revision;
  }
  checkSecretPaths(e, p);

  if (p.lines.length > 0) return fail("loosening", p.lines.join("\n"));
  return ok({ effective: e, layers, missing, hash: hashJson(e) });
}
