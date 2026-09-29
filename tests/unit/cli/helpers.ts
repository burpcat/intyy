// Test helpers for the CLI: a temporary data root and fake streams. Design section 9 §7.
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run, type RunDeps } from "../../../src/cli/program.js";
import type { Io } from "../../../src/cli/output.js";

/** The staff file of build plan §9. */
export const STAFF = {
  schema: "intyy.staff/1.0",
  staff: [
    { id: "op_017", roles: { "*": ["operator", "reviewer"] } },
    {
      id: "op_022",
      roles: { keystone: ["approver"], lakeshore: ["approver"], "*": ["operator", "reviewer"] },
    },
    { id: "op_031", roles: { "*": ["approver"] } },
  ],
};

const roots: string[] = [];

/** A temporary data root: the repo's intyy.json and a staff file. */
export function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "intyy-cli-"));
  roots.push(root);
  copyFileSync("intyy.json", join(root, "intyy.json"));
  mkdirSync(join(root, "library"), { recursive: true });
  writeFileSync(join(root, "library", "staff.json"), JSON.stringify(STAFF));
  return root;
}

/** Removes every temporary root. Call from afterAll. */
export function cleanRoots(): void {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
}

/** What one call printed and returned. */
export type Call = {
  code: number;
  stdout: string;
  stderr: string;
  env: Record<string, string | undefined>;
};

/** Runs `intyy` in-process with fake streams. */
export async function call(
  argv: string[],
  opts: {
    cwd: string;
    env?: Record<string, string | undefined>;
    tty?: boolean;
    deps?: RunDeps;
    /** Whether standard input is a terminal (default: false, like a piped call). */
    stdinTty?: boolean;
    /** What a piped `readAll()` call returns, such as a `--note`'s text. */
    stdin?: string;
    /** Scripted answers for the `review` walk's `question()` calls, in order. */
    answers?: readonly string[];
  },
): Promise<Call> {
  let stdout = "";
  let stderr = "";
  const env = { ...(opts.env ?? {}) };
  const answers = [...(opts.answers ?? [])];
  const io: Io = {
    stdout: { write: (t: string) => (stdout += t), isTTY: opts.tty ?? false },
    stderr: { write: (t: string) => (stderr += t) },
    stdin: {
      isTTY: opts.stdinTty ?? false,
      readAll: () => Promise.resolve(opts.stdin ?? ""),
      question: () => Promise.resolve(answers.shift() ?? ""),
    },
    env,
    cwd: opts.cwd,
  };
  const code = await run(argv, io, opts.deps);
  return { code, stdout, stderr, env };
}
