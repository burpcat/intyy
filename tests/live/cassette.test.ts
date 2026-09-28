// Replays the owner's real sign_in discovery on the bank app from its cassette, with no model.
// Then a cassette with one changed observation stops the run loudly. It uses the approved library
// files and the operator secrets from `.env`. Design section 9 §16 ("Planner cassette"); M03 task 13.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { EnvSecrets } from "../../src/adapters/env-secrets/secrets.js";
import { FileDocumentStore } from "../../src/adapters/files/document-store.js";
import { FileLockSlots, systemLockEnv } from "../../src/adapters/files/locks.js";
import { FileEvidenceStore } from "../../src/adapters/files/other-stores.js";
import { PlaywrightMarker } from "../../src/adapters/playwright/marker.js";
import { playwrightFactory } from "../../src/adapters/playwright/session.js";
import { SystemClock } from "../../src/adapters/system/clock.js";
import { SystemIds } from "../../src/adapters/system/ids.js";
import { loadDotEnv } from "../../src/cli/env.js";
import { LockManager } from "../../src/core/locks/manager.js";
import { Cassette } from "../../src/core/model/cassette.js";
import { Config } from "../../src/core/model/config.js";
import { policyKind, settingsKind } from "../../src/core/model/kinds.js";
import type { AppPolicy, GlobalPolicy, TenantPolicy } from "../../src/core/model/policy.js";
import { RunSpec } from "../../src/core/model/runspec.js";
import { runDiscovery, type DiscoveryResult } from "../../src/core/orchestrator/discovery.js";
import { mergePolicy } from "../../src/core/safety/policy/merge.js";
import { CassettePlanner } from "../../src/fakes/cassette-planner.js";
import { FakeOperator } from "../../src/fakes/operator.js";
import type { LockHold } from "../../src/ports/locks.js";
import type { DocumentStore } from "../../src/ports/stores.js";
import { tempRoot } from "../unit/safety/canary-kit.js";

const ROOT = join(import.meta.dirname, "../..");
const CASSETTE = join(ROOT, "tests/fixtures/cassettes/sign_in/cassette.json");
const VISIBLE = process.env.INTYY_VISIBLE === "1";

const config = Config.parse(JSON.parse(readFileSync(join(ROOT, "intyy.json"), "utf8")));
const tmpDir = join(ROOT, config.state, "var", "tmp");
const clock = new SystemClock();
const ids = new SystemIds(clock);
const locks = new LockManager(
  new FileLockSlots(join(ROOT, config.state, "var", "locks")),
  clock,
  systemLockEnv(),
);
let hold: LockHold | null = null;
const cleanups: (() => Promise<void>)[] = [];

/** The newest approved revision of one document, or a clear failure. */
async function approved<T>(
  store: DocumentStore<T>,
  id: string,
): Promise<{ doc: T; rev: string; hash: string }> {
  const rev = (await store.list({ id })).filter((s) => s.state === "approved").at(-1)?.rev;
  if (rev === undefined)
    throw new Error(`${id} has no approved revision. Seal and approve it first.`);
  const got = await store.get(id, rev);
  if (!got.ok) throw new Error(`${id} ${rev}: ${got.failure}`);
  return { doc: got.value.doc, rev, hash: got.value.hash };
}

/** Runs sign_in discovery on the bank app with `cassette` in place of the model. */
async function replay(cassette: Cassette): Promise<DiscoveryResult> {
  const lib = join(ROOT, config.library);
  const policies = new FileDocumentStore(policyKind, { dir: join(lib, "policy"), tmpDir }, clock);
  const settingsStore = new FileDocumentStore(
    settingsKind,
    { dir: join(lib, "settings"), tmpDir },
    clock,
  );
  const merged = mergePolicy({
    global: (await approved(policies, "global")).doc as GlobalPolicy,
    app: (await approved(policies, "app/kvfcu")).doc as AppPolicy,
    tenant: (await approved(policies, `tenant/${config.default_tenant}`)).doc as TenantPolicy,
    appName: "kvfcu",
  });
  if (!merged.ok) throw new Error(`the approved policy does not merge: ${merged.detail ?? ""}`);
  const settings = await approved(settingsStore, config.default_tenant);
  // Why: updates file §12, the CLI's .env loader; the test never prints a value.
  const env: Record<string, string | undefined> = { ...process.env };
  loadDotEnv(ROOT, env);
  const { root, remove } = await tempRoot("intyy-cassette-");
  cleanups.push(remove);
  const marker = new PlaywrightMarker();
  cleanups.push(() => marker.close());
  return runDiscovery(
    {
      runId: ids.runId(),
      spec: RunSpec.parse(JSON.parse(readFileSync(join(lib, "specs/kvfcu/sign_in.json"), "utf8"))),
      tenant: config.default_tenant,
      staff: "op_017",
      policy: merged.value,
      settings,
      engineVersion: "0.1.0",
      canaries: config.canary_members,
      visible: VISIBLE,
    },
    {
      evidence: new FileEvidenceStore({ root: join(root, "evidence"), tmpDir: join(root, "tmp") }),
      clock,
      ids,
      secrets: new EnvSecrets(env),
      surface: playwrightFactory(),
      marker,
      planner: new CassettePlanner(cassette),
      operator: () => new FakeOperator(),
    },
  );
}

/** The saved cassette. Task 12 writes it from the owner's real run. */
function saved(): Cassette {
  if (!existsSync(CASSETTE))
    throw new Error(
      "No sign_in cassette yet. Run the real discovery, then npm run canary:scan -- <run_id> --cassette sign_in.",
    );
  return Cassette.parse(JSON.parse(readFileSync(CASSETTE, "utf8")));
}

beforeAll(async () => {
  const taken = await locks.acquire("instance", "http_127.0.0.1_8080", {
    owner: ids.runId(),
    command: "test:live cassette",
    staff: null,
    waitMs: 0,
  });
  if (!taken.ok) throw new Error(`the bank app is busy: ${taken.detail ?? ""}`);
  hold = taken.value;
});

afterAll(async () => {
  for (const c of cleanups.splice(0)) await c();
  if (hold !== null) await locks.release(hold);
});

describe("sign_in cassette on the bank app", () => {
  test("the saved run replays to done accepted, with no model", async () => {
    const r = await replay(saved());
    expect(r).toMatchObject({ status: "success", code: null });
  });

  test("a changed observation stops the replay loudly", async () => {
    const c = saved();
    const first = c.turns[0];
    if (first === undefined) throw new Error("the cassette has no turns");
    const changed: Cassette = {
      ...c,
      turns: [
        { ...first, message: first.message.replace("<screen", "<screen data-changed") },
        ...c.turns.slice(1),
      ],
    };
    await expect(replay(changed)).rejects.toThrow(/turn 1 saw a changed observation/);
  });
});
