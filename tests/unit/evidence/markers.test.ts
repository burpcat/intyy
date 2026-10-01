// Proves `canaryMarkers`: the markers are `canary_members` from the config plus every secret value
// bound in the tenant's settings, resolved in memory; a binding with no value is named, never
// guessed. Updates file §12 ("Canary sources"); design section 4 §14. M07 task 10.
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { canaryMarkers } from "../../../src/core/evidence/markers.js";
import { Config } from "../../../src/core/model/config.js";
import { Settings } from "../../../src/core/model/settings.js";
import { MapSecrets } from "../../../src/fakes/secrets.js";

const CANARIES = Config.parse(JSON.parse(readFileSync("intyy.json", "utf8"))).canary_members;

/** Settings with two bound secrets and one request index key. */
const SETTINGS = Settings.parse({
  schema: "intyy.settings/1.0",
  tenant: "keystone",
  revision: 1,
  apps: {
    kvfcu: {
      origin: "http://127.0.0.1:9196",
      app_version: "8.4",
      environment: "test",
      locale: "en-US",
      time_zone: "America/New_York",
      extra_origins: [],
      secrets: {
        operator_user: { source: "env", key: "INTYY_TEST_OPERATOR_USER" },
        operator_password: { source: "env", key: "INTYY_TEST_OPERATOR_PASSWORD" },
      },
    },
  },
  system_secrets: {
    request_index_keys: [{ key_id: "k1", status: "current", source: "env", key: "INTYY_TEST_INDEX_KEY" }],
  },
});

describe("canaryMarkers", () => {
  test("values hold the canary members and every bound secret value", async () => {
    const secrets = new MapSecrets({
      INTYY_TEST_OPERATOR_USER: "made-up-user-1",
      INTYY_TEST_OPERATOR_PASSWORD: "made-up-pass-2",
      INTYY_TEST_INDEX_KEY: "made-up-key-3",
    });
    const got = await canaryMarkers(CANARIES, SETTINGS, secrets);
    expect(got.values).toEqual(expect.arrayContaining([...CANARIES, "made-up-user-1", "made-up-pass-2", "made-up-key-3"]));
    expect(got.values).toHaveLength(CANARIES.length + 3);
    expect(got.missing).toEqual([]);
  });

  test("a binding with no value is named in `missing`, and adds no marker", async () => {
    const secrets = new MapSecrets({ INTYY_TEST_OPERATOR_USER: "made-up-user-1", INTYY_TEST_INDEX_KEY: "made-up-key-3" });
    const got = await canaryMarkers(CANARIES, SETTINGS, secrets);
    expect(got.missing).toEqual(["INTYY_TEST_OPERATOR_PASSWORD"]);
    expect(got.values).toHaveLength(CANARIES.length + 2);
    expect(got.values).not.toContain("");
  });
});
