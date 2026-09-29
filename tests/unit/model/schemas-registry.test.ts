// Proves every file-format schema in src/core/model/ (one with a `schema: z.literal(...)`
// field) has an entry in scripts/schema-formats.ts, so a forgotten registration fails loudly
// here instead of only showing up as a missing schemas/*.schema.json file.
// Follows build plan section 10 §5.2 and repo CLAUDE.md ("no gate, no next milestone").
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";
import { describe, expect, test } from "vitest";
import { formats } from "../../../scripts/schema-formats.js";

const MODEL_DIR = fileURLToPath(new URL("../../../src/core/model", import.meta.url));

/** A schema's `schema` literal, like `intyy.artifact/1.0`. */
const SCHEMA_LITERAL = /^intyy\.[a-z0-9_-]+\/\d+\.\d+$/;

/** Every `.ts` file under `dir`, recursively. */
function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listTsFiles(full));
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

/** True for anything that looks like a Zod schema instance: it has `safeParse`. */
function isZodSchema(value: unknown): value is z.ZodType {
  return (
    typeof value === "object" &&
    value !== null &&
    "safeParse" in value &&
    typeof value.safeParse === "function"
  );
}

/** Every `schema` literal a module's exports declare, at the top level of an object schema. */
function literalsIn(ns: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const value of Object.values(ns)) {
    if (!isZodSchema(value)) continue;
    const shape = (value as z.ZodObject<z.ZodRawShape>).shape as z.ZodRawShape | undefined;
    const field = shape?.schema;
    if (field instanceof z.ZodLiteral && typeof field.value === "string" && SCHEMA_LITERAL.test(field.value)) {
      out.push(field.value);
    }
  }
  return out;
}

describe("every model schema is registered for JSON Schema export", () => {
  test("scripts/schema-formats.ts names every intyy.*/N.N schema literal under src/core/model", async () => {
    const found = new Set<string>();
    for (const file of listTsFiles(MODEL_DIR)) {
      const ns: unknown = await import(pathToFileURL(file).href);
      for (const literal of literalsIn(ns as Record<string, unknown>)) found.add(literal);
    }
    // Sanity: the scan itself must find something, or this test would pass for the wrong reason.
    expect(found.size).toBeGreaterThan(0);
    const registered = new Set(Object.keys(formats));
    for (const literal of found) {
      expect(registered.has(literal.replace("/", "-"))).toBe(true);
    }
  });
});
