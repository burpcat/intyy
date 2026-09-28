// The `intyy` command tree: global flags, the start-up hook, and error to exit-code mapping.
// Follows design section 9 §7 (the CLI): §7.3 flags, §7.4 output, §7.5 exit codes, §7.8 sweep.
import { createRequire } from "node:module";
import { Command, CommanderError } from "commander";
import { makeContext, printOptions, type Ctx, type GlobalFlags } from "./context.js";
import { CliExit, EXIT } from "./exit-codes.js";
import { printAnswer, printError, type Answer, type Io } from "./output.js";
import { reportSweep, stubSweep, type Sweep } from "./sweep.js";
import { wire } from "./wiring.js";

/** Adds one noun's commands to the program. */
export type Register = (program: Command, ctx: () => Ctx) => void;

/** A command body: gets the context, operands, and its own options; returns the answer. */
export type Handler = (ctx: Ctx, args: string[], opts: Record<string, unknown>) => Promise<Answer>;

/** What `run` may swap in. Tests pass their own commands, sweep, or wiring. */
export type RunDeps = {
  commands?: readonly Register[];
  sweep?: Sweep;
  wire?: typeof wire;
};

/** Commands that accept `--reveal-outputs` (section 9 §7.3). None exists before M05. */
const REVEAL_OK = new Set(["replay", "reconcile"]);
/** Commands that accept `--models off`. */
const MODELS_OK = new Set(["replay", "certify", "reconcile"]);

/** Reads the version from package.json. The same path works from src/cli/ and dist/cli/. */
export function readVersion(): string {
  const pkg: unknown = createRequire(import.meta.url)("../../package.json");
  if (
    typeof pkg === "object" &&
    pkg !== null &&
    "version" in pkg &&
    typeof pkg.version === "string"
  ) {
    return pkg.version;
  }
  throw new Error("package.json has no version string");
}

/** A string option, or undefined. */
function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/** The global flags from a command's merged options. */
function globalFlags(opts: Record<string, unknown>): GlobalFlags {
  return {
    root: str(opts.root),
    tenant: str(opts.tenant),
    staff: str(opts.staff),
    json: opts.json === true,
    revealOutputs: opts.revealOutputs === true,
    models: str(opts.models),
  };
}

/** Wraps a handler as a commander action that prints its answer. */
export function act(ctxOf: () => Ctx, handler: Handler): (this: Command) => Promise<void> {
  return async function (this: Command): Promise<void> {
    const ctx = ctxOf();
    const result = await handler(ctx, this.args, this.opts());
    printAnswer(ctx.io, result, printOptions(ctx));
    if (result.code !== undefined) ctx.exit.code = result.code;
  };
}

/** Refuses flags a command does not take (section 9 §7.3). */
function checkRunFlags(name: string, flags: GlobalFlags): void {
  if (flags.revealOutputs && !REVEAL_OK.has(name)) {
    throw new CliExit(EXIT.usage, "--reveal-outputs works only on replay and reconcile");
  }
  if (flags.models !== undefined) {
    if (!MODELS_OK.has(name)) {
      throw new CliExit(EXIT.usage, "--models works only on replay, certify, and reconcile");
    }
    if (flags.models !== "off") throw new CliExit(EXIT.usage, "--models takes one value: off");
  }
}

/** Builds the program for one call. */
function buildProgram(io: Io, deps: RunDeps, setCtx: (c: Ctx) => void, ctxOf: () => Ctx): Command {
  const program = new Command()
    .name("intyy")
    .description("Gives AI agents hands in bank back-office apps that have no API.")
    .version(readVersion())
    .option("--root <dir>", "data root (default: the nearest intyy.json)")
    .option("--tenant <id>", "which bank (default: default_tenant in intyy.json)")
    .option("--staff <id>", "who runs the command (default: INTYY_STAFF)")
    .option("--json", "print one JSON document on standard output")
    .option("--reveal-outputs", "print raw sensitive outputs when output is not a terminal")
    .option("--models <state>", "off: run with jev and the reviewer switched off")
    .exitOverride()
    .configureOutput({
      writeOut: (s) => io.stdout.write(s),
      writeErr: (s) => io.stderr.write(s),
    });

  // Why a hook: every command starts with the same steps, then the sweep (section 9 §7.8).
  program.hook("preAction", async (_root, action) => {
    const flags = globalFlags(action.optsWithGlobals());
    checkRunFlags(action.name(), flags);
    const ctx = makeContext(io, flags, deps.wire ?? wire);
    setCtx(ctx);
    reportSweep(io, await (deps.sweep ?? stubSweep)(ctx.tenant));
  });

  for (const register of deps.commands ?? []) register(program, ctxOf);
  return program;
}

/**
 * The command tree alone, for checks that walk every command and option. Nothing runs, so the
 * streams and the context are never used.
 */
export function commandTree(commands: readonly Register[]): Command {
  const quiet: Io = {
    stdout: { write: () => true },
    stderr: { write: () => true },
    env: {},
    cwd: "/",
  };
  const noCtx = (): Ctx => {
    throw new Error("the command tree has no context");
  };
  return buildProgram(quiet, { commands }, () => undefined, noCtx);
}

/** Runs one `intyy` call and returns its exit code. Never throws. */
export async function run(argv: readonly string[], io: Io, deps: RunDeps = {}): Promise<number> {
  let ctx: Ctx | undefined;
  const ctxOf = (): Ctx => {
    if (ctx === undefined) throw new Error("a command ran before its context was built");
    return ctx;
  };
  const program = buildProgram(io, deps, (c) => (ctx = c), ctxOf);
  const json = argv.includes("--json");
  try {
    await program.parseAsync([...argv], { from: "user" });
    return ctx?.exit.code ?? EXIT.ok;
  } catch (e) {
    if (e instanceof CliExit) {
      printError(io, e.code, e.message, { json, reveal: false });
      return e.code;
    }
    if (e instanceof CommanderError) {
      // Why: help and --version exit 0; commander already printed its own usage message.
      if (e.exitCode === 0) return EXIT.ok;
      if (json)
        io.stdout.write(
          `${JSON.stringify({ error: { code: EXIT.usage, message: e.message } }, null, 2)}\n`,
        );
      return EXIT.usage;
    }
    printError(io, EXIT.usage, `internal error: ${e instanceof Error ? e.message : String(e)}`, {
      json,
      reveal: false,
    });
    return EXIT.usage;
  }
}
