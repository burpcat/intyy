// Proves `intyy fixture new | list | show` (design section 9 §8.5, section 5 §13.1): a fresh
// capture saves masked files and a valid meta.json, `--upgrade` rebuilds an old meta.json from
// its source run, and `list`/`show` read the saved folder back. M06 task 1.
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { commands } from "../../../src/cli/commands/index.js";
import { EXIT } from "../../../src/cli/exit-codes.js";
import { FileEvidenceStore } from "../../../src/adapters/files/other-stores.js";
import type { Masked } from "../../../src/ports/masked.js";
import { call, cleanRoots, tempRoot } from "./helpers.js";

afterAll(cleanRoots);

const RUN_ID = "run_2026-09-30_f1x7pr3sd0";
const TENANT = "keystone";

function maskedCast<T>(v: T): Masked<T> {
  return v as Masked<T>;
}

/** A root with the real, approved keystone settings (fixture new reads the app's version from
 * them), and one finished run with a single observation, saved masked a11y snapshot included. */
async function root(a11y = '- heading "Trouble!"\n- button "OK"'): Promise<string> {
  const r = tempRoot();
  cpSync(join("library", "settings"), join(r, "library", "settings"), { recursive: true });
  const evidence = new FileEvidenceStore({ root: `${r}/state/evidence`, tmpDir: `${r}/state/var/tmp` });
  const created = await evidence.createRun(TENANT, RUN_ID);
  if (!created.ok) throw new Error("createRun failed in test setup");
  const folder = created.value;
  await folder.writeFile("a11y/t1.yaml", maskedCast(a11y));
  await folder.appendEvent(
    maskedCast({
      seq: 1,
      at: "2026-09-30T10:00:00.000Z",
      run_id: RUN_ID,
      step: "t1",
      by: "engine",
      event: "observation",
      data: { location: "/trouble", title: "Trouble", elements: 2, files: ["a11y/t1.yaml"], marked: false },
    }),
  );
  return r;
}

const cli = (r: string, staff: string, argv: string[]) => call(argv, { cwd: r, env: { INTYY_STAFF: staff }, deps: { commands } });

const newArgv = (id: string, extra: string[] = []) => [
  "fixture",
  "new",
  id,
  "--app",
  "kvfcu",
  "--variant",
  "keystone",
  "--run",
  RUN_ID,
  "--seq",
  "1",
  ...extra,
];

describe("fixture new: a fresh capture", () => {
  test("saves the masked a11y snapshot and a valid meta.json", async () => {
    const r = await root();
    const got = await cli(r, "op_017", [...newArgv("trouble_popup_01", ["--kind", "trouble"]), "--json"]);
    expect(got.code).toBe(EXIT.ok);
    const data = JSON.parse(got.stdout) as Record<string, unknown>;
    expect(data).toMatchObject({
      schema: "intyy.fixture/1.0",
      id: "trouble_popup_01",
      app: "kvfcu",
      tenant: "keystone",
      app_version: "9.2",
      variant: "keystone",
      location: "/trouble",
      kind: "trouble",
      source: { run_id: RUN_ID, seq: 1 },
    });
    const dir = join(r, "library", "fixtures", "kvfcu", "trouble_popup_01");
    expect(existsSync(join(dir, "meta.json"))).toBe(true);
    expect(readFileSync(join(dir, "a11y.yaml"), "utf8")).toContain("Trouble!");
    const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")) as Record<string, unknown>;
    expect(meta).toMatchObject({ id: "trouble_popup_01", kind: "trouble" });
    // No screen.png or dom.html were ever saved for this run's turn, so meta says so plainly,
    // never inventing a file it does not have (docs/decisions.md, M04's own rule, reused here).
    expect(meta.missing).toEqual(["dom.html", "screen.png"]);
  });

  test("--kind normal saves a normal fixture", async () => {
    const r = await root();
    const got = await cli(r, "op_017", [...newArgv("normal_home_01", ["--kind", "normal"]), "--json"]);
    expect(got.code).toBe(EXIT.ok);
    expect((JSON.parse(got.stdout) as { kind: string }).kind).toBe("normal");
  });

  test("needs the reviewer role", async () => {
    const r = await root();
    const got = await cli(r, "op_099", newArgv("trouble_popup_02", ["--kind", "trouble"]));
    expect(got.code).toBe(EXIT.refused);
  });

  test("--upgrade with no --kind rebuilds meta.json from the old kind, keeping saved files", async () => {
    const r = await root();
    await cli(r, "op_017", newArgv("trouble_popup_03", ["--kind", "trouble"]));
    const dir = join(r, "library", "fixtures", "kvfcu", "trouble_popup_03");
    const before = readFileSync(join(dir, "a11y.yaml"), "utf8");
    // Simulate an old-format meta.json missing later fields, as a real pre-M06 fixture would.
    writeFileSync(join(dir, "meta.json"), JSON.stringify({ id: "trouble_popup_03", kind: "trouble" }));

    const got = await cli(r, "op_017", [...newArgv("trouble_popup_03", ["--upgrade"]), "--json"]);
    expect(got.code).toBe(EXIT.ok);
    const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")) as Record<string, unknown>;
    expect(meta).toMatchObject({ schema: "intyy.fixture/1.0", id: "trouble_popup_03", kind: "trouble", app_version: "9.2" });
    // The old a11y.yaml is untouched: --upgrade only rebuilds meta.json.
    expect(readFileSync(join(dir, "a11y.yaml"), "utf8")).toBe(before);
  });

  test("--upgrade with no existing meta.json is refused with a clear message", async () => {
    const r = await root();
    mkdirSync(join(r, "library", "fixtures", "kvfcu", "nothing_here"), { recursive: true });
    const got = await cli(r, "op_017", newArgv("nothing_here", ["--upgrade"]));
    expect(got.code).toBe(EXIT.usage);
    expect(got.stderr).toContain("no meta.json");
  });
});

describe("fixture list and show", () => {
  test("list shows every saved fixture; show prints one", async () => {
    const r = await root();
    await cli(r, "op_017", newArgv("trouble_popup_04", ["--kind", "trouble"]));
    await cli(r, "op_017", newArgv("normal_home_04", ["--kind", "normal"]));

    const listed = await cli(r, "op_017", ["fixture", "list", "--json"]);
    const rows = (JSON.parse(listed.stdout) as { fixtures: { id: string }[] }).fixtures;
    expect(rows.map((row) => row.id).sort()).toEqual(["normal_home_04", "trouble_popup_04"]);

    const shown = await cli(r, "op_017", ["fixture", "show", "kvfcu", "trouble_popup_04", "--json"]);
    expect(shown.code).toBe(EXIT.ok);
    expect((JSON.parse(shown.stdout) as { id: string }).id).toBe("trouble_popup_04");
  });

  test("show on an unknown fixture is a usage error, naming the folder", async () => {
    const r = await root();
    const got = await cli(r, "op_017", ["fixture", "show", "kvfcu", "no_such_fixture"]);
    expect(got.code).toBe(EXIT.usage);
    expect(got.stderr).toContain("no meta.json");
  });
});

describe("fixture new: a replay's ladder capture", () => {
  test("takes the ladder line's files, the last logged location, and finds an old masked name in run.json", async () => {
    const r = await root();
    const evidence = new FileEvidenceStore({ root: `${r}/state/evidence`, tmpDir: `${r}/state/var/tmp` });
    const folder = await evidence.openRun(TENANT, RUN_ID);
    if (!folder.ok) throw new Error("openRun failed in test setup");
    await folder.value.writeFile("a11y/00017_click_member_ladder.yaml", maskedCast('- heading "500 Internal Server Error"'));
    await folder.value.writeFile(
      "run.json",
      maskedCast(JSON.stringify({ files: [{ path: "a11y/00017_click_member_ladder.yaml", sha256: "x", bytes: 1 }] })),
    );
    const line = (seq: number, event: string, data: Record<string, unknown>) =>
      folder.value.appendEvent(maskedCast({ seq, at: "2026-09-30T10:00:01.000Z", run_id: RUN_ID, step: "click_member", by: "engine", event, data }));
    await line(2, "gate", { actor: "engine", action: "click", decision: "allowed", path: "/main.do" });
    await line(3, "ladder", { rung: 1, verdict: "climb", files: ["a11y/[digits#1]_click_member_ladder.yaml"] });
    const got = await cli(r, "op_017", [
      ...newArgv("trouble_server_error", ["--kind", "trouble", "--json"]).map((a) => (a === "1" ? "3" : a)),
    ]);
    expect(got.code).toBe(EXIT.ok);
    expect(JSON.parse(got.stdout)).toMatchObject({ location: "/main.do", source: { run_id: RUN_ID, seq: 3 } });
    const dir = join(r, "library", "fixtures", "kvfcu", "trouble_server_error");
    expect(readFileSync(join(dir, "a11y.yaml"), "utf8")).toContain("500 Internal Server Error");
  });
});
