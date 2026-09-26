#!/usr/bin/env node
// Entry point for the `intyy` command. M00 supports only `--version`.
// Follows build plan section 10 §5.2 (cli/main.ts) and §5.5 (commander).
import { createRequire } from "node:module";
import { Command } from "commander";

/** Reads the version from package.json. The same path works from src/cli/ and dist/cli/. */
function readVersion(): string {
  const pkg: unknown = createRequire(import.meta.url)("../../package.json");
  if (typeof pkg === "object" && pkg !== null && "version" in pkg && typeof pkg.version === "string") {
    return pkg.version;
  }
  throw new Error("package.json has no version string");
}

const program = new Command().name("intyy").version(readVersion());

await program.parseAsync(process.argv);
