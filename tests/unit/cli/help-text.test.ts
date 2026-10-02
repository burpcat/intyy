// Proves two help strings tell the truth: `certify case <key>` accepts one exact version
// (app/capability@major.minor.patch), and `replay --request-id` defaults to the run's own run ID,
// not a made-up `cli-<staff>-<time>` key. Help is read from the command tree, so nothing runs.
// Design section 9 §2 (the CLI). Section 9's replay text still says `cli-<staff>-<time>`; the
// built default is the run ID (src/cli/commands/replay.ts), and this test pins the help to the code.
import type { Command } from "commander";
import { describe, expect, test } from "vitest";
import { commands } from "../../../src/cli/commands/index.js";
import { commandTree } from "../../../src/cli/program.js";

/** The help text of the command at `path`, on one line per paragraph (no wrapping). */
function helpOf(...path: string[]): string {
  let cmd: Command = commandTree(commands);
  for (const name of path) {
    const next = cmd.commands.find((c) => c.name() === name);
    if (next === undefined) throw new Error(`no command named ${name}`);
    cmd = next;
  }
  return cmd.configureHelp({ helpWidth: 10_000 }).helpInformation();
}

describe("help text", () => {
  test("`certify case` and `certify` name the exact-version form of the key; `replay` says --request-id defaults to the run ID, not cli-<staff>", () => {
    expect(helpOf("certify", "case")).toContain("@major.minor.patch");
    expect(helpOf("certify")).toContain("@major.minor.patch");

    const help = helpOf("replay");
    expect(help).toContain("run ID");
    expect(help).not.toContain("cli-<staff>");
  });
});
