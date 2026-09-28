// The fake secret port: a map from variable name to value.
// Follows design section 9 §5.9 (secrets: a map).
import { fail, ok, type Outcome } from "../ports/outcome.js";
import { Secret } from "../ports/secret.js";
import type { SecretBinding, Secrets } from "../ports/secrets.js";

/** Secrets from a map. An absent or empty name is `missing`, like the env adapter. */
export class MapSecrets implements Secrets {
  readonly #values: Map<string, string>;

  /** Secrets keyed by variable name. */
  constructor(values: Record<string, string> = {}) {
    this.#values = new Map(Object.entries(values));
  }

  /** Resolves one binding. */
  resolve(b: SecretBinding): Promise<Outcome<Secret, "missing">> {
    const value = this.#values.get(b.key);
    if (value === undefined || value === "") return Promise.resolve(fail("missing", b.key));
    return Promise.resolve(ok(new Secret(value)));
  }
}
