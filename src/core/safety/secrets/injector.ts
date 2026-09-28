// Secrets: the start check, and the injection rules the gate enforces at act time.
// Follows design section 4 §8.2 (declared in app policy), §8.3 (bound in settings), §8.4 (start
// check), §8.5 (injection rules; fetched per action), and §8.7 (fixed error text).
import { fail, ok, type Outcome } from "../../../ports/outcome.js";
import type { Secret } from "../../../ports/secret.js";
import type { SecretBinding, Secrets } from "../../../ports/secrets.js";
import type { FieldState } from "../../../ports/surface.js";
import type { EffectivePolicy } from "../policy/merge.js";
import { matchesAny, normalizePath, parsePattern, type PathMatcher } from "../policy/paths.js";

/** A reference to a secret, as a whole value: `{secret.operator_password}`. */
const WHOLE = /^\{secret\.([a-z][a-z0-9_]*)\}$/;

/** Any secret reference inside text. */
const ANY = /\{secret\.[a-z][a-z0-9_]*\}/;

/**
 * Reads a typed text for secret references (rule `secret.whole_value`, section 4 §8.5).
 * `{secret.x}` alone names secret `x`. A reference joined with other text is `joined`.
 */
export function secretInText(text: string): { name: string } | "joined" | null {
  const whole = WHOLE.exec(text);
  if (whole?.[1] !== undefined) return { name: whole[1] };
  return ANY.test(text) ? "joined" : null;
}

/** Where the injector reads from: the merged policy's declarations and the settings' bindings. */
export type SecretSources = {
  declared: EffectivePolicy["secrets"];
  bindings: Readonly<Record<string, SecretBinding>>;
  port: Secrets;
};

/**
 * The start check (section 4 §8.4): each required secret has a binding, and its source has a
 * value. The value is not kept. `detail` names the gaps, never a value.
 */
export async function startCheck(
  required: readonly string[],
  s: SecretSources,
  signal?: AbortSignal,
): Promise<Outcome<void, "secret_unavailable">> {
  const gaps: string[] = [];
  for (const name of [...new Set(required)].sort()) {
    const binding = s.bindings[name];
    if (binding === undefined) {
      gaps.push(`${name}: no binding in settings`);
      continue;
    }
    const got = await s.port.resolve(binding, signal);
    if (!got.ok) gaps.push(`${name}: ${binding.key} has no value`);
  }
  return gaps.length === 0 ? ok(undefined) : fail("secret_unavailable", gaps.join("; "));
}

/** The fixed error for a failed secret-typing action (section 4 §8.7). */
export function secretErrorText(name: string, target: string): string {
  return `Typing {secret.${name}} into ${target} failed.`;
}

/** Applies the injection rules and fetches values, one action at a time (section 4 §8.5). */
export class SecretInjector {
  readonly #paths = new Map<string, PathMatcher[]>();

  constructor(
    private readonly s: SecretSources,
    private readonly caseSensitive: boolean,
  ) {
    for (const [name, d] of Object.entries(s.declared)) {
      this.#paths.set(
        name,
        d.paths.map((p) => {
          const m = parsePattern(p);
          if (!m.ok) throw new Error(`policy holds a bad secret path: ${p}`);
          return m.value;
        }),
      );
    }
  }

  /**
   * Checks one secret for one field on one page. Returns the blocking rule, or null.
   * An undeclared secret has no pages, so it fails `secret.path`.
   */
  check(
    name: string,
    pageUrl: string,
    field: FieldState | undefined,
  ): "secret.path" | "secret.field_kind" | null {
    const paths = this.#paths.get(name);
    const declared = this.s.declared[name];
    if (paths === undefined || declared === undefined || !URL.canParse(pageUrl))
      return "secret.path";
    const u = new URL(pageUrl);
    const n = normalizePath(u.pathname + u.search, this.caseSensitive);
    if (!n.ok || !matchesAny(paths, n.value, this.caseSensitive)) return "secret.path";
    if (field === undefined || (field.kind !== "text" && field.kind !== "password")) {
      return "secret.field_kind";
    }
    // Why: section 4 §8.5, a password secret goes only into a password field, and the reverse.
    const passwordSecret = declared.kind === "password";
    return passwordSecret === (field.kind === "password") ? null : "secret.field_kind";
  }

  /**
   * Fetches a value just before typing (section 4 §8.5, "When the value is fetched").
   * Never cached: every call asks the port again.
   */
  async fetch(name: string, signal?: AbortSignal): Promise<Outcome<Secret, "secret_unavailable">> {
    const binding = this.s.bindings[name];
    if (binding === undefined) return fail("secret_unavailable", `${name}: no binding in settings`);
    const got = await this.s.port.resolve(binding, signal);
    return got.ok ? got : fail("secret_unavailable", `${name}: ${binding.key} has no value`);
  }
}
