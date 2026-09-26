// The section 10 doc changes as data, shared by docs-renames.ts and docs-verify.ts.
// Follows intyy-design-updates-from-section-10.md §2, §3, §14, and §15.
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** The folder that holds design sections 1 to 10. */
export const designDir = fileURLToPath(new URL("../docs/design/", import.meta.url));

/** Section files 1 to 9. Never section 10, the updates file, or CONTRACT.md (updates §15). */
export function sectionFiles(): string[] {
  return readdirSync(designDir)
    .filter((name) => /^[1-9]-intyy-.*\.md$/.test(name))
    .sort();
}

/** Why: updates §15, lines that describe the renames themselves stay as they are. */
export function isSkipped(line: string): boolean {
  return line.toLowerCase().includes("placeholder");
}

/** Updates §2: exact, case-sensitive replacements, applied in this order. */
export const renames: readonly (readonly [string, string])[] = [
  ["intyy-section-2-artifact-schema.md", "2-intyy-artifact-schema.md"],
  ["intyy-context.md", "1-intyy-component-level-design.md"],
  ["bank-app-handoff.md", "CONTRACT.md"],
  ["INTYY_BANK_A_SPARROW_CORE_", "INTYY_KEYSTONE_KVFCU_"],
  ["INTYY_BANK_A_", "INTYY_KEYSTONE_"],
  ["sparrow.bank-a.example", "kvfcu.keystone.example"],
  ["bank-a.example", "keystone.example"],
  ["sparrow-core/open_savings_subaccount", "kvfcu/open_share_subaccount"],
  ["open_savings_subaccount", "open_share_subaccount"],
  ["sparrow-core", "kvfcu"],
  ["bank_a", "keystone"],
  ["bank_b", "lakeshore"],
  ["Bank A", "Keystone"],
  ["bank A", "keystone"],
  ["Bank B", "Lakeshore"],
  ["bank B", "lakeshore"],
  ["{secret.operator_login}", "{secret.operator_username}"],
  ["10234", "100107"],
  ["Open savings sub-account", "Open share sub-account"],
  ["savings sub-account", "share sub-account"],
  ["new savings account", "new share account"],
];

/** One updates §14 pointer note: the heading it sits under, its text, and the updates section. */
export interface PointerNote {
  file: string;
  heading: string;
  note: string;
  section: number;
}

/** Updates §14: one pointer note per heading. */
export const pointerNotes: readonly PointerNote[] = [
  ...notesFor("1-intyy-component-level-design.md", 4, [
    ["## 12. Seeing the screen", "The stripped-button demo is settled"],
    ["## 16. How we verify it", "The member canary is seed member 100240"],
    ["## 17. Build plan", "Replaced by the build plan's thirteen milestones"],
    ["## 18. Built, designed, or cut", "Statuses for patches, drafting, and the visual clue changed"],
    ["## 20. Next: the bank app contract", "The contract is CONTRACT.md 1.1.0"],
  ]),
  ...notesFor("2-intyy-artifact-schema.md", 5, [
    ["## 18. Tenant patch format", "Schema and loader built; merge designed only"],
  ]),
  ...notesFor("3-intyy-run-outputs.md", 6, [
    ["## 10. Items parked for other sections", "Items for section 10 are resolved"],
  ]),
  ...notesFor("4-intyy-safety-policy.md", 3, [
    ["### 9.4 Kinds", "US kinds: aadhaar and pan removed"],
    ["### 9.7 The label rule", "US label words"],
    ["### 9.8 Detectors and format patterns", "US detectors; ITIN added"],
  ]),
  ...notesFor("4-intyy-safety-policy.md", 7, [
    ["### A requirement on the bank app", "Settled: member 100240 is the canary"],
    ["### 15.1 Risk", "The second-reviewer rule is built"],
    ["## 18. Items parked for other sections", "Items for section 10 are resolved"],
  ]),
  ...notesFor("5-intyy-handler-packs-and-error-ladder.md", 8, [
    ["## 19. Items parked for other sections", "Items for section 10 are resolved"],
  ]),
  ...notesFor("6-intyy-discover-and-recorder.md", 9, [
    ["## 21. Items parked for other sections", "Items for section 10 are resolved"],
  ]),
  ...notesFor("7-intyy-replay-engine-and-handoff.md", 10, [
    ["## 24. Items parked for other sections", "Items for section 10 are resolved"],
  ]),
  ...notesFor("8-intyy-trust-and-versions.md", 11, [
    ["### 7.6 The scripted operator", "certify case gains --operator mailbox"],
    ["### 13.4 Patch drafting", "Not built"],
    ["### 13.5 The lakeshore drill", "Replaced in the build by an optional probe"],
    ["## 17. Built, thin, or designed", "Patch drafting and the drill statuses changed"],
    ["## 21. Items parked for other sections", "Items for section 10 are resolved"],
  ]),
  ...notesFor("9-intyy-interfaces.md", 12, [
    ["### 6.1 Two parts: library and state", "model_keys fixed; canary_members added"],
    ["### 6.6 Publishing evidence", "Publish copies artifacts, places trust snapshots, warns on size"],
    ["### 7.3 Global flags", "The CLI loads .env without overriding set variables"],
    ["### 9.1 Certify", "certify case gains --operator mailbox"],
    ["### 13.1 Setup", "Exact bank app options"],
    ["### 13.2 The path", "Adds the handoff demo"],
    ["## 19. Items parked for other sections", "Items for section 10 are resolved"],
  ]),
];

function notesFor(file: string, section: number, rows: [string, string][]): PointerNote[] {
  return rows.map(([heading, note]) => ({ file, heading, note, section }));
}

/** The exact line updates §14 puts under a heading. */
export function noteLine(n: PointerNote): string {
  return `> **Changed by section 10:** ${n.note}. See \`intyy-design-updates-from-section-10.md\` §${String(n.section)}.`;
}

/** True for a §14 pointer note line. Its text is fixed by §14, and one note names aadhaar. */
export function isPointerNote(line: string): boolean {
  return line.startsWith("> **Changed by section 10:** ");
}

/** Escapes text so a RegExp matches it literally. */
export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The pattern docs:verify looks for. Why: `bank-a` must not match inside `bank-app`. */
export function leftoverPattern(word: string): RegExp {
  const escaped = escapeRegExp(word);
  return new RegExp(word === "bank-a" ? `${escaped}(?![a-z])` : escaped);
}

/** Updates §15: words that must not appear outside skipped lines after the renames. */
export const leftoverWords: readonly string[] = [
  "sparrow", "bank_a", "bank_b", "BANK_A", "bank-a", "Bank A", "bank A", "Bank B", "bank B",
  "open_savings_subaccount", "10234", "₹", "Rs.", "INR", "Ravi", "Kumar", "IFSC", "aadhaar",
  "Aadhaar", "`pan`", "Indian", "operator_login", "intyy-section-2", "intyy-context",
  "bank-app-handoff",
];
