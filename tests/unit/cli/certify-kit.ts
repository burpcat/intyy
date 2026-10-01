// Shared helpers for the `certify --kind quick` CLI tests (design section 9 §9.1; section 8
// §7.1): one `intyy` call against a replay root with a route-mapping harness double (a copy of the
// helpers in certify.test.ts, with the route table and the harnesses made visible), and sealed,
// approved certify inputs whose fault set has a commit-point, an each-step, and a fixed profile.
// Not a test file. M08 task 1.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { wire as realWire, type Wiring } from "../../../src/cli/wiring.js";
import { commands } from "../../../src/cli/commands/index.js";
import { run } from "../../../src/cli/program.js";
import type { Io } from "../../../src/cli/output.js";
import { FakeHarness } from "../../../src/fakes/harness.js";
import { snapshotFactory } from "../../../src/fakes/snapshot-surface/index.js";
import { fixtureSite, MEMBER_FOUND } from "../replay/executor-harness.js";
import {
  idsNotifying,
  OPEN_SUB_ROUTE_FOR,
  RouteMappingHarness,
} from "../certify/route-mapping-harness.js";
import { REQUEST_INDEX_ENV, type ReplayEnv } from "./replay-harness.js";

const REQUEST_INDEX_KEY_VALUE = "test-request-index-key";

/** The capability every quick-batch test certifies. */
export const CAP = "kvfcu/open_sub@1";

/** What one call gave back, and the harness doubles it wired (to count harness calls). */
export type Call = {
  code: number;
  stdout: string;
  stderr: string;
  harnesses: RouteMappingHarness[];
};

/** Runs one `intyy` call as `staff`. `routeFor` is the route table the harness double invents. */
export async function certifyCall(
  env: ReplayEnv,
  staff: string,
  argv: readonly string[],
  routeFor: Readonly<Record<string, string>> = OPEN_SUB_ROUTE_FOR,
  /** Ports to swap in last, such as a `FakeScoreStore` whose writes fail (M10 task 1). */
  over: Partial<Wiring> = {},
): Promise<Call> {
  let stdout = "";
  let stderr = "";
  const harnesses: RouteMappingHarness[] = [];
  const io: Io = {
    stdout: { write: (t) => (stdout += t), isTTY: false },
    stderr: { write: (t) => (stderr += t), isTTY: false },
    stdin: { isTTY: false, readAll: () => Promise.resolve(""), question: () => Promise.resolve("") },
    env: { [REQUEST_INDEX_ENV]: REQUEST_INDEX_KEY_VALUE, INTYY_STAFF: staff },
    cwd: env.root,
  };
  const code = await run(argv, io, {
    commands,
    wire: (root, config, wireEnv) => {
      const real = realWire(root, config, wireEnv);
      const routeHarness = new RouteMappingHarness(new FakeHarness(), real.evidence, "keystone", routeFor);
      harnesses.push(routeHarness);
      return {
        ...real,
        policy: env.policy,
        settings: env.settings,
        ids: idsNotifying(real.ids, routeHarness),
        discovery: {
          surface: () => snapshotFactory(fixtureSite()),
          marker: real.discovery.marker,
          planner: () => {
            throw new Error("certify never opens a model");
          },
          operator: () => {
            throw new Error("certify never asks the CLI's own operator port");
          },
        },
        // Why a plain cast: `Wiring.harness` is typed to the concrete `KvfcuHarness`, but certify
        // only uses it through the `Harness` port (same cast as certify.test.ts).
        harness: (() => routeHarness) as unknown as typeof real.harness,
        ...over,
      };
    },
  });
  return { code, stdout, stderr, harnesses };
}

/** Edits a document through the `EDITOR: cp` trick. */
async function editWith(env: ReplayEnv, staff: string, argv: readonly string[], body: Record<string, unknown>): Promise<void> {
  const editedPath = join(env.root, `edited-${String(Math.random()).slice(2)}.json`);
  writeFileSync(editedPath, JSON.stringify(body));
  const io: Io = {
    stdout: { write: () => undefined, isTTY: false },
    stderr: { write: () => undefined, isTTY: false },
    stdin: { isTTY: false, readAll: () => Promise.resolve(""), question: () => Promise.resolve("") },
    env: { [REQUEST_INDEX_ENV]: REQUEST_INDEX_KEY_VALUE, INTYY_STAFF: staff, EDITOR: `cp "${editedPath}"` },
    cwd: env.root,
  };
  await run(argv, io, { commands });
}

/**
 * Seals and approves the suite, test data set, and fault profile set for `kvfcu/open_sub@1`.
 * The faults hold: `server_error` (`@each_request_step`), `reply_lost` (`@commit_point`), and
 * `server_error_on_search` (fixed `@step:click_search`, which a quick batch must not run).
 * `skip` leaves one of the three unapproved.
 */
export async function sealQuickInputs(env: ReplayEnv, skip?: "suite" | "testdata" | "faults"): Promise<void> {
  if (skip !== "suite") {
    await editWith(env, "op_017", ["suite", "edit", CAP], {
      schema: "intyy.suite/1.0",
      capability: CAP,
      revision: 1,
      reason: "Test suite.",
      classes: [{ id: "valid", inputs: { member_id: "@members.valid" }, expect: { status: "success" } }],
      matrix: { class: "valid", profiles: "standard" },
      stability: { class: "valid", levels: [0.05], seeds: 1, twins: false },
      drills: { count: 0 },
      extra: [],
      setup: [],
      provenance: { runs: [], decisions: [], sealed: null },
    });
    await certifyCall(env, "op_017", ["suite", "seal", CAP]);
    await certifyCall(env, "op_031", ["suite", "approve", CAP, "--rev", "1"]);
  }
  if (skip !== "testdata") {
    await editWith(env, "op_017", ["testdata", "edit", "kvfcu"], {
      schema: "intyy.testdata/1.0",
      tenant: "keystone",
      app: "kvfcu",
      revision: 1,
      pools: { "members.valid": [MEMBER_FOUND] },
      instance: { variant: "keystone", strip_semantics: false, drop_labels: 0, label_seed: "0" },
      business_date: "2026-01-15",
    });
    await certifyCall(env, "op_017", ["testdata", "seal", "kvfcu"]);
    await certifyCall(env, "op_022", ["testdata", "approve", "kvfcu", "--rev", "1"]);
  }
  if (skip !== "faults") {
    await editWith(env, "op_017", ["faults", "edit", "kvfcu"], {
      schema: "intyy.faults/1.0",
      app: "kvfcu",
      revision: 1,
      profiles: [
        { id: "server_error", kind: "server_error", at: "@each_request_step", expect_commit: "reconciles_absent", expect_window: "recovers" },
        { id: "reply_lost", kind: "drop_after_confirm", at: "@commit_point", expect_commit: "reconciles_found" },
        { id: "server_error_on_search", kind: "server_error", at: "@step:click_search", expect_commit: "recovers", expect_window: "recovers" },
      ],
    });
    await certifyCall(env, "op_017", ["faults", "seal", "kvfcu"]);
    await certifyCall(env, "op_031", ["faults", "approve", "kvfcu", "--rev", "1"]);
  }
}
