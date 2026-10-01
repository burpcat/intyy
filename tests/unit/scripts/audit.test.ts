// Proves the repo audit script (scripts/audit.ts) flags files and values that must never ship:
// forbidden paths in the tree and in git history, and the canary in published data, and that the
// canary value never prints. Follows build plan §14, M12 task 8 and the "repo audit passes" gate.
// Every case builds a temporary git repo; the real repo's git is never touched.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

// A made-up marker; never the real canary.
const MARKER = "482917";
const TSX = join(import.meta.dirname, "../../../node_modules/.bin/tsx");
const SCRIPT = join(import.meta.dirname, "../../../scripts/audit.ts");

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function git(dir: string, ...args: string[]): void {
  execFileSync("git", args, { cwd: dir, stdio: "pipe" });
}

/** Writes files into the repo dir (creating folders) and commits them. */
function commit(dir: string, files: Record<string, string>, msg: string): void {
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), text);
  }
  git(dir, "add", "-A", "-f");
  git(dir, "commit", "-m", msg);
}

/** A temp git repo with an intyy.json and one commit, plus `files` in a second commit. */
function repo(files: Record<string, string> = {}, config = true): string {
  const dir = mkdtempSync(join(tmpdir(), "intyy-audit-"));
  dirs.push(dir);
  git(dir, "init", "-q");
  git(dir, "config", "user.name", "Test");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "commit.gpgsign", "false");
  const base: Record<string, string> = { "keep.txt": "hello" };
  if (config)
    base["intyy.json"] = JSON.stringify({
      schema: "intyy.config/1.0",
      library: "library",
      state: "state",
      publish: "evidence",
      default_tenant: "acme",
      model_keys: { claude: "CLAUDE_KEY", jev: "JEV_KEY" },
      canary_members: [MARKER],
    });
  commit(dir, base, "base");
  if (Object.keys(files).length > 0) commit(dir, files, "files");
  return dir;
}

function audit(dir: string): { code: number; out: string; err: string } {
  try {
    const out = execFileSync(TSX, [SCRIPT, dir], { encoding: "utf8", stdio: "pipe" });
    return { code: 0, out, err: "" };
  } catch (e) {
    const x = e as { status: number; stdout: string; stderr: string };
    return { code: x.status, out: x.stdout, err: x.stderr };
  }
}

describe("repo audit", () => {
  test("a clean repo with .env.example passes", () => {
    const r = audit(repo({ ".env.example": "KEY=" }));
    expect(r.code).toBe(0);
  });

  test.each([
    "brief.pdf",
    ".env",
    "state/x",
    "traces/a.zip",
    "a.har",
    "v.webm",
    "cookies.json",
    "storage-state.json",
  ])("%s in the tree fails and is named", (path) => {
    const r = audit(repo({ [path]: "x" }));
    expect(r.code).toBe(1);
    expect(r.err).toContain(`${path} (tree)`);
  });

  test("a file added then removed still fails, as history", () => {
    const dir = repo({ "secret.har": "x" });
    git(dir, "rm", "-q", "secret.har");
    git(dir, "commit", "-q", "-m", "remove");
    const r = audit(dir);
    expect(r.code).toBe(1);
    expect(r.err).toContain("secret.har (history)");
    expect(r.err).not.toContain("secret.har (tree)");
  });

  test.each([
    ["raw", MARKER],
    ["base64", Buffer.from(`id=${MARKER}`).toString("base64")],
  ])("the canary in %s form in evidence/ fails without printing the value", (form, text) => {
    const r = audit(repo({ "evidence/n.txt": `note ${text}` }));
    expect(r.code).toBe(1);
    expect(r.err).toMatch(new RegExp(`canary: evidence/n\\.txt form ${form}`));
    expect(r.err + r.out).not.toContain(MARKER);
  });

  test("the canary in docs/ is out of scope", () => {
    const r = audit(repo({ "docs/x.md": `member ${MARKER}` }));
    expect(r.code).toBe(0);
  });

  test("a repo with no intyy.json fails", () => {
    const r = audit(repo({}, false));
    expect(r.code).toBe(1);
    expect(r.err).toContain("intyy.json");
  });
});
