// Shared fixture for the label-rule leak tests: made-up redaction rules and one legacy
// label-value table as an accessibility snapshot. Not a test file. Design section 4 §9.7.
// Values are made up. Seed member 100240 is the canary and never appears.
import { Redactor, type RedactionRules } from "../../../src/core/safety/redaction/redactor.js";

/** The rules of the leak: label kinds, detectors on, one date format. */
export const LEAK_RULES: RedactionRules = {
  detectors: ["ssn", "card", "email", "phone", "money"],
  digitRunMin: 5,
  formats: [],
  labels: {
    name: ["name"],
    address: ["address"],
    dob: ["date of birth"],
    member: ["cif"],
    ssn: ["ssn"],
    phone: ["phone"],
    money: ["balance"],
  },
  dateFormats: ["MM/DD/YYYY"],
};

/** The made-up values the page holds. */
export const NAME = "Wren Marlowquist";
export const DOB = "04/17/1971";
export const ADDRESS = "14 Birchwater Lane Tarnby";
export const MEMBER = "214906";
export const SSN = "XXX-XX-0000";
/** Every raw value, and one distinctive word of each, that must never reach a saved file. */
export const RAW = [NAME, DOB, ADDRESS, "Marlowquist", "Birchwater"];

/** A fresh redactor that knows {@link MEMBER} as the input `member_id`. */
export function leakRedactor(rules: RedactionRules = LEAK_RULES): Redactor {
  const r = new Redactor(rules);
  r.addKnown({ ref: "input.member_id", value: MEMBER, label: "pii", type: "text", kind: "member" });
  return r;
}

/**
 * A legacy page: the table, its row, its cell, and the inner table are each named with every
 * cell's words joined (as a browser names them), so the label is far from the value.
 */
export function legacyA11y(): string {
  const flat = `Info CIF No. ${MEMBER} Name ${NAME} SSN ${SSN} Date of Birth ${DOB} Address ${ADDRESS}`;
  return [
    `- table "${flat}":`,
    `  - row "${flat}":`,
    `    - cell "${flat}":`,
    `      - table "${flat}":`,
    `        - row "Info":`,
    `          - columnheader "Info"`,
    `        - row "CIF No. ${MEMBER}":`,
    `          - cell "CIF No."`,
    `          - cell "${MEMBER}"`,
    `        - row "Name ${NAME}":`,
    `          - cell "Name"`,
    `          - cell "${NAME}"`,
    `        - row "SSN ${SSN}":`,
    `          - cell "SSN"`,
    `          - cell "${SSN}"`,
    `        - row "Date of Birth ${DOB}":`,
    `          - rowheader "Date of Birth"`,
    `          - cell "${DOB}"`,
    `        - row "Address ${ADDRESS}":`,
    `          - cell "Address"`,
    `          - cell:`,
    `            - text: ${ADDRESS}`,
    "",
  ].join("\n");
}
