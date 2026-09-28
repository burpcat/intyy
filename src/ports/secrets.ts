// The secret port: turns a binding from bank settings into an opaque Secret.
// Follows design section 9 §5.6 and section 4 §8.3.
import type { Outcome } from "./outcome.js";
import type { Secret } from "./secret.js";

/**
 * Where a secret's value comes from (section 4 §8.3). Built: `env`, an environment variable name.
 * Example: `{ source: "env", key: "INTYY_KEYSTONE_KVFCU_OPERATOR_PASSWORD" }`.
 */
export type SecretBinding = { source: "env"; key: string };

/** The secret port. Used by the start check, injection at act time, and the request index key. */
export interface Secrets {
  /** Resolves a binding. `missing` means the source has no value. */
  resolve(b: SecretBinding, signal?: AbortSignal): Promise<Outcome<Secret, "missing">>;
}
