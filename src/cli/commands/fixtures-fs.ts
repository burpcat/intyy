// Plain-file access to `library/fixtures/<app>/<fixture_id>/` (section 9 §6.2, section 5 §13.1).
// A fixture is not a sealed document of its own (section 5 §13.6: "they live as long as the pack
// revisions that use them"); only the packs that cite them go through the document store. So
// this reads and writes the folder directly, the same way `src/cli/commands/documents.ts`'s
// `editDoc` manages its own temp files, with no new port or adapter.
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Fixture } from "../../core/model/fixture.js";
import type { LoadedFixture } from "../../core/packs/fixture-suite.js";
import type { Ctx } from "../context.js";
import { CliExit, EXIT } from "../exit-codes.js";

/** `library/fixtures/<app>`. */
function appDir(ctx: Ctx, app: string): string {
  return join(ctx.root, ctx.config.library, "fixtures", app);
}

/** One fixture's own folder. */
function fixtureDir(ctx: Ctx, app: string, id: string): string {
  return join(appDir(ctx, app), id);
}

/** Reads and validates one fixture's `meta.json` and `a11y.yaml`. */
export async function readFixture(ctx: Ctx, app: string, id: string): Promise<LoadedFixture> {
  const dir = fixtureDir(ctx, app, id);
  let rawMeta: string;
  try {
    rawMeta = await readFile(join(dir, "meta.json"), "utf8");
  } catch {
    throw new CliExit(EXIT.usage, `fixture ${app}/${id}: no meta.json at ${dir}`);
  }
  const parsed = Fixture.safeParse(JSON.parse(rawMeta));
  if (!parsed.success) throw new CliExit(EXIT.invalid, `fixture ${app}/${id}: ${parsed.error.message}`);
  let a11y = "";
  try {
    a11y = await readFile(join(dir, "a11y.yaml"), "utf8");
  } catch {
    // section 5 §13.1: a11y.yaml is required, but an upgrade target may predate this check.
  }
  return { fixture: parsed.data, a11y };
}

/** Reads only `kind` from an old fixture's `meta.json`, for `fixture new --upgrade`: an old
 * file may lack the other section 5 §13.1 fields `--upgrade` exists to fill in, so it cannot
 * pass {@link readFixture}'s full schema check yet. */
export async function readFixtureKind(ctx: Ctx, app: string, id: string): Promise<"trouble" | "normal"> {
  const raw = await readFile(join(fixtureDir(ctx, app, id), "meta.json"), "utf8").catch(() => undefined);
  if (raw === undefined) throw new CliExit(EXIT.usage, `fixture ${app}/${id}: no meta.json to upgrade`);
  const kind = (JSON.parse(raw) as { kind?: unknown }).kind;
  if (kind !== "trouble" && kind !== "normal") {
    throw new CliExit(EXIT.invalid, `fixture ${app}/${id}: meta.json's kind is not trouble or normal`);
  }
  return kind;
}

/** Every fixture saved for `app`, or every app when `app` is undefined. */
export async function listFixtures(ctx: Ctx, app?: string): Promise<LoadedFixture[]> {
  const root = join(ctx.root, ctx.config.library, "fixtures");
  const apps = app !== undefined ? [app] : await readdir(root).catch(() => []);
  const out: LoadedFixture[] = [];
  for (const a of apps) {
    const ids = await readdir(appDir(ctx, a)).catch(() => []);
    for (const id of ids) out.push(await readFixture(ctx, a, id));
  }
  return out;
}

/** Writes `meta.json`, keeping every other file in the folder untouched. Used by `fixture new`
 * (a fresh capture, with its `a11y.yaml`/`dom.html`/`screen.png` written first) and by `fixture
 * new --upgrade` (an old fixture's meta.json rebuilt; its capture files stay as they were). */
export async function writeFixtureMeta(ctx: Ctx, meta: Fixture): Promise<void> {
  const dir = fixtureDir(ctx, meta.app, meta.id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`);
}

/** Writes one capture file (`a11y.yaml`, `dom.html`, or `screen.png`) beside `meta.json`. */
export async function writeFixtureFile(ctx: Ctx, app: string, id: string, name: string, bytes: Uint8Array | string): Promise<void> {
  const dir = fixtureDir(ctx, app, id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, name), bytes);
}
