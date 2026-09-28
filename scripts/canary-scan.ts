// Scans one run folder for canary values: the canary members and every secret value bound in the
// tenant's settings. With --cassette <name>, a clean run's masked turns are copied to
// tests/fixtures/cassettes/<name>/cassette.json, and the copy is scanned too.
// Follows design section 4 §14 (canary scans), the updates file §7 and §12 (canary sources, .env),
// and docs/decisions.md (M03: the owner runs this; values stay in memory and never print).
// Usage: npm run canary:scan -- <run_id> [--cassette <name>]
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { FileDocumentStore } from "../src/adapters/files/document-store.js";
import { SystemClock } from "../src/adapters/system/clock.js";
import { loadDotEnv } from "../src/cli/env.js";
import { Config } from "../src/core/model/config.js";
import { RunId } from "../src/core/model/ids.js";
import { settingsKind } from "../src/core/model/kinds.js";
import { settingsBindings } from "../src/core/model/settings.js";
import { scanForCanaries, type ScanFile } from "../src/core/safety/canary/scan.js";
import { cassetteOf } from "./cassette.js";

const root = join(import.meta.dirname, "..");

/** Every file under `dir`, with paths relative to it. */
function tree(dir: string): ScanFile[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => {
      const full = join(e.parentPath, e.name);
      return { path: relative(dir, full), bytes: readFileSync(full) };
    });
}

/** The markers: canary members, then every bound secret that has a value. Kept in memory only. */
async function markers(config: Config): Promise<{ values: string[]; missing: string[] }> {
  const dir = join(root, config.library, "settings");
  const store = new FileDocumentStore(
    settingsKind,
    { dir, tmpDir: join(root, config.state, "var", "tmp") },
    new SystemClock(),
  );
  const tenant = config.default_tenant;
  const approved = (await store.list({ id: tenant })).filter((s) => s.state === "approved").at(-1);
  if (approved === undefined) throw new Error(`settings ${tenant} have no approved revision`);
  const got = await store.get(tenant, approved.rev);
  if (!got.ok) throw new Error(`settings ${tenant} ${approved.rev}: ${got.failure}`);
  const values = [...config.canary_members];
  const missing: string[] = [];
  for (const b of settingsBindings(got.value.doc)) {
    const v = process.env[b.key];
    if (v === undefined || v === "") missing.push(b.key);
    else values.push(v);
  }
  return { values, missing };
}

async function main(): Promise<void> {
  const [runId, flag, name] = process.argv.slice(2);
  if (
    runId === undefined ||
    !RunId.safeParse(runId).success ||
    (flag !== undefined && (flag !== "--cassette" || name === undefined))
  ) {
    console.error("Usage: npm run canary:scan -- <run_id> [--cassette <name>]");
    process.exit(1);
  }
  const config = Config.parse(JSON.parse(readFileSync(join(root, "intyy.json"), "utf8")));
  loadDotEnv(root, process.env);
  const runDir = join(root, config.state, "evidence", config.default_tenant, "runs", runId);
  const m = await markers(config);
  for (const k of m.missing) console.error(`warning: ${k} has no value; it is not scanned`);
  const files = tree(runDir);
  const hits = scanForCanaries(files, m.values);
  if (hits.length > 0) {
    // Why: section 4 §14, a hit names the file, the form, and the marker's list position, never the value.
    for (const h of hits)
      console.error(`HIT ${h.path}  form ${h.form}  marker #${String(h.marker + 1)}`);
    process.exit(1);
  }
  console.log(`clean: ${String(files.length)} files, ${String(m.values.length)} markers.`);
  if (name === undefined) return;
  const out = join(root, "tests", "fixtures", "cassettes", name, "cassette.json");
  const bytes = Buffer.from(`${JSON.stringify(cassetteOf(runDir, runId), null, 2)}\n`);
  if (scanForCanaries([{ path: relative(root, out), bytes }], m.values).length > 0) {
    console.error("HIT in the cassette; nothing was written.");
    process.exit(1);
  }
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, bytes);
  console.log(`cassette written: ${relative(root, out)}`);
}

await main();
