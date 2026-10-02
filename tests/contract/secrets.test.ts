// Contract suite for the secret port: the env adapter and its map twin behave the same.
// Design section 9 §5.6 and §5.9.
import { describe, expect, test } from "vitest";
import { EnvSecrets } from "../../src/adapters/env-secrets/secrets.js";
import { MapSecrets } from "../../src/fakes/secrets.js";
import { Secret } from "../../src/ports/secret.js";
import type { Secrets } from "../../src/ports/secrets.js";

const KEY = "INTYY_KEYSTONE_KVFCU_OPERATOR_PASSWORD";

/** Runs the secret contract against one implementation, given its variables. */
function secretsContract(label: string, make: (values: Record<string, string>) => Secrets): void {
  describe(`Secrets contract: ${label}`, () => {
    test("a bound variable resolves to an opaque Secret; an unset or empty one is missing", async () => {
      const r = await make({ [KEY]: "teller-pass" }).resolve({ source: "env", key: KEY });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(Secret.open(r.value)).toBe("teller-pass");
      expect(JSON.stringify(r)).not.toContain("teller-pass");

      // an unset or empty variable is missing, and names only the key
      expect(await make({}).resolve({ source: "env", key: KEY })).toEqual({
        ok: false,
        failure: "missing",
        detail: KEY,
      });
      expect(await make({ [KEY]: "" }).resolve({ source: "env", key: KEY })).toMatchObject({
        failure: "missing",
      });
    });
  });
}

secretsContract("env", (values) => new EnvSecrets({ ...values }));
secretsContract("map", (values) => new MapSecrets(values));
