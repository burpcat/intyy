// The text redactor: one per run, one rule set for every output. The only maker of Masked values.
// Follows design section 4 §9.1 to §9.10 (mask formats, per-run tokens, kinds, the six text
// rules in order, known values, the label rule, detectors, format patterns, digit runs), the
// updates file §3 (US kinds and detectors), and section 3 §6.7 (redaction points).
import type { Masked } from "../../../ports/masked.js";
import type { EffectivePolicy } from "../policy/merge.js";
import { normalizeWords } from "../risk/classify.js";
import { Secret } from "../../../ports/secret.js";
import { escapeRegex, parseIdFormat } from "./id-format.js";

/** The rule set, from the merged policy. Kinds are the names of section 4 §9.4. */
export type RedactionRules = {
  detectors: readonly string[];
  /** Five or more digits left over become `[digits#n]` (§9.9). Null counts as the strictest, 1. */
  digitRunMin: number | null;
  formats: readonly { format: string; kind: string }[];
  /** Sensitive label words per kind (§9.7). */
  labels: Readonly<Record<string, readonly string[]>>;
  /** Display formats a date input may appear in, like `MM/DD/YYYY` (§9.6, "Dates"). */
  dateFormats: readonly string[];
};

/** Takes the rule set out of the merged policy. */
export function redactionRules(p: EffectivePolicy): RedactionRules {
  return {
    detectors: p.redaction.detectors,
    digitRunMin: p.redaction.digit_run_min,
    formats: p.redaction.formats,
    labels: p.redaction.labels,
    dateFormats: p.formats.date,
  };
}

/**
 * A raw value this run holds in memory: an input, or an output once read (§9.6).
 * `ref` is written as `{ref}`. `kind` names the token used when a reference would mislead:
 * a short sensitive value, or two known values that clash.
 */
export type KnownValue = {
  ref: string;
  value: string;
  label: "pii" | "financial" | "none";
  type: "text" | "money" | "date";
  kind: string;
};

/** Shapes a fact may take: strings intyy makes itself, never screen or model text. */
const FACT_SHAPES = [
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/, // an ISO time
  /^(run|batch|lease|alert)_\d{4}-\d{2}-\d{2}_[0-9a-hjkmnp-tv-z]{10}$/, // an ID (section 3 §7.2)
  /^sha256:[0-9a-f]{64}$/, // a hash
  /^(screens|dom|a11y|crops|llm|blobs)\/\d{5}_[a-z0-9_]+\.(png|html|yaml|json)$/, // a run file (§7.4)
  // An artifact key: `<app>/<capability>@<major>` or `@<major>.<minor>.<patch>` (section 2 §9).
  // Why a fact: the email detector would turn `kvfcu/open_sub@1.0.0` into `kvfcu/[email#1]`.
  /^[a-z][a-z0-9_-]*\/[a-z][a-z0-9_]*@\d+(\.\d+\.\d+)?$/,
  // A prompt version, like `discovery@1.1` (section 6 §11.4; the RunSpec `prompt` pattern).
  // Why a fact: the email detector would turn `discovery@1.1` into `[email#1]` in `run_start`.
  /^discovery@\d+\.\d+$/,
  // A run spec's name, like `kvfcu/open_share_subaccount.missing` (`run.json`'s `spec`, section 6
  // §14.8). Why a fact: the dotted variant could look like a domain name to the masking rules.
  /^[a-z][a-z0-9_-]*\/[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)?$/,
  // An outcome or decision code a contract declares, like `member_not_found` (section 7 §13.2).
  // Why a fact: `operator decide --outcome` writes it into `decision.json`. The CLI checks it
  // against the request's declared codes first, so it is never free text.
  /^[a-z][a-z0-9_]*$/,
];

/**
 * A string intyy made itself, like a file name or a hash. `Redactor.value` keeps it as is.
 * Why: the digit-run rule (§9.9) would turn `screens/00031_observation.png` into a token.
 */
export class Fact {
  private constructor(readonly text: string) {}

  /** Makes a fact. A string of any other shape is a bug, so it throws. */
  static of(text: string): Fact {
    if (!FACT_SHAPES.some((re) => re.test(text))) throw new Error("not a fact shape");
    return new Fact(text);
  }

  /** A fact serializes as its plain text. */
  toJSON(): string {
    return this.text;
  }
}

/** Shorthand for {@link Fact.of}. */
export const fact = (text: string): Fact => Fact.of(text);

/** Makes a Masked value. Why a cast: the brand has no runtime form (section 9 §5.1). */
function mask<T>(value: T): Masked<T> {
  return value as Masked<T>;
}

/**
 * `JSON.stringify`, then re-branded (section 9 §5.1). `value` must already be masked, like
 * `Redactor.value`'s own output: this never runs a rule itself, so it must never see a raw
 * value. Digit-run masking treats free text; a fact-wrapped ID inside `value` has already
 * resolved to its plain string (`Fact.toJSON`), so running it again here would mangle it.
 */
export function maskedJson(value: Masked<unknown>): Masked<string> {
  return mask(JSON.stringify(value));
}

/** A piece of one line. A masked piece is never scanned again (§9.5). */
type Segment = { text: string; masked: boolean };

/** Replaces each match in unmasked pieces. `out` returns the mask, or null to keep the text. */
function replaceIn(
  segments: readonly Segment[],
  re: RegExp,
  out: (m: RegExpExecArray) => string | null,
): Segment[] {
  const result: Segment[] = [];
  for (const s of segments) {
    if (s.masked) {
      result.push(s);
      continue;
    }
    let last = 0;
    for (const m of s.text.matchAll(re)) {
      const replacement = out(m);
      if (replacement === null) continue;
      if (m.index > last) result.push({ text: s.text.slice(last, m.index), masked: false });
      result.push({ text: replacement, masked: true });
      last = m.index + m[0].length;
    }
    if (last < s.text.length) result.push({ text: s.text.slice(last), masked: false });
  }
  return result;
}

/** No letter or digit before. */
const START = "(?<![\\p{L}\\p{N}])";
/** No letter or digit after. */
const END = "(?![\\p{L}\\p{N}])";

/** An amount: Western grouping or plain digits (§9.6, "Money"). */
const AMOUNT = "(\\d{1,3}(?:,\\d{3})+|\\d+)";

/** Any money span, with or without `$` or `USD`. Used to match money inputs by amount. */
const MONEY_SPAN = new RegExp(
  `(?<![\\p{L}\\p{N}.,])(?:(?:\\$|USD)\\s?)?${AMOUNT}(?:\\.(\\d{1,2}))?(?![\\p{L}\\p{N}]|[.,]\\d)`,
  "gu",
);

/** The money detector: `$` or `USD`, or grouped digits with 2 decimals (updates file §3.1). */
const MONEY_DETECTOR = new RegExp(
  `(?:\\$|${START}USD)\\s?${AMOUNT}(?:\\.(\\d{1,2}))?(?!\\p{N})` +
    `|(?<![\\p{L}\\p{N}.,$])${AMOUNT}\\.(\\d{2})(?!\\p{N}|[.,]\\d)`,
  "gu",
);

/** Reads an amount as `dollars.cents`, like `1250.00`. */
function amountKey(whole: string, cents: string | undefined): string {
  const dollars = whole.replace(/,/g, "").replace(/^0+(?=\d)/, "");
  return `${dollars}.${(cents ?? "").padEnd(2, "0")}`;
}

/** The amount of a money value like `137.00` or `$1,250`. Null when it is not money. */
function parseAmount(text: string): string | null {
  const m = new RegExp(`^(?:(?:\\$|USD)\\s?)?${AMOUNT}(?:\\.(\\d{1,2}))?$`, "u").exec(text.trim());
  return m === null ? null : amountKey(m[1] ?? "", m[2]);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Writes an ISO date (`2026-01-15`) in one display format, like `DD-MMM-YYYY`. */
function formatDate(iso: string, format: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (m === null) return null;
  const [, y = "", mo = "", d = ""] = m;
  const parts: Record<string, string> = {
    YYYY: y,
    YY: y.slice(2),
    MMM: MONTHS[Number(mo) - 1] ?? mo,
    MM: mo,
    DD: d,
  };
  return format.replace(/YYYY|YY|MMM|MM|DD/g, (t) => parts[t] ?? t);
}

/** SSN check (updates file §3.1): area not 000 or 666; area 900 to 999 only as an ITIN. */
function ssnValid(area: number, group: number): boolean {
  if (area === 0 || area === 666) return false;
  if (area < 900) return true;
  const inRange = (lo: number, hi: number): boolean => group >= lo && group <= hi;
  return inRange(50, 65) || inRange(70, 88) || inRange(90, 92) || inRange(94, 99);
}

/** The Luhn check digit (section 4 §9.8, `card`). */
function luhnValid(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i += 1) {
    let d = Number(digits.charAt(digits.length - 1 - i));
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

/** One built-in detector: a shape and an optional check (section 4 §9.8). */
type Detector = { kind: string; re: RegExp; check: (m: RegExpExecArray) => boolean };

/** The detectors, in the order they run. */
const DETECTORS: readonly Detector[] = [
  {
    kind: "ssn",
    re: new RegExp(`${START}(\\d{3})([- ])(\\d{2})\\2(\\d{4})${END}`, "gu"),
    check: (m) => ssnValid(Number(m[1]), Number(m[3])),
  },
  {
    kind: "card",
    re: new RegExp(`${START}\\d(?:[ -]?\\d){12,18}${END}`, "gu"),
    check: (m) => luhnValid(m[0].replace(/\D/g, "")),
  },
  {
    kind: "email",
    re: /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/gu,
    check: () => true,
  },
  {
    kind: "phone",
    re: new RegExp(
      `(?<![\\p{L}\\p{N}+])(?:\\+?1[ .-]?)?(?:\\(\\d{3}\\)|\\d{3})[ .-]?\\d{3}[ .-]?\\d{4}${END}`,
      "gu",
    ),
    check: () => true,
  },
  { kind: "money", re: MONEY_DETECTOR, check: () => true },
];

/**
 * How a token tells two values apart: money by amount, numbers by their digits, text by words.
 * So `(555) 010-4477` and `+1 555 010 4477` get one token.
 */
function tokenKey(kind: string, text: string): string {
  if (kind === "money") {
    const amount = parseAmount(text);
    if (amount !== null) return amount;
  }
  if (/^[\d\s().+-]+$/.test(text)) {
    const digits = text.replace(/\D/g, "");
    return kind === "phone" && digits.length === 11 ? digits.slice(1) : digits;
  }
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * The redactor for one run. It holds known values and the token map in memory only; both
 * vanish with the run (§9.1, §9.3). Every text output calls `text`.
 */
export class Redactor {
  readonly #rules: RedactionRules;
  readonly #formats: { kind: string; re: RegExp }[];
  readonly #known: KnownValue[] = [];
  readonly #tokens = new Map<string, number>();
  readonly #counts = new Map<string, number>();

  /** Starts a run's redactor. Format patterns were checked by the policy loader. */
  constructor(rules: RedactionRules) {
    this.#rules = rules;
    this.#formats = rules.formats.map(({ format, kind }) => {
      const re = parseIdFormat(format);
      if (!re.ok) throw new Error(`policy holds a bad format pattern: ${format}`);
      return { kind, re: re.value };
    });
  }

  /** Adds a known value: the inputs at run start, and each output once read (§9.6). */
  addKnown(v: KnownValue): void {
    this.#known.push(v);
  }

  /**
   * The value of a known input labelled `none`, for the task block (section 6 §8.1). Null for
   * any sensitive value, or a reference the run does not know. Screen text still shows the reference.
   */
  noneValue(ref: string): Masked<string> | null {
    const v = this.#known.find((k) => k.ref === ref);
    return v?.label === "none" ? mask(v.value) : null;
  }

  /**
   * Adds a secret's value as a known value, so an app that shows it back, like "Welcome,
   * kv_teller_4821", masks as `{secret.operator_username}` (docs/decisions.md, M03). The value
   * stays in this run's memory only, like every known value (§9.1).
   */
  addSecret(name: string, secret: Secret): void {
    this.#known.push({
      ref: `secret.${name}`,
      value: Secret.open(secret),
      label: "pii",
      type: "text",
      kind: "name",
    });
  }

  /** Rule 1: a secret-filled field is never read. Its content is always `[secret]` (§9.5). */
  secretField(): Masked<string> {
    return mask("[secret]");
  }

  /**
   * Masks one text through the six rules, in order (§9.5). `label` is the label found beside
   * the text: its field label, its column header, or the cell to its left (§9.7).
   */
  text(text: string, context: { label?: string } = {}): Masked<string> {
    return mask(
      text
        .split("\n")
        .map((line) => this.#line(line, context.label))
        .join("\n"),
    );
  }

  /**
   * Masks every string inside a value: objects, arrays, and their keys' values. Keys,
   * non-strings, and facts stay. The run log writer uses it on each line (section 3 §6.7).
   */
  value<T>(v: T): Masked<T> {
    const walk = (x: unknown): unknown => {
      if (x instanceof Fact) return x.text;
      if (typeof x === "string") return this.text(x);
      if (Array.isArray(x)) return x.map(walk);
      if (x !== null && typeof x === "object") {
        return Object.fromEntries(Object.entries(x).map(([k, val]) => [k, walk(val)]));
      }
      return x;
    };
    return mask(walk(v) as T);
  }

  /** True when `label` holds a sensitive label phrase (§9.7), so a text beside it masks whole. */
  sensitiveLabel(label: string): boolean {
    return this.#labelKind(label) !== null;
  }

  /** Runs rules 2 to 6 on one line. */
  #line(line: string, label: string | undefined): string {
    let segs: Segment[] = [{ text: line, masked: false }];
    segs = this.#knownValues(segs);
    segs = this.#labelRule(segs, label);
    for (const d of DETECTORS) {
      if (!this.#rules.detectors.includes(d.kind)) continue;
      segs = replaceIn(segs, d.re, (m) => (d.check(m) ? this.#token(d.kind, m[0]) : null));
    }
    for (const f of this.#formats) {
      segs = replaceIn(segs, f.re, (m) => this.#token(f.kind, m[0]));
    }
    // Why: decisions.md (M01), a missing field counts as its strictest value.
    const min = this.#rules.digitRunMin ?? 1;
    segs = replaceIn(segs, new RegExp(`\\d{${String(min)},}`, "g"), (m) =>
      this.#token("digits", m[0]),
    );
    return segs.map((s) => s.text).join("");
  }

  /** A per-run token (§9.3). The same value gets the same token; numbers count from 1 per kind. */
  #token(kind: string, text: string): string {
    const key = `${kind}\u0000${tokenKey(kind, text)}`;
    let n = this.#tokens.get(key);
    if (n === undefined) {
      n = (this.#counts.get(kind) ?? 0) + 1;
      this.#counts.set(kind, n);
      this.#tokens.set(key, n);
    }
    return `[${kind}#${String(n)}]`;
  }

  /** Rule 2: known values, longest first (§9.6). */
  #knownValues(segments: Segment[]): Segment[] {
    const groups = new Map<string, KnownValue[]>();
    for (const v of this.#known) {
      const key = `${v.type}\u0000${this.#valueKey(v)}`;
      groups.set(key, [...(groups.get(key) ?? []), v]);
    }
    const ordered = [...groups.values()].sort(
      (a, b) => (b[0]?.value.trim().length ?? 0) - (a[0]?.value.trim().length ?? 0),
    );
    let segs = segments;
    for (const group of ordered) {
      const first = group[0];
      if (first === undefined) continue;
      const short = first.value.trim().length < 4;
      if (short && group.every((v) => v.label === "none")) continue;
      // Why: §9.6, two refs with one value cannot say which appeared; a short value appears by chance.
      const clash = new Set(group.map((v) => v.ref)).size > 1;
      const out = (text: string): string =>
        short || clash ? this.#token(first.kind, text) : `{${first.ref}}`;
      segs = this.#matchKnown(segs, first, out);
    }
    return segs;
  }

  /** The value a known value is compared by: its amount, its date, or its words. */
  #valueKey(v: KnownValue): string {
    if (v.type === "money") return parseAmount(v.value) ?? v.value;
    return v.value.trim().replace(/\s+/g, " ").toLowerCase();
  }

  /** Replaces one known value's matches: money by amount, dates in every format, text by words. */
  #matchKnown(segs: Segment[], v: KnownValue, out: (text: string) => string): Segment[] {
    if (v.type === "money") {
      const want = parseAmount(v.value);
      if (want !== null) {
        return replaceIn(segs, MONEY_SPAN, (m) =>
          amountKey(m[1] ?? "", m[2]) === want ? out(m[0]) : null,
        );
      }
    }
    if (v.type === "date") {
      const shown = this.#rules.dateFormats
        .map((f) => formatDate(v.value, f))
        .filter((s): s is string => s !== null)
        .sort((a, b) => b.length - a.length);
      if (shown.length > 0) {
        const re = new RegExp(`${START}(?:${shown.map(escapeRegex).join("|")})${END}`, "giu");
        return replaceIn(segs, re, (m) => out(m[0]));
      }
    }
    const clean = v.value.trim().replace(/\s+/g, " ");
    const body = /^\d+$/.test(clean)
      ? clean.replace(/\d(?=\d)/g, "$&[\\s-]?")
      : clean.split(" ").map(escapeRegex).join("\\s+");
    return replaceIn(segs, new RegExp(`${START}${body}${END}`, "giu"), (m) => out(m[0]));
  }

  /** The kind a label names, by its longest matching label phrase. Null when not sensitive. */
  #labelKind(label: string): string | null {
    const text = ` ${normalizeWords(label)} `;
    let best: { kind: string; length: number } | null = null;
    for (const [kind, phrases] of Object.entries(this.#rules.labels)) {
      for (const phrase of phrases) {
        const p = normalizeWords(phrase);
        if (text.includes(` ${p} `) && (best === null || p.length > best.length)) {
          best = { kind, length: p.length };
        }
      }
    }
    return best?.kind ?? null;
  }

  /** Masks the text of every unmasked piece as one token each, keeping its outer spaces. */
  #maskAll(segs: readonly Segment[], kind: string): Segment[] {
    return segs.map((s) => {
      if (s.masked) return s;
      const m = /^(\s*)(.*?)(\s*)$/su.exec(s.text);
      const [, lead = "", core = "", trail = ""] = m ?? [];
      if (core === "") return s;
      return { text: `${lead}${this.#token(kind, core)}${trail}`, masked: true };
    });
  }

  /**
   * Rule 3: the label rule (§9.7). A label from the context masks the whole value. Otherwise
   * the text before a colon is a label, as in "DOB: 12/03/1980", and masks what follows.
   */
  #labelRule(segs: Segment[], label: string | undefined): Segment[] {
    if (label !== undefined) {
      const kind = this.#labelKind(label);
      return kind === null ? segs : this.#maskAll(segs, kind);
    }
    let before = "";
    for (const [i, s] of segs.entries()) {
      if (!s.masked) {
        for (let c = s.text.indexOf(":"); c !== -1; c = s.text.indexOf(":", c + 1)) {
          const kind = this.#labelKind(before + s.text.slice(0, c));
          if (kind === null) continue;
          const head = { text: s.text.slice(0, c + 1), masked: false };
          const tail = { text: s.text.slice(c + 1), masked: false };
          return [...segs.slice(0, i), head, ...this.#maskAll([tail, ...segs.slice(i + 1)], kind)];
        }
      }
      before += s.text;
    }
    return segs;
  }
}
