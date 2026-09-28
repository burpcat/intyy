// Test helpers for discovery: the global redaction rules, element and screen builders.
// Names and values are made up. Seed member 100240 is the canary and never appears.
import { Redactor, type RedactionRules } from "../../../src/core/safety/redaction/redactor.js";
import type { ElementRef, Observation, SurfaceElement } from "../../../src/ports/surface.js";

/** The approved global label lists (section 4 §9.7, §9.8; updates file §3). */
export const RULES: RedactionRules = {
  detectors: ["ssn", "card", "email", "phone", "money"],
  digitRunMin: 5,
  formats: [],
  labels: {
    name: ["name", "member name", "account holder"],
    member: ["member id", "member number"],
    money: ["balance", "amount"],
  },
  dateFormats: ["YYYY-MM-DD", "MM/DD/YYYY"],
};

/** A fresh redactor that knows member ID `100107` as `{input.member_id}`. */
export function redactor(): Redactor {
  const r = new Redactor(RULES);
  r.addKnown({
    ref: "input.member_id",
    value: "100107",
    label: "pii",
    type: "text",
    kind: "member",
  });
  return r;
}

/** An element ref from a plain name. */
export const ref = (id: string): ElementRef => id as unknown as ElementRef;

/** One element with defaults: a text container at the top left, with no box unless given. */
export function el(id: string, extra: Partial<SurfaceElement> = {}): SurfaceElement {
  return {
    ref: ref(id),
    role: "generic",
    roleGroup: "container",
    clues: { path: id },
    enabled: true,
    box: null,
    ...extra,
  };
}

/** A screen holding `elements`. */
export function screen(elements: SurfaceElement[], extra: Partial<Observation> = {}): Observation {
  return {
    url: "http://127.0.0.1:8080/members/search?q=1",
    title: "Member Search",
    page: "main",
    popups: 0,
    dialog: null,
    viewport: { width: 1280, height: 800 },
    scroll: { x: 0, y: 0 },
    elements,
    ...extra,
  };
}
