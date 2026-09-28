// Run spec rules beyond the schema: example values, labels, correlation, and negative runs.
// Follows design section 6 §6.1, §7.2 (checks at run start), section 2 §12.3 and §12.4 (types and
// constraints), and section 9 §8.1 (`spec check`). Rejected specs never open a browser (§7.2).
import type { RunSpec, SpecInput } from "../model/runspec.js";

/** What the checks need besides the spec. */
export type SpecFacts = {
  /** Today in the app's time zone, `YYYY-MM-DD`. */
  today: string;
  /** Reserved member numbers (`canary_members` in `intyy.json`). */
  canaries: readonly string[];
  /** Sensitive label words per kind, from the effective policy (section 4 §9.7). */
  labels: Readonly<Record<string, readonly string[]>>;
  /** The app's environment from the bank settings, or null when the app is not in them. */
  environment: "test" | "production" | null;
};

/** Every problem and warning, one line each. Problems reject the spec; warnings do not. */
export type SpecReport = { problems: string[]; warnings: string[] };

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Days per month in a common year. */
const DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** True when `v` is a real calendar date in `YYYY-MM-DD` form. */
function isDate(v: string): boolean {
  const m = DATE.exec(v);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  const max = mo === 2 && leap ? 29 : (DAYS[mo - 1] ?? 0);
  return d >= 1 && d <= max;
}

/** Why the example does not fit its type, or null. */
function typeProblem(input: SpecInput): string | null {
  const v = input.example;
  switch (input.type) {
    case "integer":
      return /^-?\d+$/.test(v) ? null : "is not a whole number";
    case "decimal":
      return /^-?\d+(\.\d+)?$/.test(v) ? null : "is not a decimal number";
    case "money":
      // Why: section 2 §12.3, money is a decimal string like "100.00".
      return /^\d+\.\d{2}$/.test(v) ? null : "is not a money value like 137.00";
    case "date":
      return isDate(v) ? null : "is not a date like 2026-01-15";
    case "boolean":
      return v === "true" || v === "false" ? null : "is not true or false";
    case "enum":
      return input.constraints?.values === undefined
        ? "is an enum with no values list"
        : input.constraints.values.includes(v)
          ? null
          : "is not one of the listed values";
    case "string":
      return null;
  }
}

const FORMATS = { digits: /^\d+$/, letters: /^[A-Za-z]+$/, alphanumeric: /^[A-Za-z0-9]+$/ };

/** Compares two values of one type: numbers by amount, dates as text. */
function below(type: SpecInput["type"], v: string, bound: string | number): boolean {
  if (type === "date") return v < String(bound);
  return Number(v) < Number(bound);
}

/** Why the example breaks its constraints, one line each. */
function constraintProblems(input: SpecInput): string[] {
  const c = input.constraints;
  if (c === undefined) return [];
  const v = input.example;
  const out: string[] = [];
  if (c.length && (v.length < c.length.min || v.length > c.length.max))
    out.push(`is not ${String(c.length.min)} to ${String(c.length.max)} characters long`);
  if (c.format && !FORMATS[c.format].test(v)) out.push(`is not ${c.format} only`);
  if (c.range?.min !== undefined && below(input.type, v, c.range.min))
    out.push("is below the range");
  if (c.range?.max !== undefined && below(input.type, String(c.range.max), v))
    out.push("is above the range");
  if (c.values && input.type !== "enum") out.push("has a values list but is not an enum");
  return out;
}

/**
 * A value as the redactor compares it: numbers by amount, text by its words (section 4 §9.3,
 * docs/decisions.md M02). So `137.00` and `137` count as the same value.
 */
export function normalizeValue(v: string): string {
  const t = v.trim();
  if (/^-?\d+(\.\d+)?$/.test(t)) return String(Number(t));
  return t.toLowerCase().replace(/\s+/g, " ");
}

/**
 * The label the policy's label words suggest (section 6 §6.1): money means `financial`, and
 * unsure means `pii`. A money label word in the name or description also means `financial`.
 */
export function proposeSensitivity(
  input: Pick<SpecInput, "name" | "type" | "description">,
  labels: SpecFacts["labels"],
): "pii" | "financial" {
  if (input.type === "money") return "financial";
  const text = ` ${`${input.name.replaceAll("_", " ")} ${input.description}`.toLowerCase()} `;
  const money = labels.money ?? [];
  return money.some((w) => text.includes(` ${w.toLowerCase()} `)) ? "financial" : "pii";
}

/** Checks the inputs: types, constraints, distinct values, dates, short and round values. */
function inputChecks(spec: RunSpec, facts: SpecFacts, r: SpecReport): void {
  const seen = new Map<string, string>();
  const names = new Set<string>();
  for (const input of spec.inputs) {
    const at = `input ${input.name}`;
    if (names.has(input.name)) r.problems.push(`${at}: the name is used twice`);
    names.add(input.name);
    const tp = typeProblem(input);
    if (tp !== null) r.problems.push(`${at}: the example ${tp}`);
    for (const p of constraintProblems(input)) r.problems.push(`${at}: the example ${p}`);

    const norm = normalizeValue(input.example);
    const other = seen.get(norm);
    // Why: section 6 §7.2, the redactor would write a token, not a reference.
    if (other !== undefined)
      r.problems.push(`${at}: the example is the same value as input ${other}`);
    seen.set(norm, input.name);

    if (facts.canaries.some((c) => input.example.includes(c)))
      r.problems.push(`${at}: the example holds a canary member number. Pick another value`);
    if (input.type === "date" && input.example === facts.today)
      r.problems.push(`${at}: the example is today; the screen shows today everywhere`);

    const sensitive = input.sensitivity !== "none";
    if (sensitive && input.example.length < 4)
      r.warnings.push(`${at}: the example is under 4 characters, so text clues cannot use it`);
    if (input.type === "money" && Number(input.example) % 10 === 0)
      r.warnings.push(`${at}: round amounts appear on screens by chance. Use a value like 137.00`);
    const proposed = proposeSensitivity(input, facts.labels);
    if (input.sensitivity === "none" || (proposed === "financial" && input.sensitivity === "pii"))
      r.warnings.push(`${at}: labelled ${input.sensitivity}; the label words suggest ${proposed}`);
  }
}

/** Checks the goal: inputs by name only, and every reference declared. */
function goalChecks(spec: RunSpec, r: SpecReport): void {
  const declared = new Set(spec.inputs.map((i) => i.name));
  for (const m of spec.goal.matchAll(/\{input\.([a-z0-9_]+)\}/g)) {
    if (!declared.has(m[1] ?? "")) r.problems.push(`goal: {input.${m[1] ?? ""}} is not an input`);
  }
  for (const input of spec.inputs) {
    if (spec.goal.includes(input.example))
      r.problems.push(`goal: it holds input ${input.name}'s value. Write {input.${input.name}}`);
  }
}

/** Checks the fields that depend on the kind and the expected effect. */
function kindChecks(spec: RunSpec, r: SpecReport): void {
  if (spec.expected_effect === "commits" && spec.correlation === undefined)
    r.problems.push("correlation: a commits run needs notes or none (section 6 §16)");
  if (spec.expected_effect === "read_only" && spec.correlation !== undefined)
    r.problems.push("correlation: only a commits run takes correlation");
  if (spec.kind === "negative_discovery") {
    if (spec.expected_outcome === undefined)
      r.problems.push("expected_outcome: a negative run needs a code and a description");
    if (spec.outputs.length > 0) r.problems.push("outputs: a negative run has no outputs");
  } else if (spec.expected_outcome !== undefined) {
    r.problems.push("expected_outcome: only a negative run takes one");
  }
  const outs = new Set<string>();
  for (const o of spec.outputs) {
    if (outs.has(o.name)) r.problems.push(`output ${o.name}: the name is used twice`);
    outs.add(o.name);
  }
}

/**
 * Every section 6 rule, all at once (section 6 §7.2: the CLI lists every problem at once).
 * Example values are accepted only for apps whose settings say `test` (section 9 §8.1).
 */
export function checkSpec(spec: RunSpec, facts: SpecFacts): SpecReport {
  const r: SpecReport = { problems: [], warnings: [] };
  if (facts.environment === null)
    r.problems.push(`app: ${spec.app} is not in the tenant's approved settings`);
  else if (facts.environment !== "test" && spec.inputs.length > 0)
    r.problems.push("inputs: example values in a spec file are accepted only for test apps");
  inputChecks(spec, facts, r);
  goalChecks(spec, r);
  kindChecks(spec, r);
  return r;
}
