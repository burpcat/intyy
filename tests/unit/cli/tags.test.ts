// Proves `intyy tags report <app>` (design section 9 §9.5, section 8 §14.3, section 2 §17.3): an
// empty library gives exit 0, no artifacts, and no rows; a bad app ID is a usage error; the sealed
// artifacts of the named app are counted (an action kept by the human gives agreement 1) and
// another app's are not; and the report only reads: nothing under the data root changes, so
// `ready` is a flag and grants nothing. Temporary data roots only. M10.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { commands } from "../../../src/cli/commands/index.js";
import { EXIT } from "../../../src/cli/exit-codes.js";
import { wire } from "../../../src/cli/wiring.js";
import { Artifact as ArtifactSchema, type Artifact } from "../../../src/core/model/artifact.js";
import { Config } from "../../../src/core/model/config.js";
import type { TagRow } from "../../../src/core/certify/tag-agreement.js";
import { OPEN_SUB } from "../replay/executor-harness.js";
import { call, cleanRoots, tempRoot } from "./helpers.js";

afterAll(cleanRoots);

const RUN = "run_2026-01-15_1000000002";
type Report = { app: string; artifacts: number; rows: TagRow[] };

const report = async (root: string, ...argv: string[]) => {
  const r = await call(["tags", "report", ...argv, "--json"], { cwd: root, env: { INTYY_STAFF: "op_017" }, deps: { commands } });
  return { ...r, body: r.stdout === "" ? null : (JSON.parse(r.stdout) as Report) };
};

/** `OPEN_SUB` for `app`, with `n` flow_step actions the human kept. */
function artifactOf(app: string, n: number): Artifact {
  const doc = JSON.parse(JSON.stringify(OPEN_SUB)) as { identity: { app: string }; provenance: Record<string, unknown> };
  doc.identity.app = app;
  doc.provenance.actions = Array.from({ length: n }, (_, seq) => ({
    run_id: RUN,
    seq,
    llm_tag: "flow_step",
    human_tag: "flow_step",
    decided_by: "op_017",
    became: "dropped",
  }));
  return ArtifactSchema.parse(doc);
}

/** Seals `artifact` into the real candidate store under `root`. */
async function seal(root: string, artifact: Artifact): Promise<void> {
  const config = Config.parse(JSON.parse(readFileSync(join(root, "intyy.json"), "utf8")));
  const { app, capability } = artifact.identity;
  const sealed = await wire(root, config, {}).candidates.seal(`${app}/${capability}/cand_2026-01-15_1000000002`, "1.0.0", "op_017", artifact, {});
  if (!sealed.ok) throw new Error(`test setup: seal failed: ${sealed.detail ?? sealed.failure}`);
}

/** Every file under `dir` with its bytes, as one string, to compare before and after. */
function snapshot(dir: string): string {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(`${p}\n${readFileSync(p, "utf8")}`);
    }
  };
  walk(dir);
  return out.join("\n--\n");
}

describe("tags report", () => {
  test("an empty root: exit 0, no artifacts, no rows; an app ID that is not an app ID is a usage error", async () => {
    const root = tempRoot();
    const r = await report(root, "kvfcu");
    expect(r.code).toBe(EXIT.ok);
    expect(r.body).toEqual({ app: "kvfcu", artifacts: 0, rows: [] });

    const bad = await report(root, "Bad App");
    expect(bad.code).toBe(EXIT.usage);
    expect(bad.stderr).toContain("app");
  });

  test("one sealed artifact with four kept flow_step actions: one row, agreement 1, not ready; another app's artifact is not counted", async () => {
    const root = tempRoot();
    await seal(root, artifactOf("kvfcu", 4));
    const r = await report(root, "kvfcu");
    expect(r.code).toBe(EXIT.ok);
    expect(r.body?.artifacts).toBe(1);
    expect(r.body?.rows).toEqual([
      { model: "claude-sonnet-5", prompt: null, tag_type: "flow_step", reviewed: 4, agreed: 4, agreement: 1, recent_changes: 0, ready: false },
    ]);

    await seal(root, artifactOf("otherbank", 7));
    const kv = await report(root, "kvfcu");
    expect(kv.body).toMatchObject({ artifacts: 1, rows: [{ reviewed: 4 }] });
    const other = await report(root, "otherbank");
    expect(other.body).toMatchObject({ artifacts: 1, rows: [{ reviewed: 7 }] });
    expect((await report(root, "nobank")).body).toEqual({ app: "nobank", artifacts: 0, rows: [] });
  });

  test("the text form names the app and the columns", async () => {
    const root = tempRoot();
    await seal(root, artifactOf("kvfcu", 2));
    const r = await call(["tags", "report", "kvfcu"], { cwd: root, env: { INTYY_STAFF: "op_017" }, deps: { commands } });
    expect(r.code).toBe(EXIT.ok);
    expect(r.stdout).toContain("tag agreement for kvfcu: 1 sealed artifact(s)");
    expect(r.stdout).toContain("flow_step");
    expect(r.stdout).toContain("unrecorded");
  });

  test("it only reads: nothing under the data root changes, whatever `ready` says", async () => {
    const root = tempRoot();
    await seal(root, artifactOf("kvfcu", 50));
    const before = snapshot(root);
    const r = await report(root, "kvfcu");
    expect(r.body?.rows[0]).toMatchObject({ reviewed: 50, agreement: 1, ready: true });
    expect(snapshot(root)).toBe(before);
  });
});
