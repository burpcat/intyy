// Repo audit: checks git history and the tracked tree for files and values that must never ship.
// Follows build plan §14 (README and REPORT), M12 task 8, and CLAUDE.md "Data" rules: no brief PDF,
// no .env file but .env.example, no state/, no traces, HAR, video, cookies, or storage state,
// and no canary member in the published data.
// The canary comes from intyy.json (like scripts/canary-scan.ts); its value never prints.
// Usage: npm run audit [-- <repo_dir>]. Exit 1 and a list on any hit.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { Config } from "../src/core/model/config.js";
import { scanForCanaries, type ScanFile } from "../src/core/safety/canary/scan.js";

const repo = resolve(process.argv[2] ?? join(import.meta.dirname, ".."));

/** Path rules: a name for the hit, and a test on one repo path. */
const rules: { name: string; test: (path: string) => boolean }[] = [
  { name: "brief PDF", test: (p) => /\.pdf$/i.test(p) },
  {
    name: ".env file",
    test: (p) => basename(p).startsWith(".env") && basename(p) !== ".env.example",
  },
  { name: "state/ folder", test: (p) => p.startsWith("state/") },
  {
    name: "Playwright trace",
    test: (p) => /(^|\/)traces\//.test(p) || /(^|\/)trace[^/]*\.zip$|\.trace$/i.test(p),
  },
  { name: "HAR file", test: (p) => /\.har$/i.test(p) },
  { name: "video file", test: (p) => /\.(webm|mp4|mov)$/i.test(p) },
  { name: "cookies file", test: (p) => /^cookies?(\.|$)/i.test(basename(p)) },
  { name: "storage state", test: (p) => /storage[-_]?state/i.test(basename(p)) },
];

// Why: the design docs, specs, and test sources name the canary on purpose. The scan covers the
// data that ships or is published: evidence, the library, fixtures, demo files, and the write-ups.
const canaryScope = ["evidence/", "library/", "tests/fixtures/", "demo/", "schemas/"];
const canaryFiles = new Set(["README.md", "REPORT.md"]);

/** Runs git in the repo and returns the NUL- or newline-split output lines. */
function git(args: string[], sep: string): string[] {
  const out = execFileSync("git", args, { cwd: repo, maxBuffer: 1 << 28, encoding: "utf8" });
  return out.split(sep).filter((l) => l !== "");
}

function main(): void {
  const hits: string[] = [];
  const tracked = git(["ls-files", "-z"], "\0");
  const history = git(["log", "--all", "--name-only", "--format=", "--no-renames", "-z"], "\0")
    .flatMap((chunk) => chunk.split("\n"))
    .filter((p) => p !== "");
  for (const [where, paths] of [
    ["tree", tracked],
    ["history", [...new Set(history)]],
  ] as const)
    for (const p of paths)
      for (const r of rules) if (r.test(p)) hits.push(`${r.name}: ${p} (${where})`);

  const configPath = join(repo, "intyy.json");
  if (!existsSync(configPath)) {
    console.error(`audit: no intyy.json in ${repo}; cannot read the canary members.`);
    process.exit(1);
  }
  const config = Config.parse(JSON.parse(readFileSync(configPath, "utf8")));
  const files: ScanFile[] = [];
  for (const p of tracked) {
    if (!canaryFiles.has(p) && !canaryScope.some((s) => p.startsWith(s))) continue;
    if (existsSync(join(repo, p))) files.push({ path: p, bytes: readFileSync(join(repo, p)) });
  }
  // Why: section 4 §14, a hit names the file, the form, and the marker's list position, never the value.
  for (const h of scanForCanaries(files, config.canary_members))
    hits.push(`canary: ${h.path} form ${h.form} marker #${String(h.marker + 1)} (tree)`);

  if (hits.length > 0) {
    for (const h of hits) console.error(`HIT ${h}`);
    console.error(`audit failed: ${String(hits.length)} hit(s).`);
    process.exit(1);
  }
  console.log(
    `audit clean: ${String(tracked.length)} tracked files, ${String(history.length)} history paths.`,
  );
}

main();
