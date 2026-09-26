// Fails if design sections 1 to 9 still hold a section 10 leftover word, or miss a pointer note.
// Follows intyy-design-updates-from-section-10.md §15, the docs:verify rules.
import { readFileSync } from "node:fs";
import {
  designDir,
  isPointerNote,
  isSkipped,
  leftoverPattern,
  leftoverWords,
  noteLine,
  pointerNotes,
  sectionFiles,
} from "./docs-section-10.js";

function findLeftovers(file: string, lines: string[]): string[] {
  const patterns = leftoverWords.map((word) => ({ word, pattern: leftoverPattern(word) }));
  return lines.flatMap((line, i) => {
    if (isSkipped(line) || isPointerNote(line)) return [];
    const words = patterns.filter((p) => p.pattern.test(line)).map((p) => p.word);
    return words.length === 0 ? [] : [`${file}:${String(i + 1)}: leftover ${words.join(", ")}`];
  });
}

function findMissingNotes(file: string, lines: string[]): string[] {
  return pointerNotes
    .filter((n) => n.file === file)
    .flatMap((n) => {
      const index = lines.indexOf(n.heading);
      if (index === -1) return [`${file}: missing heading: ${n.heading}`];
      const next = lines.slice(index + 1).find((line) => line.trim() !== "");
      return next === noteLine(n) ? [] : [`${file}: missing note under: ${n.heading}`];
    });
}

function main(): void {
  const problems = sectionFiles().flatMap((file) => {
    const lines = readFileSync(`${designDir}${file}`, "utf8").split("\n");
    return [...findLeftovers(file, lines), ...findMissingNotes(file, lines)];
  });
  if (problems.length > 0) {
    console.error(`docs:verify failed with ${String(problems.length)} problem(s):`);
    for (const p of problems) console.error(`  ${p}`);
    console.error("Fix: run `npm run docs:renames`, or add the missing edit to scripts/docs-renames.ts.");
    process.exitCode = 1;
    return;
  }
  console.log("docs:verify passed.");
}

main();
