// The allowlist: where intyy may go (hosts × paths) and what each actor may do there.
// Follows design section 4 §6.1 (three parts), §6.2 (hosts), §6.4 (deny and irreversible paths),
// §6.8 (request kinds), §6.9 (action types and keys per actor), and §6.10 (pop-ups).
import type { AllowVerdict, Allowlist, RequestKind } from "../../../ports/surface.js";
import type { ActionType } from "../../model/policy.js";
import type { Actor } from "../rules.js";
import type { EffectivePolicy } from "./merge.js";
import { matchesAny, normalizePath, parsePattern, type PathMatcher } from "./paths.js";

/** What the allowlist is built from: settings give hosts, the merged policy gives paths. */
export type AllowlistInput = {
  /** The app's origin from settings. Example: `http://127.0.0.1:8080`. */
  origin: string;
  /** Extra origins from settings. They share the app's path rules (section 4 §6.1). */
  extraOrigins: readonly string[];
  paths: EffectivePolicy["paths"];
  browser: Pick<EffectivePolicy["browser"], "popups">;
};

/** Parses patterns that the policy loader already checked. A failure here is a bug. */
function compile(patterns: readonly string[]): PathMatcher[] {
  return patterns.map((text) => {
    const p = parsePattern(text);
    if (!p.ok) throw new Error(`policy holds a bad path pattern: ${text}`);
    return p.value;
  });
}

/** The origin of a URL, with `ws` read as `http` and `wss` as `https`. Null when not a web URL. */
function webOrigin(u: URL): string | null {
  const scheme = { "http:": "http:", "https:": "https:", "ws:": "http:", "wss:": "https:" }[
    u.protocol
  ];
  return scheme === undefined ? null : `${scheme}//${u.host}`;
}

/**
 * Builds the allowlist the gate and the network guard share (section 4 §6.1).
 * Hosts match exactly: scheme, host, and port (§6.2). `deny` beats `allow` (§6.4).
 */
export function buildAllowlist(input: AllowlistInput): Allowlist {
  const hosts = new Set([input.origin, ...input.extraOrigins]);
  const allow = compile(input.paths.allow);
  const deny = compile(input.paths.deny);
  const irreversible = compile(input.paths.irreversible);
  const caseSensitive = input.paths.case_sensitive;

  function check(url: string, kind: RequestKind): AllowVerdict {
    if (!URL.canParse(url)) return { allowed: false, rule: "allowlist.host" };
    const u = new URL(url);
    const origin = webOrigin(u);
    if (origin === null || !hosts.has(origin)) return { allowed: false, rule: "allowlist.host" };
    // Why: section 4 §6.8, other requests and WebSockets need an allowed host only.
    if (kind !== "document") return { allowed: true, irreversible: false };
    const n = normalizePath(u.pathname + u.search, caseSensitive);
    if (!n.ok) return { allowed: false, rule: "allowlist.path_malformed" };
    if (matchesAny(deny, n.value, caseSensitive) || !matchesAny(allow, n.value, caseSensitive)) {
      return { allowed: false, rule: "allowlist.path" };
    }
    return { allowed: true, irreversible: matchesAny(irreversible, n.value, caseSensitive) };
  }

  return { check, popups: input.browser.popups === "allowlist" };
}

/** Action types an artifact step may use (section 2 §15.2). `scroll` is discovery only. */
const ARTIFACT_TYPES: readonly ActionType[] = [
  "navigate",
  "click",
  "type",
  "select",
  "set_checked",
  "press",
  "read",
];

/** Action types per actor (section 4 §6.9). `human` is observed, never gated (§7.10). */
const TYPES_BY_ACTOR: Record<Exclude<Actor, "human">, readonly ActionType[]> = {
  engine: ARTIFACT_TYPES,
  handler: ARTIFACT_TYPES.filter((t) => t !== "read"),
  llm: [...ARTIFACT_TYPES, "scroll"],
  reviewer: ["click", "select", "set_checked", "press", "type", "navigate"],
};

/**
 * Checks an action type for one actor (gate check 2, section 4 §3.3). The merged policy's list
 * narrows every actor. Returns the rule that blocks, or null.
 */
export function checkActionType(
  actor: Actor,
  type: ActionType,
  policyTypes: readonly string[],
): "allowlist.action" | null {
  if (actor === "human") return null;
  return TYPES_BY_ACTOR[actor].includes(type) && policyTypes.includes(type)
    ? null
    : "allowlist.action";
}

/** Keys the reviewer may press (section 4 §6.9). */
const REVIEWER_KEYS = ["Tab", "Escape"];

/** True for a function key, like `F2` or `F10`. */
export function isFunctionKey(key: string): boolean {
  return /^F\d{1,2}$/.test(key);
}

/**
 * Checks a `press` key (section 4 §6.9, "Keys"). A function key needs an app mapping in
 * `key_labels`; an unmapped one is blocked. Other keys must be on the merged list.
 */
export function checkKey(
  actor: Actor,
  key: string,
  policy: Pick<EffectivePolicy, "actions" | "risk">,
): "allowlist.key" | null {
  if (actor === "human") return null;
  if (actor === "reviewer" && !REVIEWER_KEYS.includes(key)) return "allowlist.key";
  const allowed = isFunctionKey(key)
    ? key in policy.risk.key_labels
    : policy.actions.keys.includes(key);
  return allowed ? null : "allowlist.key";
}
