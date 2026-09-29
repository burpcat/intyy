#!/usr/bin/env node
// Entry point for the `intyy` command: runs one call with the real streams and environment.
// Follows build plan section 10 §5.2 (cli/main.ts) and design section 9 §7.
import { createInterface } from "node:readline/promises";
import { commands } from "./commands/index.js";
import { run } from "./program.js";

// Why one readline interface: `question` (the `review` walk) and `readAll` (a piped `--note`)
// never run in the same call, so sharing the one reader over stdin is safe.
const rl = createInterface({ input: process.stdin });

process.exitCode = await run(
  process.argv.slice(2),
  {
    stdout: process.stdout,
    stderr: process.stderr,
    stdin: {
      isTTY: process.stdin.isTTY,
      readAll: async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
        return Buffer.concat(chunks).toString("utf8");
      },
      question: (prompt) => rl.question(prompt),
    },
    env: process.env,
    cwd: process.cwd(),
  },
  { commands },
);
rl.close();
