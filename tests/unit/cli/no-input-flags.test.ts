// Proves no command accepts an input value as a flag. Input values come from a file or standard
// input, never from flags: flags land in shell history and process lists.
// Design section 9 §2.5 and §16 ("No inputs on flags").
import { Command } from "commander";
import { describe, expect, test } from "vitest";
import { commands } from "../../../src/cli/commands/index.js";
import { commandTree } from "../../../src/cli/program.js";

/**
 * Flags that may take a value, because the value names a place, a record, or a choice, never
 * member data. Adding a flag here is a reviewed decision: say why in the comment.
 */
const NON_INPUT_FLAGS: Record<string, string> = {
  "--root": "a data root folder",
  "--tenant": "a tenant ID",
  "--staff": "a staff ID",
  "--models": "the one choice: off",
  "--rev": "a sealed revision number",
  "--app": "an app ID",
  "--candidate": "a candidate ID",
  "--version": "a semver version to seal, like 1.0.0",
  "--format": "the one choice: tool",
};

/** Every value-taking flag in the tree that is not on the allow list, as `command --flag`. */
function inputFlags(program: Command): string[] {
  const found: string[] = [];
  const walk = (cmd: Command, path: string): void => {
    for (const opt of cmd.options) {
      const takesValue = opt.required || opt.optional;
      const flag = opt.long ?? opt.short ?? opt.flags;
      if (takesValue && !(flag in NON_INPUT_FLAGS)) found.push(`${path} ${flag}`.trim());
    }
    for (const sub of cmd.commands) walk(sub, `${path} ${sub.name()}`.trim());
  };
  walk(program, "");
  return found;
}

describe("no inputs on flags", () => {
  test("no real command takes an input value as a flag", () => {
    expect(inputFlags(commandTree(commands))).toEqual([]);
  });

  test("the check itself catches an input flag", () => {
    const program = commandTree([
      (p) => {
        p.command("replay").option("--member <number>").option("--mode <mode>").option("--dry-run");
      },
    ]);
    expect(inputFlags(program)).toEqual(["replay --member", "replay --mode"]);
  });
});
