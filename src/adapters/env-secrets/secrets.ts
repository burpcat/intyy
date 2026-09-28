// The secret port on environment variables: the variables that bank settings bind.
// Follows design section 9 §5.6 and section 4 §8.3 (`env` source), §8.4 (start check).
import { fail, ok, type Outcome } from "../../ports/outcome.js";
import { Secret } from "../../ports/secret.js";
import type { SecretBinding, Secrets } from "../../ports/secrets.js";

/** Reads secret values from environment variables. An unset or empty variable is `missing`. */
export class EnvSecrets implements Secrets {
  readonly #env: Record<string, string | undefined>;

  /** Reads from `env`, usually `process.env` after the `.env` loader ran. */
  constructor(env: Record<string, string | undefined>) {
    this.#env = env;
  }

  /** Resolves one binding. The value stays inside an opaque Secret. */
  resolve(b: SecretBinding): Promise<Outcome<Secret, "missing">> {
    const value = this.#env[b.key];
    if (value === undefined || value === "") return Promise.resolve(fail("missing", b.key));
    return Promise.resolve(ok(new Secret(value)));
  }
}
