// The `.env` loader: reads `<root>/.env` and sets only variables not already set.
// Follows the updates file §12 (section 9 §7.3 rule) and build plan section 10 §10.2.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseEnv } from "node:util";

/**
 * Loads `<root>/.env` into `env` if the file exists. A variable already set wins, so a subshell
 * can switch credentials (the restricted-user case). Returns the names it set, never values.
 */
export function loadDotEnv(root: string, env: Record<string, string | undefined>): string[] {
  let text: string;
  try {
    text = readFileSync(join(root, ".env"), "utf8");
  } catch (e) {
    if (e instanceof Error && "code" in e && e.code === "ENOENT") return [];
    throw e;
  }
  const set: string[] = [];
  for (const [name, value] of Object.entries(parseEnv(text))) {
    if (env[name] !== undefined || value === undefined) continue;
    env[name] = value;
    set.push(name);
  }
  return set;
}
