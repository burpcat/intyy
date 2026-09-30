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
  // M05 task 9: `replay`'s own flags. Every one names a place, a choice, or an ID of intyy's
  // own making — never a value read from the request body.
  "--mode": "one of two choices: supervised or unattended",
  "--inputs": "a file path, or - for standard input; the values live in that file, never on the flag",
  "--authorization": "a file path holding the authorization block; not a value itself",
  "--request": "a file path holding a whole intyy.request/1.0 file; not a value itself",
  "--request-id": "the caller's own idempotency key, not member data (default: cli-<staff>-<time>)",
  "--agent": "the calling agent's own ID, not member data",
  "--pin": "a trust key's name, refused until M10; not member data",
  "--wait": "a poll ceiling in milliseconds, not member data",
  // M05 task 10: `run sweep --force-unlock`'s value is a lock identifier, `kind:key`, like
  // `run:<run_id>`; the reason it gives comes from standard input, never this flag.
  "--force-unlock": "a lock identifier, kind:key, like run:<run_id>; not member data",
  // M05 task 11: `spec new --session` names the linked session capability, a link of intyy's
  // own making (`app/capability@major`), never member data.
  "--session": "a session capability link, like kvfcu/sign_in@1; not member data",
  // M06 task 1: `fixture new`'s own flags. Each names a place, a run, a log line number, or a
  // fixed choice, of intyy's own making, never a value read from the bank app's screen.
  "--variant": "the bank app's branding variant, like keystone or lakeshore; not member data",
  "--run": "a run ID to capture the fixture from; not member data",
  "--seq": "a run log line's seq number; not member data",
  "--kind": "one of two choices: trouble or normal",
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
        // Why not `--mode`: M05 task 9 adds it to the real allow list (a place/choice flag on
        // the real `replay`), so it can no longer stand in for an unlisted input flag here.
        p.command("replay").option("--member <number>").option("--amount <money>").option("--dry-run");
      },
    ]);
    expect(inputFlags(program)).toEqual(["replay --member", "replay --amount"]);
  });
});
