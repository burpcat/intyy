// Applies the section 10 doc changes to design sections 1 to 9. A second run changes nothing.
// Follows intyy-design-updates-from-section-10.md §15: §2 renames, then §3 edits, then §14 notes.
import { readFileSync, writeFileSync } from "node:fs";
import {
  designDir,
  escapeRegExp,
  isSkipped,
  noteLine,
  pointerNotes,
  renames,
  sectionFiles,
} from "./docs-section-10.js";

/** One updates §3 edit: replace `from` with `to` on the lines of one file. */
interface TextEdit {
  file: string;
  from: string;
  to: string;
}

/** One updates §3.1 deletion: drop the table row whose first cell is `firstCell`. */
interface RowDeletion {
  file: string;
  firstCell: string;
}

const s1 = "1-intyy-component-level-design.md";
const s2 = "2-intyy-artifact-schema.md";
const s3 = "3-intyy-run-outputs.md";
const s4 = "4-intyy-safety-policy.md";
const s6 = "6-intyy-discover-and-recorder.md";

/** Updates §3.1 row deletions: the aadhaar and pan rows in §9.4 and §9.8. */
const rowDeletions: readonly RowDeletion[] = [
  { file: s4, firstCell: "`aadhaar`" },
  { file: s4, firstCell: "`pan`" },
];

/** Updates §3 edits, in the order §3.1, §3.2, §3.3. Texts are as they read after the §2 renames. */
const textEdits: readonly TextEdit[] = [
  // §3.1 Redaction kinds and detectors.
  {
    file: s4,
    from: '"detectors": ["ssn", "card", "aadhaar", "pan", "email", "phone", "money"]',
    to: '"detectors": ["ssn", "card", "email", "phone", "money"]',
  },
  { file: s4, from: "| `ssn` | `pii` | Detector |", to: "| `ssn` | `pii` | Detector, label rule |" },
  {
    file: s4,
    from: "**PAN** is India's tax ID. **Aadhaar** is India's national ID. **SSN** is the US Social Security number.",
    to: "**SSN** is the US Social Security number. The `ssn` detector also matches ITINs, which share its shape.",
  },
  {
    file: s4,
    from: "| `ssn` | `999-99-9999` | Not area 000, 666, or 900 to 999 |",
    to: "| `ssn` | `999-99-9999` or `999 99 9999` | Area not 000 or 666; area 900 to 999 only as an ITIN, with group 50–65, 70–88, 90–92, or 94–99 |",
  },
  {
    file: s4,
    from: "| `phone` | US 10 digits; India 10 digits starting 6 to 9, optional +91 | — |",
    to: "| `phone` | US 10 digits, optional +1, with spaces, dots, dashes, or brackets | — |",
  },
  {
    file: s4,
    from: "| `money` | Currency sign or code, or grouped digits with 2 decimals | — |",
    to: "| `money` | `$` or `USD`, or grouped digits with 2 decimals | — |",
  },
  { file: s4, from: "Not masked: routing numbers and IFSC", to: "Not masked: routing numbers" },
  {
    file: s4,
    from: "**A US routing number and an Indian IFSC code** name a bank branch. They are public.",
    to: "**A US routing number** names a bank. It is public.",
  },
  {
    file: s4,
    from: "`SB99999999` matches `SB00481223`",
    to: "`SH99999999` matches `SH00481223`",
  },
  { file: s4, from: "| Masking routing numbers and IFSC |", to: "| Masking routing numbers |" },
  // §3.2 Label words. The new ssn row follows address, as §3.2 lists it.
  {
    file: s4,
    from: "| `name` | name, customer name, member name, account holder, holder name, nominee, father's name, mother's maiden name |",
    to: "| `name` | name, customer name, member name, account holder, holder name, joint owner, beneficiary, mother's maiden name |",
  },
  {
    file: s4,
    from: "| `address` | address, street, city, pin code, zip |",
    to: "| `address` | address, street, city, state, zip, zip code, postal code |\n| `ssn` | ssn, social security, social security number, tax id, tin, itin |",
  },
  { file: s4, from: '"Member Name: | RAVI KUMAR"', to: '"Member Name: | DANA WHITFIELD"' },
  // §3.3 Money, names, and other text.
  { file: s1, from: "with a $100 deposit", to: "with a $137.00 deposit" },
  { file: s1, from: "example values 100107 and 100", to: "example values 100107 and 137.00" },
  {
    file: s1,
    from: "a 2008-era Indian retail bank app",
    to: "a 2008-era US credit union back-office app",
  },
  { file: s2, from: '["savings", "current"]', to: '["savings", "checking"]' },
  { file: s3, from: "100107 Ravi Kumar", to: "100107 Dana Whitfield" },
  { file: s3, from: '"₹100" and "Rs. 100/-" both', to: '"$100" and "USD 100.00" both' },
  {
    file: s4,
    from: 'Indian bank apps say "Enquiry" for "look up"',
    to: 'some core banking apps say "Inquiry" for "look up"',
  },
  { file: s4, from: 'Transfer ₹100?', to: "Transfer $100?" },
  { file: s4, from: "The last four of a five-digit ID", to: "The last four of a six-digit ID" },
  { file: s4, from: '"1023-4" matches `100107`', to: '"1001-07" matches `100107`' },
  {
    file: s4,
    from: '"₹100", "Rs. 100/-", "INR 100.00", "100.00", "$100"',
    to: '"$100", "$100.00", "USD 100.00", "100.00", "100"',
  },
  {
    file: s4,
    from: 'Western "1,250.00" and Indian "1,00,000.00" both parse.',
    to: 'Western grouping, like "1,250.00", parses. Other styles need an app format.',
  },
  { file: s4, from: "IDs, PIN codes, and ZIP codes do not.", to: "IDs and ZIP codes do not." },
  { file: s4, from: "showMember('100107','Ravi')", to: "showMember('100107','Dana')" },
  {
    file: s4,
    from: "Consent for a ₹100 deposit cannot pay ₹10,000.",
    to: "Consent for a $100 deposit cannot pay $10,000.",
  },
  { file: s4, from: "Account opened for Ravi Kumar.", to: "Account opened for Dana Whitfield." },
  { file: s4, from: "dates as DD/MM/YYYY", to: "dates as MM/DD/YYYY" },
  // Why: owner decision 2026-09-26. §2 row 20 turns "share savings sub-account" into "share share".
  { file: s6, from: "new share share sub-account", to: "new share sub-account" },
];

function applyRenames(line: string): string {
  if (isSkipped(line)) return line;
  let out = line;
  for (const [from, to] of renames) out = out.replaceAll(from, () => to);
  return out;
}

function applyRowDeletions(file: string, lines: string[]): string[] {
  const cells = rowDeletions.filter((d) => d.file === file).map((d) => d.firstCell);
  if (cells.length === 0) return lines;
  const rows = cells.map((cell) => new RegExp(`^\\|\\s*${escapeRegExp(cell)}\\s*\\|`));
  // Why: §3.1, "row deletions match whole table rows by their first cell".
  return lines.filter((line) => isSkipped(line) || !rows.some((row) => row.test(line)));
}

function applyTextEdits(file: string, lines: string[], problems: string[]): string[] {
  let out = lines;
  for (const edit of textEdits.filter((e) => e.file === file)) {
    // Why: if the new text held the old, a second run would apply the edit again.
    if (edit.to.includes(edit.from)) throw new Error(`edit is not idempotent: ${edit.from}`);
    const hit = out.some((line) => !isSkipped(line) && line.includes(edit.from));
    if (hit) {
      // Why: a replacer function inserts `to` as is. A plain string would read "$`" as a pattern.
      const to = (): string => edit.to;
      out = out.map((line) => (isSkipped(line) ? line : line.replaceAll(edit.from, to)));
    } else if (!out.join("\n").includes(edit.to)) {
      problems.push(`${file}: §3 text not found, old or new: ${edit.from}`);
    }
  }
  // Why: an edit may add a line, like the new ssn row. Split again so each element is one line.
  return out.join("\n").split("\n");
}

function applyNotes(file: string, lines: string[], problems: string[]): string[] {
  const out = [...lines];
  for (const n of pointerNotes.filter((p) => p.file === file)) {
    const at = out.flatMap((line, i) => (line === n.heading ? [i] : []));
    const index = at[0];
    if (at.length !== 1 || index === undefined) {
      problems.push(`${file}: heading found ${String(at.length)} times: ${n.heading}`);
      continue;
    }
    const next = out.slice(index + 1).find((line) => line.trim() !== "");
    if (next === noteLine(n)) continue;
    const following = out[index + 1] ?? "";
    out.splice(index + 1, 0, "", noteLine(n), ...(following.trim() === "" ? [] : [""]));
  }
  return out;
}

function main(): void {
  const problems: string[] = [];
  const writes: [string, string][] = [];
  for (const file of sectionFiles()) {
    const path = `${designDir}${file}`;
    const before = readFileSync(path, "utf8");
    let lines = before.split("\n").map(applyRenames);
    lines = applyRowDeletions(file, lines);
    lines = applyTextEdits(file, lines, problems);
    lines = applyNotes(file, lines, problems);
    const after = lines.join("\n");
    if (after !== before) writes.push([path, after]);
  }
  if (problems.length > 0) {
    console.error(`docs:renames wrote nothing. Fix these ${String(problems.length)} problems:`);
    for (const p of problems) console.error(`  ${p}`);
    process.exitCode = 1;
    return;
  }
  for (const [path, text] of writes) writeFileSync(path, text);
  console.log(`docs:renames changed ${String(writes.length)} file(s).`);
}

main();
