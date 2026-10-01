// Proves `publishEvidence` and `verifyEvidence`: a clean publish copies a run, its batch, and the
// sealed artifacts it used, and writes the manifest; a canary hit or any broken check refuses and
// writes nothing; links resolve; artifact copies match their seal hashes; verify finds each kind
// of damage. The source is one real certify batch run on the fakes (tests/unit/evidence/kit.ts),
// copied into fake file trees. Canary values come from `intyy.json` at run time, never a literal.
// Design section 9 §6.6, updates file §12, section 4 §14; M07 task 10.
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { sha256Hex } from "../../../src/core/model/canonical.js";
import { Config } from "../../../src/core/model/config.js";
import { PublishManifest } from "../../../src/core/model/publish.js";
import { sealHash } from "../../../src/core/model/sealing.js";
import { publishEvidence, verifyEvidence, type PublishInput } from "../../../src/core/evidence/publish.js";
import { FakeFileTree } from "../../../src/fakes/file-tree.js";
import { bytesOf, certifyFixture, putJson, readJson, runPath, TENANT, type Fixture } from "./kit.js";

/** The canary member numbers, read from the config at run time. */
const CANARIES = Config.parse(JSON.parse(readFileSync("intyy.json", "utf8"))).canary_members;
const CANARY = CANARIES[0] ?? "";
/** A made-up bound secret value, the second marker. */
const SECRET = "wb-token-7f3q-made-up";
const MARKERS = [CANARY, SECRET];

const dec = new TextDecoder();
const text = async (tree: FakeFileTree, path: string): Promise<string> => {
  const got = await tree.read(path);
  if (!got.ok) throw new Error(`no ${path}`);
  return dec.decode(got.value);
};

/** A copy of `tree` without the files `drop` names (the fake has no delete). */
async function without(tree: FakeFileTree, drop: (path: string) => boolean): Promise<FakeFileTree> {
  const copy = new FakeFileTree();
  for (const p of tree.paths()) if (!drop(p)) copy.seed(p, await text(tree, p));
  return copy;
}

/** One publish of the fixture. */
function publish(f: Fixture, targets: PublishInput["targets"], extra: Partial<PublishInput> = {}) {
  return publishEvidence(
    { tenant: TENANT, targets, by: "op_017", markers: MARKERS, ...extra },
    { source: f.source, library: f.library, dest: f.dest, clock: f.clock },
  );
}
const runTarget = (id: string): PublishInput["targets"] => [{ kind: "run", id }];

/** Edits one source run's `run.json`. */
async function editRunJson(f: Fixture, runId: string, edit: (j: Record<string, unknown>) => void): Promise<void> {
  const j = await readJson(f.source, runPath(runId));
  edit(j);
  putJson(f.source, runPath(runId), j);
}

/** Replaces a file of a source run and fixes its hash in `run.json`, as if it had been written so. */
async function replaceRunFile(f: Fixture, runId: string, file: string, content: string): Promise<void> {
  f.source.seed(runPath(runId, file), content);
  await editRunJson(f, runId, (j) => {
    const entry = (j.files as { path: string; sha256: string; bytes: number }[]).find((e) => e.path === file);
    if (entry === undefined) throw new Error(`${file} is not listed`);
    entry.sha256 = `sha256:${sha256Hex(bytesOf(content))}`;
    entry.bytes = bytesOf(content).byteLength;
  });
}

/** Rewrites one library artifact and its sealed index line, so the seal still holds. */
async function resealArtifact(f: Fixture, id: string, edit: (doc: Record<string, unknown>) => void): Promise<void> {
  const [name, version] = id.split("@");
  const path = `${name ?? ""}/${version ?? ""}/artifact.json`;
  const doc = await readJson(f.library, path);
  edit(doc);
  putJson(f.library, path, doc);
  const lines = (await text(f.library, "index.jsonl")).trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
  for (const l of lines) if (l.path === path) l.hash = sealHash(JSON.parse(JSON.stringify(doc)));
  f.library.seed("index.jsonl", `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
}

describe("a clean publish", () => {
  test("a run copies its folder, its batch's plan and report, and the artifacts it used", async () => {
    const f = await certifyFixture();
    const got = await publish(f, runTarget(f.caseRunId));
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.value.runs).toEqual([f.caseRunId]);
    expect(got.value.batches).toEqual([f.batchId]);
    // The runs name sign_in (a session) and open_sub (the task).
    expect(got.value.artifacts).toEqual(f.artifactIds);
    expect(got.value.warnings).toEqual([]);

    const paths = f.dest.paths();
    expect(paths).toEqual(
      expect.arrayContaining([
        runPath(f.caseRunId),
        runPath(f.caseRunId, "events.jsonl"),
        `${TENANT}/batches/${f.batchId}/plan.json`,
        `${TENANT}/batches/${f.batchId}/report.json`,
        "manifest.json",
      ]),
    );
    for (const id of f.artifactIds) {
      const [name, version] = id.split("@");
      expect(paths).toContain(`artifacts/${name ?? ""}/${version ?? ""}/artifact.json`);
    }
    // The layout mirrors `state/evidence/`, and the baseline run was not named, so it stays out.
    expect(paths.some((p) => p.includes(f.baselineRunId))).toBe(false);
  });

  test("the manifest names every item, who and when, and a hash for every copied file", async () => {
    const f = await certifyFixture();
    const got = await publish(f, runTarget(f.caseRunId));
    expect(got.ok).toBe(true);
    const manifest = PublishManifest.parse(JSON.parse(await text(f.dest, "manifest.json")));
    expect(manifest.schema).toBe("intyy.publish/1.0");
    expect(manifest.by).toBe("op_017");
    expect(manifest.at).toBe("2026-02-01T10:00:00.000Z");
    expect(manifest.items).toEqual(
      expect.arrayContaining([
        { kind: "run", id: f.caseRunId, tenant: TENANT },
        { kind: "batch", id: f.batchId, tenant: TENANT },
      ]),
    );
    expect(manifest.items.filter((i) => i.kind === "artifact").map((i) => i.id)).toEqual(f.artifactIds);

    const copied = f.dest.paths().filter((p) => p !== "manifest.json");
    expect(Object.keys(manifest.source_hashes).sort()).toEqual(copied);
    for (const path of copied) {
      const bytes = await f.dest.read(path);
      if (!bytes.ok) throw new Error(path);
      expect(manifest.source_hashes[path]).toBe(`sha256:${sha256Hex(bytes.value)}`);
    }
  });

  test("each artifact copy matches the seal hash the artifact index records", async () => {
    const f = await certifyFixture();
    await publish(f, runTarget(f.caseRunId));
    const manifest = PublishManifest.parse(JSON.parse(await text(f.dest, "manifest.json")));
    const artifacts = manifest.items.filter((i) => i.kind === "artifact");
    expect(artifacts.length).toBeGreaterThan(0);
    for (const item of artifacts) {
      const [name, version] = item.id.split("@");
      const copy = JSON.parse(await text(f.dest, `artifacts/${name ?? ""}/${version ?? ""}/artifact.json`)) as unknown;
      expect(sealHash(copy)).toBe(item.hash);
    }
  });
});

describe("a canary hit refuses the whole publish", () => {
  /** Publishes and expects `canary_hit`, with the file named, the marker by position, and no value. */
  async function expectHit(f: Fixture, path: string, position: number, value: string): Promise<void> {
    const got = await publish(f, runTarget(f.caseRunId));
    expect(got.ok).toBe(false);
    if (got.ok) return;
    expect(got.failure).toBe("canary_hit");
    expect(got.detail).toContain(path);
    expect(got.detail).toContain(`marker #${String(position)}`);
    expect(got.detail).not.toContain(value);
    expect(f.dest.paths()).toEqual([]);
  }

  test("in a run file", async () => {
    const f = await certifyFixture();
    const events = await text(f.source, runPath(f.caseRunId, "events.jsonl"));
    await replaceRunFile(f, f.caseRunId, "events.jsonl", `${events}{"note":"member ${CANARY} seen"}\n`);
    await expectHit(f, runPath(f.caseRunId, "events.jsonl"), 1, CANARY);
  });

  test("in a run file, as the second marker (a bound secret value)", async () => {
    const f = await certifyFixture();
    const events = await text(f.source, runPath(f.caseRunId, "events.jsonl"));
    await replaceRunFile(f, f.caseRunId, "events.jsonl", `${events}{"note":"${SECRET}"}\n`);
    await expectHit(f, runPath(f.caseRunId, "events.jsonl"), 2, SECRET);
  });

  test("in a base64 form", async () => {
    const f = await certifyFixture();
    const events = await text(f.source, runPath(f.caseRunId, "events.jsonl"));
    const encoded = Buffer.from(SECRET).toString("base64");
    await replaceRunFile(f, f.caseRunId, "events.jsonl", `${events}{"blob":"${encoded}"}\n`);
    await expectHit(f, runPath(f.caseRunId, "events.jsonl"), 2, SECRET);
  });

  test("in a sealed artifact", async () => {
    const f = await certifyFixture();
    const id = f.artifactIds[0] ?? "";
    await resealArtifact(f, id, (doc) => {
      doc.note = `copied from member ${CANARY}`;
    });
    const [name, version] = id.split("@");
    await expectHit(f, `artifacts/${name ?? ""}/${version ?? ""}/artifact.json`, 1, CANARY);
  });

  test("in a batch file", async () => {
    const f = await certifyFixture();
    const path = `${TENANT}/batches/${f.batchId}/plan.json`;
    const plan = await readJson(f.source, path);
    plan.started_by = CANARY;
    putJson(f.source, path, plan);
    await expectHit(f, path, 1, CANARY);
  });
});

describe("refusals write nothing", () => {
  test("hash_mismatch: a listed file changed after the run wrote it", async () => {
    const f = await certifyFixture();
    const events = await text(f.source, runPath(f.caseRunId, "events.jsonl"));
    f.source.seed(runPath(f.caseRunId, "events.jsonl"), `${events}{"edited":true}\n`);
    const got = await publish(f, runTarget(f.caseRunId));
    expect(got).toMatchObject({ ok: false, failure: "hash_mismatch" });
    expect(f.dest.paths()).toEqual([]);
  });

  test("not_indexed: the run has no line in the tenant index", async () => {
    const f = await certifyFixture();
    const kept = (await text(f.source, `${TENANT}/index.jsonl`))
      .trim()
      .split("\n")
      .filter((l) => !l.includes(f.caseRunId));
    f.source.seed(`${TENANT}/index.jsonl`, `${kept.join("\n")}\n`);
    const got = await publish(f, runTarget(f.caseRunId));
    expect(got).toMatchObject({ ok: false, failure: "not_indexed" });
    expect(f.dest.paths()).toEqual([]);
  });

  test("index_mismatch: the index says another status than run.json", async () => {
    const f = await certifyFixture();
    const lines = (await text(f.source, `${TENANT}/index.jsonl`))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    // The newest line for the case run now says `failed`; run.json says `success`.
    const last = lines.map((l) => l.run_id).lastIndexOf(f.caseRunId);
    const row = lines[last];
    if (row === undefined) throw new Error("no index line");
    row.status = "failed";
    f.source.seed(`${TENANT}/index.jsonl`, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
    const got = await publish(f, runTarget(f.caseRunId));
    expect(got).toMatchObject({ ok: false, failure: "index_mismatch" });
    expect(f.dest.paths()).toEqual([]);
  });

  test("link_missing: a run names a parent that is not in the evidence", async () => {
    const f = await certifyFixture();
    await editRunJson(f, f.caseRunId, (j) => {
      j.parent_run_id = "run_2026-01-15_aaaaaaaaaa";
    });
    const got = await publish(f, runTarget(f.caseRunId));
    expect(got).toMatchObject({ ok: false, failure: "link_missing" });
    expect(f.dest.paths()).toEqual([]);
  });

  test("link_missing: a run names a batch that is not in the evidence", async () => {
    const f = await certifyFixture();
    f.source.seed(`${TENANT}/batches/${f.batchId}/plan.json`, "{}");
    const plain = await publish(f, runTarget(f.caseRunId));
    // A bad plan is a broken file, not a missing one.
    expect(plain).toMatchObject({ ok: false });
    expect(f.dest.paths()).toEqual([]);

    const g = await certifyFixture();
    await editRunJson(g, g.caseRunId, (j) => {
      j.batch_id = "batch_2026-01-15_aaaaaaaaaa";
    });
    const got = await publish(g, runTarget(g.caseRunId));
    expect(got).toMatchObject({ ok: false, failure: "link_missing" });
    expect(g.dest.paths()).toEqual([]);
  });

  test("link_missing: the run to publish is not in the evidence at all", async () => {
    const f = await certifyFixture();
    const got = await publish(f, runTarget("run_2026-01-15_aaaaaaaaaa"));
    expect(got).toMatchObject({ ok: false });
    expect(f.dest.paths()).toEqual([]);
  });

  test("artifact_mismatch: an artifact changed after sealing", async () => {
    const f = await certifyFixture();
    const [name, version] = (f.artifactIds[0] ?? "").split("@");
    const path = `${name ?? ""}/${version ?? ""}/artifact.json`;
    const doc = await readJson(f.library, path);
    doc.tampered = true;
    putJson(f.library, path, doc);
    const got = await publish(f, runTarget(f.caseRunId));
    expect(got).toMatchObject({ ok: false, failure: "artifact_mismatch" });
    expect(f.dest.paths()).toEqual([]);
  });

  test("artifact_mismatch: an artifact has no line in the artifact index", async () => {
    const f = await certifyFixture();
    f.library.seed("index.jsonl", "");
    const got = await publish(f, runTarget(f.caseRunId));
    expect(got).toMatchObject({ ok: false, failure: "artifact_mismatch" });
    expect(f.dest.paths()).toEqual([]);
  });

  test.each(["trace.zip", "session.har", "cookies.json", "storage_state.json", "traces/page.bin", "video/run.webm"])(
    "forbidden_file: a run folder holds %s",
    async (name) => {
      const f = await certifyFixture();
      f.source.seed(runPath(f.caseRunId, name), "x");
      const got = await publish(f, runTarget(f.caseRunId));
      expect(got).toMatchObject({ ok: false, failure: "forbidden_file" });
      expect(f.dest.paths()).toEqual([]);
    },
  );

  test("manifest_invalid: an existing manifest does not parse, and is left alone", async () => {
    const f = await certifyFixture();
    f.dest.seed("manifest.json", "not json");
    const got = await publish(f, runTarget(f.caseRunId));
    expect(got).toMatchObject({ ok: false, failure: "manifest_invalid" });
    expect(f.dest.paths()).toEqual(["manifest.json"]);
    expect(await text(f.dest, "manifest.json")).toBe("not json");
  });

  test("write_failed: the destination cannot write, and no manifest is written", async () => {
    const f = await certifyFixture();
    f.dest.failWrites.add(runPath(f.caseRunId, "events.jsonl"));
    const got = await publish(f, runTarget(f.caseRunId));
    expect(got).toMatchObject({ ok: false, failure: "write_failed" });
    expect(f.dest.paths()).not.toContain("manifest.json");
  });
});

describe("links resolve (section 9 §6.6, check 3)", () => {
  test("a child run also publishes its parent", async () => {
    const f = await certifyFixture();
    await editRunJson(f, f.baselineRunId, (j) => {
      j.parent_run_id = f.caseRunId;
    });
    const got = await publish(f, runTarget(f.baselineRunId));
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.value.runs).toEqual([f.baselineRunId, f.caseRunId].sort());
  });

  test("a parent run also publishes its children", async () => {
    const f = await certifyFixture();
    await editRunJson(f, f.baselineRunId, (j) => {
      j.parent_run_id = f.caseRunId;
    });
    const got = await publish(f, runTarget(f.caseRunId));
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.value.runs).toEqual([f.baselineRunId, f.caseRunId].sort());
  });

  test("a run in a batch also publishes the batch's plan and report", async () => {
    const f = await certifyFixture();
    await publish(f, runTarget(f.caseRunId));
    expect(f.dest.paths()).toEqual(
      expect.arrayContaining([`${TENANT}/batches/${f.batchId}/plan.json`, `${TENANT}/batches/${f.batchId}/report.json`]),
    );
  });
});

describe("a batch target", () => {
  test("copies plan.json, report.json, and only the runs whose verdict is not pass", async () => {
    const f = await certifyFixture();
    // The case passes, so no run is copied.
    const clean = await publish(f, [{ kind: "batch", id: f.batchId }]);
    expect(clean.ok).toBe(true);
    if (!clean.ok) return;
    expect(clean.value.runs).toEqual([]);
    expect(f.dest.paths()).toEqual(
      expect.arrayContaining([`${TENANT}/batches/${f.batchId}/plan.json`, `${TENANT}/batches/${f.batchId}/report.json`]),
    );

    // The same case with a wrong verdict is copied.
    const g = await certifyFixture();
    const path = `${TENANT}/batches/${g.batchId}/report.json`;
    const report = await readJson(g.source, path);
    const cases = report.cases as { verdict: string }[];
    if (cases[0] === undefined) throw new Error("no case");
    cases[0].verdict = "wrong";
    putJson(g.source, path, report);
    const bad = await publish(g, [{ kind: "batch", id: g.batchId }]);
    expect(bad.ok).toBe(true);
    if (!bad.ok) return;
    expect(bad.value.runs).toEqual([g.caseRunId]);
  });

  test("--with-runs all copies every run of the batch", async () => {
    const f = await certifyFixture();
    const got = await publish(f, [{ kind: "batch", id: f.batchId }], { withRuns: "all" });
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.value.runs).toEqual([f.baselineRunId, f.caseRunId].sort());
  });
});

describe("size and repeat publishes", () => {
  test("past 60 MB it warns and still publishes", async () => {
    const f = await certifyFixture();
    f.dest.seed("big/filler.bin", new Uint8Array(61 * 1024 * 1024));
    const got = await publish(f, runTarget(f.caseRunId));
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.value.warnings.length).toBeGreaterThan(0);
    expect(f.dest.paths()).toContain("manifest.json");
  });

  test("a second publish adds to the manifest and moves `at`", async () => {
    const f = await certifyFixture();
    await publish(f, runTarget(f.caseRunId));
    const first = PublishManifest.parse(JSON.parse(await text(f.dest, "manifest.json")));
    f.clock.advance(60_000);
    const second = await publish(f, runTarget(f.baselineRunId), { by: "op_022" });
    expect(second.ok).toBe(true);
    const merged = PublishManifest.parse(JSON.parse(await text(f.dest, "manifest.json")));
    expect(merged.at).toBe("2026-02-01T10:01:00.000Z");
    expect(merged.by).toBe("op_022");
    expect(merged.items.map((i) => `${i.kind}:${i.id}`)).toEqual(
      expect.arrayContaining([...first.items.map((i) => `${i.kind}:${i.id}`), `run:${f.baselineRunId}`]),
    );
    for (const [path, hash] of Object.entries(first.source_hashes)) expect(merged.source_hashes[path]).toBe(hash);
    expect(Object.keys(merged.source_hashes)).toEqual(expect.arrayContaining([runPath(f.baselineRunId)]));
  });
});

describe("verifyEvidence", () => {
  /** A published fixture, and one `verify` call. */
  async function published() {
    const f = await certifyFixture();
    const got = await publish(f, runTarget(f.caseRunId));
    if (!got.ok) throw new Error(`fixture did not publish: ${got.failure}`);
    const verify = () => verifyEvidence({ markers: MARKERS }, { dest: f.dest });
    return { f, verify };
  }

  test("a fresh publish has no problems", async () => {
    const { verify } = await published();
    const got = await verify();
    expect(got.ok).toBe(true);
    if (got.ok) expect(got.value.problems).toEqual([]);
  });

  test("a changed file is one problem, naming the file", async () => {
    const { f, verify } = await published();
    const path = runPath(f.caseRunId, "events.jsonl");
    f.dest.seed(path, `${await text(f.dest, path)}x`);
    const got = await verify();
    if (!got.ok) throw new Error("expected ok");
    expect(got.value.problems.filter((p) => p.includes(path))).not.toEqual([]);
    expect(got.value.problems.some((p) => p.includes("hash"))).toBe(true);
  });

  test("a deleted file is a problem", async () => {
    const { f } = await published();
    const path = `${TENANT}/batches/${f.batchId}/report.json`;
    const got = await verifyEvidence({ markers: MARKERS }, { dest: await without(f.dest, (p) => p === path) });
    if (!got.ok) throw new Error("expected ok");
    // The file is named at least once: as listed-but-missing, and again by its batch item.
    expect(got.value.problems.length).toBeGreaterThan(0);
    expect(got.value.problems.some((p) => p.includes(path))).toBe(true);
  });

  test("a file the manifest does not list is a problem", async () => {
    const { f, verify } = await published();
    f.dest.seed(`${TENANT}/extra.txt`, "hello");
    const got = await verify();
    if (!got.ok) throw new Error("expected ok");
    expect(got.value.problems).toEqual([expect.stringContaining(`${TENANT}/extra.txt`)]);
  });

  test("a forbidden file name is a problem", async () => {
    const { f, verify } = await published();
    f.dest.seed(runPath(f.caseRunId, "cookies.json"), "{}");
    const got = await verify();
    if (!got.ok) throw new Error("expected ok");
    expect(got.value.problems.some((p) => p.includes("cookies.json"))).toBe(true);
  });

  test("a canary in README.md is a problem that does not print the value", async () => {
    const { f, verify } = await published();
    f.dest.seed("README.md", `Notes about member ${CANARY}.`);
    const got = await verify();
    if (!got.ok) throw new Error("expected ok");
    expect(got.value.problems).toHaveLength(1);
    expect(got.value.problems[0]).toContain("README.md");
    expect(got.value.problems[0]).not.toContain(CANARY);
  });

  test("a run whose parent is not published is a problem", async () => {
    const f = await certifyFixture();
    await editRunJson(f, f.baselineRunId, (j) => {
      j.parent_run_id = f.caseRunId;
    });
    await publish(f, runTarget(f.baselineRunId));
    // Rebuild the destination as if the parent had never been published.
    const manifest = PublishManifest.parse(JSON.parse(await text(f.dest, "manifest.json")));
    const parentPrefix = `${TENANT}/runs/${f.caseRunId}/`;
    const rebuilt = await without(f.dest, (p) => p.startsWith(parentPrefix) || p === "manifest.json");
    const hashes = Object.fromEntries(Object.entries(manifest.source_hashes).filter(([p]) => !p.startsWith(parentPrefix)));
    putJson(rebuilt, "manifest.json", {
      ...manifest,
      items: manifest.items.filter((i) => !(i.kind === "run" && i.id === f.caseRunId)),
      source_hashes: hashes,
    });
    const got = await verifyEvidence({ markers: MARKERS }, { dest: rebuilt });
    if (!got.ok) throw new Error("expected ok");
    expect(got.value.problems).toEqual([expect.stringContaining(f.caseRunId)]);
  });

  test("no manifest is a failure, not a clean result", async () => {
    const f = await certifyFixture();
    const got = await verifyEvidence({ markers: MARKERS }, { dest: f.dest });
    expect(got).toMatchObject({ ok: false, failure: "no_manifest" });
  });
});
