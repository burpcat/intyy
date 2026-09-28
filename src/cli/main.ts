#!/usr/bin/env node
// Entry point for the `intyy` command: runs one call with the real streams and environment.
// Follows build plan section 10 §5.2 (cli/main.ts) and design section 9 §7.
import { run } from "./program.js";

process.exitCode = await run(process.argv.slice(2), {
  stdout: process.stdout,
  stderr: process.stderr,
  env: process.env,
  cwd: process.cwd(),
});
