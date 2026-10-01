// Types and small helpers `artifact-checks.ts` and `artifact-checks-recovery.ts` both need.
// Split out only because one file holding every section 2 §19 check ran past 400 lines.
// Follows design section 2 §7.2 (value references) and §7.3 (wildcards).
import type { Artifact } from "./artifact.js";

/** One problem the loader found. `level` depends on `mode`: see `checkArtifact`. */
export type ArtifactProblem = {
  readonly code: string;
  readonly path: string;
  readonly message: string;
  readonly level: "error" | "blocking";
};

/** Strict runs at sealing. Candidate lets the review-only gaps of section 6 §14.15 through. */
export type ArtifactMode = "strict" | "candidate";

/** What another capability's artifact promises, for the checks that need one (§19.4, §19.7). */
export type CapabilityShape = {
  readonly effect: "read_only" | "commits";
  readonly inputs: readonly string[];
  readonly outputs: readonly string[];
  /** Each output's value type by name (like `{ subaccount_count: "integer" }`). Omitted: types unknown. */
  readonly outputTypes?: Readonly<Record<string, string>>;
  readonly session: string | null;
};

/**
 * Outside facts a pure loader check cannot know on its own (section 2 §19.6, §19.7, §19.8).
 * Every field is optional; a missing one skips that one check, rather than guessing.
 */
export type ArtifactCheckContext = {
  /** True when `pattern` sits inside the merged global+app policy allowlist (§19.6). */
  pathAllowed?(pattern: string): boolean;
  /** True when `name` is a declared secret in the app's policy layer (§19.6). */
  secretDeclared?(name: string): boolean;
  /** Looks up a linked capability's shape, or `undefined` when it cannot be resolved. */
  resolveCapability?(link: string): CapabilityShape | undefined;
  /** The global list of display formats for one value type (§19.8). */
  formatsFor?(type: string): readonly string[] | undefined;
};

/** Pushes one problem. `blockable` checks are `blocking` in candidate mode, `error` in strict. */
export type Reporter = (code: string, path: string, message: string, blockable?: boolean) => void;

/** ID pools gathered once, so every check can resolve a reference without re-scanning. */
export type Facts = {
  readonly targetIds: ReadonlySet<string>;
  readonly conditionIds: ReadonlySet<string>;
  readonly inputNames: ReadonlySet<string>;
  readonly outputNames: ReadonlySet<string>;
  /** Target IDs a `type` step fills with a whole, valid `{secret.*}` value. */
  readonly secretTargets: ReadonlySet<string>;
};

/** A reference resolves to nothing declared. Shared: every block hits this the same way. */
export const D_REF = "dangling_ref";
/** A reference sits where section 2 §7.2's table forbids its namespace. */
export const BAD_NS = "bad_namespace";

/** A `{namespace.name}` reference, wherever it sits in a string (section 2 §7.2). */
const REF_RE = /\{(input|system|secret|output|result)\.([a-z][a-z0-9_]*)\}/g;

/** Every reference found in `text`, in order. */
export function scanRefs(text: string): { ns: string; name: string }[] {
  const out: { ns: string; name: string }[] = [];
  for (const m of text.matchAll(REF_RE)) {
    const ns = m[1];
    const name = m[2];
    if (ns !== undefined && name !== undefined) out.push({ ns, name });
  }
  return out;
}

/**
 * True when `value` matches `pattern`'s wildcard text; `*` matches one or more characters,
 * never `/` (section 2 §7.3). Query strings are not part of `runs_on.entry` or a `navigate`
 * location in practice, so this ignores them.
 * ponytail: no query-string matching; add it if a spec ever needs one here.
 */
function matchesPattern(pattern: string, value: string): boolean {
  const parts = pattern.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`^${parts.join("[^/]+")}$`).test(value);
}

/** True when `value` matches any pattern in `patterns`. */
export function matchesAnyPattern(patterns: readonly string[], value: string): boolean {
  return patterns.some((p) => matchesPattern(p, value));
}

/** Builds a {@link Reporter} bound to one problem list and one mode. */
export function makeReporter(problems: ArtifactProblem[], mode: ArtifactMode): Reporter {
  return (code, path, message, blockable = false) => {
    problems.push({ code, path, message, level: blockable && mode === "candidate" ? "blocking" : "error" });
  };
}

/**
 * Checks every reference in `text` against the namespaces section 2 §7.2 allows there, then
 * against the pool a resolvable namespace names. `resultNames` is the linked reconciliation
 * capability's outputs, known only when `resolveCapability` resolved it.
 */
export function checkNamespace(
  text: string,
  allowed: ReadonlySet<string>,
  path: string,
  facts: Facts,
  report: Reporter,
  resultNames?: readonly string[],
): void {
  for (const r of scanRefs(text)) {
    if (!allowed.has(r.ns)) {
      report(BAD_NS, path, `{${r.ns}.${r.name}} is not allowed here (section 2 §7.2)`);
      continue;
    }
    if (r.ns === "input" && !facts.inputNames.has(r.name)) {
      report(D_REF, path, `{input.${r.name}} is not a declared input`);
    }
    if (r.ns === "system" && r.name !== "run_id") {
      report(D_REF, path, `{system.${r.name}} is not a known system value`);
    }
    if (r.ns === "output" && !facts.outputNames.has(r.name)) {
      report(D_REF, path, `{output.${r.name}} is not a declared output`);
    }
    if (r.ns === "result" && resultNames !== undefined && !resultNames.includes(r.name)) {
      report(D_REF, path, `{result.${r.name}} is not one of the linked capability's outputs`);
    }
  }
}

/** Target IDs a `type` step fills with a whole, valid `{secret.*}` value (section 2 §19.2). */
export function computeSecretTargets(artifact: Artifact): Set<string> {
  const set = new Set<string>();
  for (const step of artifact.steps) {
    if (step.action.type !== "type") continue;
    const ref = scanRefs(step.action.value).find((r) => r.ns === "secret");
    if (ref !== undefined && step.action.value.trim() === `{secret.${ref.name}}`) {
      set.add(step.action.target);
    }
  }
  return set;
}
