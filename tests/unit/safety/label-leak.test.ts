// Proves the label rule reaches accessibility and DOM snapshots: a value beside a sensitive label
// (first-row column header, else the cell to the left) is learned, so the joined names of its row,
// cell, and table mask it too, and later text in the same run does the same. Also proves the
// publish-time check `unmaskedLabelledLines`. Design section 4 §9.7, §9.13; the M05 leak in
// docs/decisions.md. Values are made up. Seed member 100240 is the canary and never appears.
import { describe, expect, test } from "vitest";
import { Redactor } from "../../../src/core/safety/redaction/redactor.js";
import {
  maskA11y,
  maskDom,
  unmaskedLabelledLines,
} from "../../../src/core/safety/redaction/snapshots.js";
import {
  ADDRESS,
  DOB,
  LEAK_RULES,
  MEMBER,
  NAME,
  RAW,
  SSN,
  leakRedactor,
  legacyA11y,
} from "./label-leak-kit.js";

/** The flattened name, as the masked snapshot should show it. */
const FLAT_MASKED =
  "Info CIF No. {input.member_id} Name [name#1] SSN [ssn#1] Date of Birth [dob#1] Address [address#1]";

describe("A: a legacy label-value table in an accessibility snapshot (§9.7)", () => {
  const out = maskA11y(legacyA11y(), leakRedactor());

  test("no raw name, date of birth, or address appears anywhere, ancestors included", () => {
    for (const raw of [...RAW, SSN, MEMBER]) expect(out).not.toContain(raw);
  });

  test("each value cell reads its token; the member ID reads its reference", () => {
    expect(out).toContain('- cell "[name#1]"');
    expect(out).toContain('- cell "[dob#1]"');
    expect(out).toContain("- text: [address#1]");
    expect(out).toContain('- cell "[ssn#1]"');
    expect(out).toContain('- cell "{input.member_id}"');
  });

  test("the same tokens appear inside the flattened names of the table, row, and cell", () => {
    const flatLines = out.split("\n").filter((l) => l.includes(FLAT_MASKED));
    expect(flatLines.map((l) => l.trim().split(" ")[1])).toEqual(["table", "row", "cell", "table"]);
  });

  test("the label cells stay readable", () => {
    for (const label of ["CIF No.", "Name", "SSN", "Date of Birth", "Address", "Info"]) {
      expect(out).toMatch(new RegExp(`- (cell|rowheader|columnheader) "${label}"`));
    }
    expect(out).toContain('- row "Name [name#1]":');
  });

  test("a column header labels the cells under it, as the table's first row", () => {
    const text = [
      '- table "People Wren Marlowquist":',
      '  - row "Member Name Branch":',
      '    - columnheader "Member Name"',
      '    - columnheader "Branch"',
      '  - row "Wren Marlowquist Main":',
      '    - cell "Wren Marlowquist"',
      '    - cell "Main"',
      "",
    ].join("\n");
    const got = maskA11y(text, leakRedactor());
    expect(got).not.toContain("Marlowquist");
    expect(got).toContain('- row "[name#1] Main":');
    expect(got).toContain('- cell "Main"');
  });

  test("a mask token beside a cell is not taken for a label", () => {
    // Why: the left cell reads `[name#1]` after the first pass; it must not label the next cell.
    const text = [
      '- table "t":',
      '  - row "Name Wren Marlowquist Open":',
      '    - cell "Name"',
      '    - cell "Wren Marlowquist"',
      '    - cell "Open"',
      "",
    ].join("\n");
    expect(maskA11y(text, leakRedactor())).toContain('- cell "Open"');
  });
});

describe("B: the run remembers what the label rule found (§9.7)", () => {
  test("later text in the same run masks the name and the address", () => {
    const r = leakRedactor();
    maskA11y(legacyA11y(), r);
    const got = r.text(`Opened for ${NAME}, who lives at ${ADDRESS}.`);
    expect(got).toBe("Opened for [name#1], who lives at [address#1].");
  });

  test("a fresh redactor does not mask a free sentence (the known limit stays)", () => {
    const sentence = `Opened for ${NAME}, who lives at ${ADDRESS}.`;
    const got = leakRedactor().text(sentence);
    expect(got).toContain(NAME);
    expect(got).toContain(ADDRESS);
  });

  test("learn with a label that is not sensitive remembers nothing", () => {
    const r = leakRedactor();
    r.learn(NAME, "Branch");
    expect(r.text(`Hi ${NAME}`)).toBe(`Hi ${NAME}`);
  });

  test("learn masks the longest value first, and the same value as the same token", () => {
    const r = leakRedactor();
    r.learn("Marlowquist", "Name");
    r.learn(NAME, "Name");
    // Why: the short value must not cut the long one into "Wren [name#2]" (§9.6).
    expect(r.text(`${NAME} and Marlowquist and ${NAME}`)).toBe("[name#1] and [name#2] and [name#1]");
  });

  test("learn leaves out the part a known value already masks", () => {
    const r = leakRedactor();
    r.learn(`${MEMBER} ${NAME}`, "Name");
    expect(r.text(`id ${MEMBER}`)).toBe("id {input.member_id}");
    expect(r.text(NAME)).toBe("[name#1]");
  });

  test("learn matches whole words only", () => {
    const r = leakRedactor();
    r.learn("Lane", "Address");
    expect(r.text("Lane")).toBe("[address#1]");
    expect(r.text("Laneway")).toBe("Laneway");
  });

  test("learn ignores a value that has no letter or digit", () => {
    const r = leakRedactor();
    r.learn("--", "Name");
    expect(r.text("a -- b")).toBe("a -- b");
  });
});

describe("C: a DOM snapshot learns before it masks (§9.13)", () => {
  test("a title attribute before a Name | value table masks the value too", () => {
    const html = `<p title="${NAME}">Member</p>
<table><tr><td>Name</td><td>${NAME}</td></tr></table>`;
    const got = maskDom(html, leakRedactor());
    expect(got).not.toContain("Marlowquist");
    expect(got).toMatch(/title="\[name#1\]"/);
    expect(got).toMatch(/<td>\[name#1\]<\/td>/);
    expect(got).toContain("<td>Name</td>");
  });

  test("a column header labels the cells under it", () => {
    const html = `<p>See ${ADDRESS}</p>
<table><tr><th>Address</th><th>Branch</th></tr><tr><td>${ADDRESS}</td><td>Main</td></tr></table>`;
    const got = maskDom(html, leakRedactor());
    expect(got).not.toContain("Birchwater");
    expect(got).toContain("<td>Main</td>");
  });
});

describe("F: unmaskedLabelledLines (§9.7)", () => {
  test("the masked output of A has no line left", () => {
    const r = leakRedactor();
    expect(unmaskedLabelledLines(maskA11y(legacyA11y(), r), r)).toEqual([]);
  });

  test("the raw text of A gives the value-cell lines, not the label lines", () => {
    const raw = legacyA11y();
    const lines = raw.split("\n");
    const got = unmaskedLabelledLines(raw, new Redactor(LEAK_RULES));
    // The member ID, name, SSN, and date of birth cells, and the address cell with its text child.
    expect(got.map((n) => lines[n - 1]?.trim())).toEqual([
      `- cell "${MEMBER}"`,
      `- cell "${NAME}"`,
      `- cell "${SSN}"`,
      `- cell "${DOB}"`,
      "- cell:",
    ]);
  });

  test("a cell that only holds a mask is clean; a cell with other words is not", () => {
    const r = new Redactor(LEAK_RULES);
    const clean = ['- row "r":', '  - cell "Name"', '  - cell "[name#4]"', ""].join("\n");
    const dirty = ['- row "r":', '  - cell "Name"', '  - cell "[name#4] extra"', ""].join("\n");
    expect(unmaskedLabelledLines(clean, r)).toEqual([]);
    expect(unmaskedLabelledLines(dirty, r)).toEqual([3]);
  });

  test("a cell beside a label that is not sensitive is not flagged", () => {
    const text = ['- row "r":', '  - cell "Branch"', '  - cell "Main Street Branch"', ""].join("\n");
    expect(unmaskedLabelledLines(text, new Redactor(LEAK_RULES))).toEqual([]);
  });
});
