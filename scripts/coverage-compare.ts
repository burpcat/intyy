// Proves a test refactor keeps coverage: every statement, branch, and function the baseline run
// covered must still be covered. Reads the V8 report that `npm run test:coverage` writes.
// Follows build plan section 10 §5.4 (where tests live) and docs/decisions.md (coverage proof).
// Usage: npm run coverage:compare -- save   (record the baseline)
//        npm run coverage:compare           (fail if anything the baseline covered is now uncovered)
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

const root = join(import.meta.dirname, "..");
const report = join(root, "state", "coverage", "coverage-final.json");
const baseline = join(root, "state", "coverage-baseline.json");

type Pos = { line: number; column: number };
type Span = { start: Pos; end: Pos };
type FileCoverage = {
  statementMap: Record<string, Span>;
  s: Record<string, number>;
  fnMap: Record<string, { name: string; loc: Span }>;
  f: Record<string, number>;
  branchMap: Record<string, { loc: Span }>;
  b: Record<string, number[]>;
};

/** A span as `line:col-line:col`, stable while the source does not change. */
const at = (span: Span) => `${String(span.start.line)}:${String(span.start.column)}-${String(span.end.line)}:${String(span.end.column)}`;

/** Every covered statement, function, and branch arm in the report, as stable keys. */
function coveredKeys(): string[] {
  const all = JSON.parse(readFileSync(report, "utf8")) as Record<string, FileCoverage>;
  const keys: string[] = [];
  for (const [path, c] of Object.entries(all)) {
    const file = relative(root, path);
    for (const [id, span] of Object.entries(c.statementMap))
      if ((c.s[id] ?? 0) > 0) keys.push(`${file} stmt ${at(span)}`);
    for (const [id, fn] of Object.entries(c.fnMap))
      if ((c.f[id] ?? 0) > 0) keys.push(`${file} fn ${fn.name} ${at(fn.loc)}`);
    for (const [id, branch] of Object.entries(c.branchMap))
      (c.b[id] ?? []).forEach((n, arm) => {
        if (n > 0) keys.push(`${file} branch ${at(branch.loc)} #${String(arm)}`);
      });
  }
  return keys.sort();
}

const now = coveredKeys();
if (process.argv[2] === "save") {
  writeFileSync(baseline, JSON.stringify(now, null, 1));
  console.log(`baseline saved: ${String(now.length)} covered items.`);
} else {
  if (!existsSync(baseline)) throw new Error("no baseline: run `npm run coverage:compare -- save` first.");
  const before = JSON.parse(readFileSync(baseline, "utf8")) as string[];
  const have = new Set(now);
  const lost = before.filter((k) => !have.has(k));
  for (const k of lost) console.log(`lost: ${k}`);
  console.log(`baseline ${String(before.length)}, now ${String(now.length)}, lost ${String(lost.length)}.`);
  if (lost.length > 0) process.exit(1);
}
