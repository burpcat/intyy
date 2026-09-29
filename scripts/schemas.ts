// Writes one JSON Schema file per file format to schemas/. With --check, fails if any is stale.
// Follows build plan section 10 §5.2 (schemas/, generated and committed) and repo CLAUDE.md (check).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { formats } from "./schema-formats.js";

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
