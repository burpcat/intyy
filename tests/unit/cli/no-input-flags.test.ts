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
  "--request-id": "the caller's own idempotency key, not member data (default: this run's own run ID)",
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
  // M06 task 8: `certify case`'s own flags. Each names a suite ID of intyy's own making, never
  // a value read from the bank app's screen or typed by a member.
  "--class": "a suite class ID, like valid or missing; not member data",
  "--profile": "a standard fault profile ID, or a suite extra case ID; not member data",
  "--at": "an anchor, like @step:click_submit; not member data",
  // M07 task 9: `certify case --operator`.
  "--operator": "a choice: scripted or mailbox; not member data",
  // M07 task 2: `operator decide --outcome` names one of the request's declared outcome codes,
  // like `no_member_found`; the CLI checks it against the request. Never member data.
  "--outcome": "an outcome code the request declares, like no_member_found; not member data",
  // M07 task 10: `evidence publish --with-runs`.
  "--with-runs": "the one choice: all; not member data",
  // M08 task 1: `certify --instance` declares bank-app options at start-up, like strip_semantics=1
  // (design section 9 §9.2). They are test-instance settings, never member data.
  "--instance": "declared bank-app options, like strip_semantics=1; not member data",
  // M09 chunk 2: `thresholds ... --jev` and `jev report --jev` name a jev version, like jev@1.4.2.
  "--jev": "a jev version string, like jev@1.4.2; not member data",
  // M10 task 5: the `trust` approval family. Notes and reasons come from standard input, never a flag.
  "--batch": "a batch ID of intyy's own making, like batch_2026-09-26_3fk8q2m7xa; not member data",
  "--ack": "a fragile step ID of the recipe, like open_member; not member data",
  "--expect-record": "a record hash (sha256:...) read off the review screen; not member data",
  "--state": "one trust state: draft, approved, degraded, or retired; or an alert state: open, acted, dismissed; not member data",
  // M11 chunk B: `drift report --since` names a date, never member data. Alert notes come from standard input.
  "--since": "a date like 2026-09-30; not member data",
  // M11 chunk C: `major deprecate`. The reason comes from standard input.
  // M11 chunk D: `certify --kind regression --pack`.
  "--pack": "a pack revision, like app:kvfcu@5; not member data",
  "--successor": "a capability major number, like 2; not member data",
  "--retires-on": "a date like 2027-01-31; not member data",
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
  test("no real command takes an input value as a flag, and the check itself catches an input flag", () => {
    expect(inputFlags(commandTree(commands))).toEqual([]);

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
