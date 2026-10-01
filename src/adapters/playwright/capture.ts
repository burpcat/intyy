// Human-input capture, adapter side: the init script text, and the check that turns what a page
// reports into a `HumanInput`. Follows design section 7 §14.1 and §14.2 (what is captured, and
// that raw values cross to the engine in memory only) and section 9 §5.2 (`human_input`).
// Why a check: the page is untrusted. It can call the binding with anything, so each report is
// parsed before it becomes an event. A fake report can at worst open a takeover, the safe side.
import { z } from "zod";
import type { ElementFingerprint, HumanInput } from "../../ports/surface.js";
import { collectElements, installCapture } from "./page-script.js";

/** The name of the function the page calls to report input. */
export const CAPTURE_BINDING = "__intyyHumanInput";

/** The init script: installs the capture in every page and frame (section 7 §14.1). */
export function captureInitScript(secretKey: string): string {
  return `(${installCapture.toString()})(${collectElements.toString()}, ${JSON.stringify(CAPTURE_BINDING)}, ${JSON.stringify(secretKey)});`;
}

const Print = z.object({
  role: z.string(),
  roleGroup: z.enum(["button_like", "text_entry", "choice", "check", "navigation", "container"]),
  clues: z.object({
    name: z.string().optional(),
    label: z.string().optional(),
    text: z.string().optional(),
    path: z.string(),
  }),
  tooltip: z.string().optional(),
  href: z.string().optional(),
  form: z.object({ id: z.string(), submits: z.boolean() }).optional(),
  box: z
    .object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() })
    .nullable(),
  fieldKind: z.enum(["text", "password", "choice", "check"]).optional(),
});

const Base = { at: z.number(), url: z.string() };

/** What the page script reports. A wire shape, not a file format, so it lives with its reader. */
const Payload = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("click"), ...Base, target: Print }),
  z.object({ kind: z.literal("type"), ...Base, target: Print, value: z.string().nullable() }),
  z.object({ kind: z.literal("select"), ...Base, target: Print, option: z.string() }),
  z.object({ kind: z.literal("set_checked"), ...Base, target: Print, checked: z.boolean() }),
  z.object({
    kind: z.literal("press"),
    ...Base,
    key: z.string(),
    target: Print.nullable(),
    submit: Print.nullable(),
  }),
]);

type PrintShape = z.infer<typeof Print>;

/**
 * Makes the port's fingerprint, with the frame and pop-up prefix on the path like the eyes put on
 * an element (section 9 §5.2). It leaves out absent clues, as `exactOptionalPropertyTypes` needs.
 */
function toFingerprint(p: PrintShape, prefix: string): ElementFingerprint {
  const out: ElementFingerprint = {
    role: p.role,
    roleGroup: p.roleGroup,
    clues: { path: `${prefix}${p.clues.path}` },
    box: p.box,
  };
  if (p.clues.name !== undefined) out.clues.name = p.clues.name;
  if (p.clues.label !== undefined) out.clues.label = p.clues.label;
  if (p.clues.text !== undefined) out.clues.text = p.clues.text;
  if (p.tooltip !== undefined) out.tooltip = p.tooltip;
  if (p.href !== undefined) out.href = p.href;
  if (p.form !== undefined) out.form = p.form;
  if (p.fieldKind !== undefined) out.fieldKind = p.fieldKind;
  return out;
}

/**
 * Turns one page report into a `HumanInput`, or `null` when it is malformed. `prefix` is the
 * path start for the frame it came from, like `frame[0] > ` (section 9 §5.2, `path`).
 */
export function toHumanInput(raw: unknown, prefix: string): HumanInput | null {
  const p = Payload.safeParse(raw);
  if (!p.success) return null;
  const d = p.data;
  const base = { at: d.at, url: d.url };
  const fp = (x: PrintShape): ElementFingerprint => toFingerprint(x, prefix);
  switch (d.kind) {
    case "click":
      return { ...base, action: { type: "click", target: fp(d.target) } };
    case "type":
      return { ...base, action: { type: "type", target: fp(d.target), value: d.value } };
    case "select":
      return { ...base, action: { type: "select", target: fp(d.target), option: d.option } };
    case "set_checked":
      return { ...base, action: { type: "set_checked", target: fp(d.target), checked: d.checked } };
    case "press":
      return {
        ...base,
        action: {
          type: "press",
          key: d.key,
          target: d.target === null ? null : fp(d.target),
          submit: d.submit === null ? null : fp(d.submit),
        },
      };
  }
}
