// Shared fixture for the evidence publish tests: one real certify batch (a clean baseline and one
// fault case, run on the fakes), copied out of the fake evidence store into a `FakeFileTree`
// laid out like `state/evidence/`, plus a library tree holding the sealed artifacts those runs
// used. Not a test file. Design section 9 §6.6, updates file §12.
import { runCertifyCase, type CertifyDeps } from "../../../src/core/certify/runner.js";
import type { FaultProfile } from "../../../src/core/model/faults.js";
import { sealHash } from "../../../src/core/model/sealing.js";
import { FakeFileTree } from "../../../src/fakes/file-tree.js";
import { FakeHarness } from "../../../src/fakes/harness.js";
import { ManualClock } from "../../../src/fakes/clock.js";
import { idsNotifying, OPEN_SUB_ROUTE_FOR, RouteMappingHarness } from "../certify/route-mapping-harness.js";
import { MEMBER_FOUND, MEMBER_MISSING, OPEN_SUB, SIGN_IN, TENANT, buildHarness, fixtureSite } from "../replay/executor-harness.js";

export { TENANT };

/** The profile of the one fault case: a server error on the search click, which recovers. */
const PROFILE: FaultProfile = {
  id: "server_error_on_search",
  kind: "server_error",
  at: "@step:click_search",
  expect_commit: "recovers",
  expect_window: "recovers",
};

/** What a test gets: the three trees, the clock, and the IDs of what was seeded. */
export type Fixture = {
  source: FakeFileTree;
  library: FakeFileTree;
  dest: FakeFileTree;
  clock: ManualClock;
  batchId: string;
  baselineRunId: string;
  caseRunId: string;
  /** Artifact IDs the runs name, like `kvfcu/open_sub@1.0.0`, found in the runs' `run_start` lines. */
  artifactIds: string[];
};

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Reads a JSON file out of a tree. */
export async function readJson(tree: FakeFileTree, path: string): Promise<Record<string, unknown>> {
  const got = await tree.read(path);
  if (!got.ok) throw new Error(`no ${path}`);
  return JSON.parse(dec.decode(got.value)) as Record<string, unknown>;
}

/** Writes a JSON file into a tree (a plain `seed`, so a test can edit a copy). */
export function putJson(tree: FakeFileTree, path: string, value: unknown): void {
  tree.seed(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** The path of one file of a source run. */
export const runPath = (runId: string, file = "run.json"): string => `${TENANT}/runs/${runId}/${file}`;

/**
 * Runs one real certify case on the fakes and copies its evidence into trees. The source tree
 * holds `<tenant>/runs/<id>/…`, `<tenant>/batches/<batch>/{plan,report}.json`, and the tenant
 * `index.jsonl`; the library holds each artifact the runs name, with a sealed index line.
 */
export async function certifyFixture(): Promise<Fixture> {
  const h = await buildHarness(fixtureSite());
  const harness = new RouteMappingHarness(new FakeHarness(), h.deps.evidence, TENANT, OPEN_SUB_ROUTE_FOR);
  const ids = idsNotifying(h.deps.ids, harness);
  const deps: CertifyDeps = { ...h.deps, ids, harness, policy: h.policy, settings: h.settings, engineVersion: "0.1.0" };
  const batchId = ids.batchId();
  const result = await runCertifyCase(
    {
      batchId,
      tenant: TENANT,
      app: "kvfcu",
      capability: "open_sub",
      major: 1,
      appVersion: "8.4",
      staff: "op_017",
      className: "valid",
      selection: { kind: "profile", profile: PROFILE },
      at: undefined,
      classes: [{ id: "valid", inputs: { member_id: "@members.valid" }, expect: { status: "success" } }],
      pools: { "members.valid": [MEMBER_FOUND], "members.missing": [MEMBER_MISSING] },
      instance: { variant: "keystone", strip_semantics: false, drop_labels: 0, label_seed: "0" },
    },
    deps,
  );
  if (!result.ok) throw new Error("the fixture's certify case did not run");
  const { plan, report } = result.value;

  const source = new FakeFileTree();
  const artifactIds = new Set<string>();
  for (const c of plan.cases) {
    const folder = await h.deps.evidence.openRun(TENANT, c.run_id);
    const runJson = await h.deps.evidence.readRunJson(TENANT, c.run_id);
    if (!folder.ok || !runJson.ok) throw new Error(`no folder for ${c.run_id}`);
    putJson(source, runPath(c.run_id), runJson.value);
    const files = (runJson.value as { files: { path: string }[] }).files;
    for (const f of files) {
      const bytes = await folder.value.readFile(f.path);
      if (!bytes.ok) throw new Error(`no ${f.path}`);
      source.seed(runPath(c.run_id, f.path), bytes.value);
    }
    const events = await h.deps.evidence.events(TENANT, c.run_id);
    if (!events.ok) throw new Error("no events");
    for (const e of events.value) {
      const line = e as { event?: string; data?: { frozen?: { artifact?: { id?: string } | null; session?: { id?: string } | null } } };
      if (line.event !== "run_start") continue;
      for (const id of [line.data?.frozen?.artifact?.id, line.data?.frozen?.session?.id]) if (id !== undefined) artifactIds.add(id);
    }
  }
  const index = await h.deps.evidence.index(TENANT);
  if (!index.ok) throw new Error("no index");
  source.seed(`${TENANT}/index.jsonl`, `${index.value.map((l) => JSON.stringify(l)).join("\n")}\n`);
  putJson(source, `${TENANT}/batches/${batchId}/plan.json`, plan);
  putJson(source, `${TENANT}/batches/${batchId}/report.json`, report);

  const library = new FakeFileTree();
  const lines: string[] = [];
  for (const id of artifactIds) {
    const m = /^(.+)@(.+)$/.exec(id);
    if (m?.[1] === undefined || m[2] === undefined) throw new Error(`odd artifact id ${id}`);
    const doc = m[1].endsWith("/sign_in") ? SIGN_IN : OPEN_SUB;
    const path = `${m[1]}/${m[2]}/artifact.json`;
    putJson(library, path, doc);
    lines.push(
      JSON.stringify({ event: "sealed", kind: "artifact", id: m[1], rev: m[2], path, hash: sealHash(JSON.parse(JSON.stringify(doc))), by: "op_017", at: "2026-01-15T08:00:00.000Z" }),
    );
  }
  library.seed("index.jsonl", `${lines.join("\n")}\n`);

  const caseRunId = plan.cases.find((c) => c.case_id === "case")?.run_id;
  const baselineRunId = plan.cases.find((c) => c.case_id === "baseline")?.run_id;
  if (caseRunId === undefined || baselineRunId === undefined) throw new Error("no runs in the plan");
  return {
    source,
    library,
    dest: new FakeFileTree(),
    clock: new ManualClock("2026-02-01T10:00:00.000Z"),
    batchId,
    baselineRunId,
    caseRunId,
    artifactIds: [...artifactIds].sort(),
  };
}

/** UTF-8 bytes of a string. */
export const bytesOf = (s: string): Uint8Array => enc.encode(s);
