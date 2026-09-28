// Writes one JSON Schema file per file format to schemas/. With --check, fails if any is stale.
// Follows build plan section 10 §5.2 (schemas/, generated and committed) and repo CLAUDE.md (check).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { Config } from "../src/core/model/config.js";
import { LockFile } from "../src/core/model/lock.js";
import { Policy } from "../src/core/model/policy.js";
import { Settings } from "../src/core/model/settings.js";
import { StaffFile } from "../src/core/model/staff.js";
import { IndexLine } from "../src/core/model/store-index.js";

/** Every file format, by its schema name. */
const formats: Record<string, z.ZodType> = {
  "intyy.config-1.0": Config,
  "intyy.staff-1.0": StaffFile,
  "intyy.policy-1.0": Policy,
  "intyy.settings-1.0": Settings,
  "intyy.index-1.0": IndexLine,
  "intyy.lock-1.0": LockFile,
};

const dir = join(import.meta.dirname, "..", "schemas");

/** The generated text for one format. Refinements are not JSON Schema; the loader still runs them. */
function render(schema: z.ZodType): string {
  return `${JSON.stringify(z.toJSONSchema(schema), null, 2)}\n`;
}

/** Reads a file, or returns null when it is absent. */
function readOrNull(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function main(): void {
  const check = process.argv.includes("--check");
  const stale: string[] = [];
  mkdirSync(dir, { recursive: true });
  for (const [name, schema] of Object.entries(formats)) {
    const path = join(dir, `${name}.schema.json`);
    const text = render(schema);
    if (readOrNull(path) === text) continue;
    if (check) stale.push(path);
    else writeFileSync(path, text);
  }
  if (stale.length > 0) {
    console.error(`Stale JSON Schema files. Run npm run schemas:\n${stale.join("\n")}`);
    process.exit(1);
  }
  console.log(check ? "schemas are fresh." : `schemas written to ${dir}.`);
}

main();
