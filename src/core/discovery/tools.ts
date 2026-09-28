// The discovery tools, their schemas, and the checks on each call before the gate sees it.
// Follows design section 6 §9 (screen tools, `type` values, `read`, control tools), §10.1 step 4
// (check the call), §10.3 (checks on `done`), and §12 (tags). The core owns the output schemas
// (section 9 §5.3); the adapter only passes them on.
import { z } from "zod";
import type { GateAction, TypeValue } from "../safety/gate/gate.js";
import type { RunSpec } from "../model/runspec.js";
import type { ElementRef } from "../../ports/surface.js";
import { formatDate, formatMoney } from "./formats.js";
import type { ScreenView } from "./observation.js";

/** Tag meanings (section 6 §12.1). */
export const ToolTag = z.enum(["flow_step", "incidental", "correction", "exploration"]);

/** One tag. */
export type ToolTag = z.infer<typeof ToolTag>;

/** An element ID from this turn's list. */
const ElementId = z.string().regex(/^e[1-9]\d*$/, "an element ID like e3");

/** Fields every screen tool carries (section 6 §9.1). */
const meta = {
  reason: z.string().min(1).describe("One or two sentences: why this action."),
  expected: z.string().min(1).describe("What the screen should show after."),
  tag: ToolTag.describe("flow_step, incidental, correction, or exploration."),
  corrects: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("The turn this action undoes. Only with tag correction."),
};

/** Every tool's input schema (section 6 §9.1, §9.4). */
export const TOOL_SCHEMAS = {
  click: z.object({ element: ElementId, ...meta }).strict(),
  type: z
    .object({
      element: ElementId,
      value: z.string().describe("A reference like {input.member_id}, or plain text."),
      format: z.string().min(1).optional().describe("A display format like MM/DD/YYYY."),
      ...meta,
    })
    .strict(),
  select: z.object({ element: ElementId, option: z.string().min(1), ...meta }).strict(),
  set_checked: z.object({ element: ElementId, checked: z.boolean(), ...meta }).strict(),
  press: z
    .object({ key: z.string().min(1).describe("A key like Enter or Tab."), ...meta })
    .strict(),
  navigate: z
    .object({ location: z.string().regex(/^\/(?!\/)/, "a path like /home"), ...meta })
    .strict(),
  scroll: z.object({ direction: z.enum(["up", "down"]), ...meta }).strict(),
  read: z
    .object({
      element: ElementId,
      output: z.string().min(1).describe("An output name from the task."),
      source: z.enum(["text", "value"]),
      pattern: z.string().min(1).optional().describe("A regular expression; group 1 is kept."),
      format: z.string().min(1).optional(),
      ...meta,
    })
    .strict(),
  done: z
    .object({
      summary: z.string().min(1),
      proof: z.array(ElementId).min(1).describe("Element IDs on this screen that prove the goal."),
    })
    .strict(),
  report_outcome: z
    .object({
      summary: z.string().min(1),
      proof: z.array(ElementId).min(1).describe("Element IDs that show the expected outcome."),
    })
    .strict(),
  wait: z.object({ reason: z.string().min(1), seconds: z.number().int().min(1).max(10) }).strict(),
  stuck: z.object({ reason: z.string().min(1) }).strict(),
} as const;

/** A tool name. */
export type ToolName = keyof typeof TOOL_SCHEMAS;

/** What each tool does, in one line for the model. */
const DESCRIPTIONS: Record<ToolName, string> = {
  click: "Click one element.",
  type: "Type a value into one field. Type references, never values you saw.",
  select: "Pick one option in a dropdown, by the option's words.",
  set_checked: "Tick or clear one checkbox or radio button.",
  press: "Press one key.",
  navigate: "Go to a path on this app.",
  scroll: "Scroll the page up or down.",
  read: "Read one listed output from one element. The reply gives its reference.",
  done: "The goal is reached and its proof is on screen. Ends the run.",
  report_outcome: "The expected outcome is showing. Ends the run.",
  wait: "Wait for the page, 1 to 10 seconds. Not a step.",
  stuck: "Ask the operator for help. Use it when unsure.",
};

/** One tool as the model API takes it: name, description, and JSON Schema. */
export type ToolDefinition = { name: ToolName; description: string; input_schema: unknown };

/** The tools one run offers. `done` is not in negative runs; `report_outcome` only is (§9.4). */
export function toolDefinitions(kind: RunSpec["kind"]): ToolDefinition[] {
  const skip: ToolName = kind === "discovery" ? "report_outcome" : "done";
  return (Object.keys(TOOL_SCHEMAS) as ToolName[])
    .filter((n) => n !== skip)
    .map((name) => ({
      name,
      description: DESCRIPTIONS[name],
      input_schema: z.toJSONSchema(TOOL_SCHEMAS[name]),
    }));
}

/** The why, the expectation, and the tag of one screen action. */
export type ActionMeta = { reason: string; expected: string; tag: ToolTag; corrects?: number };

/** A screen action that passed its checks. */
export type ScreenCall = {
  tool: "click" | "type" | "select" | "set_checked" | "press" | "navigate" | "scroll";
  /** The element ID, or null for `press`, `navigate`, and `scroll`. */
  element: string | null;
  action: GateAction;
  /** What the LLM asked to type, as it wrote it. Example: `{input.member_id}`. */
  typed?: string;
  format?: string;
  meta: ActionMeta;
};

/** A `read` that passed its checks. */
export type ReadCall = {
  tool: "read";
  element: string;
  target: ElementRef;
  output: string;
  source: "text" | "value";
  pattern?: string;
  format?: string;
  meta: ActionMeta;
};

/** A call that passed its checks. */
export type Checked =
  | ScreenCall
  | ReadCall
  | { tool: "done" | "report_outcome"; summary: string; proof: string[] }
  | { tool: "wait"; reason: string; seconds: number }
  | { tool: "stuck"; reason: string };

/** One input's raw value, held in memory only (section 4 §9.6). */
export type HeldInput = {
  value: string;
  type: RunSpec["inputs"][number]["type"];
  label: "pii" | "financial" | "none";
};

/** What the run has done so far, for the `done` rules (section 6 §10.3). */
export type Progress = {
  /** Approved irreversible actions so far. */
  commits: number;
  /** Outputs read at any time. */
  read: ReadonlySet<string>;
  /** Outputs read after the last approved irreversible action. */
  readAfterCommit: ReadonlySet<string>;
};

/** Everything a check needs. */
export type CallContext = {
  spec: RunSpec;
  view: ScreenView;
  turn: number;
  inputs: ReadonlyMap<string, HeldInput>;
  runId: string;
  formats: { date: readonly string[]; money: readonly string[] };
  progress: Progress;
};

/** A bad call: the reason the LLM hears next turn (section 6 §10.1 step 4). */
export type BadCall = { ok: false; failure: "bad_call"; detail: string };

/** One check's answer: the value, or a bad call. */
type Checked1<T> = { ok: true; value: T } | BadCall;

const bad = (why: string): BadCall => ({ ok: false, failure: "bad_call", detail: why });
const good = <T>(value: T): Checked1<T> => ({ ok: true, value });

/** A mask token or placeholder the LLM saw on screen (section 4 §9.2). */
const MASK = /\[[a-z]+#\d+\]|\[(?:secret|human_text|pii|financial)\]/;

/** The live ref behind an ID, or a bad call naming the stale ID (section 6 §8.3). */
function refOf(ctx: CallContext, id: string): Checked1<ElementRef> {
  const ref = ctx.view.ids.get(id);
  return ref === undefined
    ? bad(`unknown element ${id}. Use an ID from this turn's list.`)
    : good(ref);
}

/** Checks the tag rules (section 6 §12.1): `corrects` goes with `correction`, and points back. */
function metaOf(
  ctx: CallContext,
  m: { reason: string; expected: string; tag: ToolTag; corrects?: number | undefined },
): Checked1<ActionMeta> {
  if (m.tag === "correction" && m.corrects === undefined)
    return bad("a correction must name the turn it corrects in corrects.");
  if (m.tag !== "correction" && m.corrects !== undefined)
    return bad("corrects goes only with tag correction.");
  if (m.corrects !== undefined && m.corrects >= ctx.turn)
    return bad(`corrects must name an earlier turn than ${String(ctx.turn)}.`);
  const out: ActionMeta = { reason: m.reason, expected: m.expected, tag: m.tag };
  if (m.corrects !== undefined) out.corrects = m.corrects;
  return good(out);
}

/** The formats a type takes (section 6 §7.4). Only dates and money have any. */
function formatsFor(ctx: CallContext, type: HeldInput["type"]): readonly string[] {
  return type === "date" ? ctx.formats.date : type === "money" ? ctx.formats.money : [];
}

/** A value in `format`, or a bad call. */
function formatted(ctx: CallContext, input: HeldInput, format: string): Checked1<string> {
  const list = formatsFor(ctx, input.type);
  if (list.length === 0) return bad(`a ${input.type} value takes no format.`);
  if (!list.includes(format)) return bad(`format ${format} is not one of: ${list.join(", ")}.`);
  const out =
    input.type === "date" ? formatDate(input.value, format) : formatMoney(input.value, format);
  return out === null ? bad(`this value cannot be shown as ${format}.`) : good(out);
}

/** The gate value for what the LLM typed (section 6 §9.2). Secrets and mask tokens: the gate decides. */
function typeValue(
  ctx: CallContext,
  text: string,
  format: string | undefined,
): Checked1<TypeValue> {
  for (const m of text.matchAll(/\{input\.([a-z0-9_]+)\}/g)) {
    const name = m[1] ?? "";
    if (!ctx.inputs.has(name)) return bad(`{input.${name}} is not an input of this task.`);
  }
  const whole = /^\{input\.([a-z0-9_]+)\}$/.exec(text)?.[1];
  const input = whole === undefined ? undefined : ctx.inputs.get(whole);
  if (whole !== undefined && input !== undefined) {
    const shown = format === undefined ? good(input.value) : formatted(ctx, input, format);
    if (!shown.ok) return shown;
    return good({ kind: "input", ref: `input.${whole}`, text: shown.value, label: input.label });
  }
  if (format !== undefined) return bad("only an {input.*} value takes a format.");
  const system = /^\{system\.([a-z0-9_]+)\}$/.exec(text)?.[1];
  if (system !== undefined) {
    if (system !== "run_id") return bad(`{system.${system}} is not a system value.`);
    if (ctx.spec.correlation !== "notes") return bad("this task has no correlation note.");
    return good({ kind: "text", text: ctx.runId });
  }
  return good({ kind: "text", text });
}

/** Checks `read` (section 6 §9.3): a listed output, a valid pattern, a format for dates. */
function checkRead(ctx: CallContext, c: z.infer<typeof TOOL_SCHEMAS.read>): Checked1<Checked> {
  const target = refOf(ctx, c.element);
  if (!target.ok) return target;
  const out = ctx.spec.outputs.find((o) => o.name === c.output);
  if (out === undefined) return bad(`${c.output} is not an output of this task.`);
  if (c.pattern !== undefined) {
    try {
      new RegExp(c.pattern);
    } catch {
      return bad("pattern is not a valid regular expression.");
    }
  }
  if (out.type === "date" && c.format === undefined)
    return bad("reading a date needs a format, like MM/DD/YYYY.");
  if (c.format !== undefined && !formatsFor(ctx, out.type).includes(c.format))
    return bad(`format ${c.format} does not fit a ${out.type} output.`);
  const m = metaOf(ctx, c);
  if (!m.ok) return m;
  const r: ReadCall = {
    tool: "read",
    element: c.element,
    target: target.value,
    output: c.output,
    source: c.source,
    meta: m.value,
  };
  if (c.pattern !== undefined) r.pattern = c.pattern;
  if (c.format !== undefined) r.format = c.format;
  return good(r);
}

/** Checks `done` and `report_outcome` (section 6 §10.3). */
function checkEnd(
  ctx: CallContext,
  tool: "done" | "report_outcome",
  c: { summary: string; proof: string[] },
): Checked1<Checked> {
  const stale = c.proof.find((id) => !ctx.view.ids.has(id));
  if (stale !== undefined) return bad(`proof ${stale} is not on this screen.`);
  if (tool === "done") {
    const p = ctx.progress;
    const outputs = ctx.spec.outputs.map((o) => o.name);
    if (ctx.spec.expected_effect === "commits") {
      if (p.commits !== 1) return bad("done rejected: the one approved change has not happened.");
      const unread = outputs.filter((o) => !p.readAfterCommit.has(o));
      if (unread.length > 0)
        return bad(`done rejected: read ${unread.join(", ")} after the change first.`);
    } else {
      const unread = outputs.filter((o) => !p.read.has(o));
      if (unread.length > 0) return bad(`done rejected: read ${unread.join(", ")} first.`);
    }
  }
  return good({ tool, summary: c.summary, proof: c.proof });
}

/** Parses a call with one schema. A bad call names the first field that does not fit. */
function parsed<T>(schema: z.ZodType<T>, name: string, input: unknown): Checked1<T> {
  const r = schema.safeParse(input);
  if (r.success) return good(r.data);
  const first = r.error.issues[0];
  const where = first === undefined || first.path.length === 0 ? "" : ` ${first.path.join(".")}`;
  return bad(`${name}${where}: ${first?.message ?? "does not fit its schema"}.`);
}

/** Builds a checked screen action, with its element and tag facts. */
function screen(
  ctx: CallContext,
  tool: ScreenCall["tool"],
  c: { element?: string } & Parameters<typeof metaOf>[1],
  action: (target: ElementRef | null) => Checked1<GateAction>,
  extra: { typed?: string; format?: string } = {},
): Checked1<Checked> {
  const m = metaOf(ctx, c);
  if (!m.ok) return m;
  let target: ElementRef | null = null;
  if (c.element !== undefined) {
    const t = refOf(ctx, c.element);
    if (!t.ok) return t;
    target = t.value;
  }
  const a = action(target);
  if (!a.ok) return a;
  return good({ tool, element: c.element ?? null, action: a.value, meta: m.value, ...extra });
}

/** The target of a tool whose schema requires an element. */
const need = (t: ElementRef | null): ElementRef => {
  if (t === null) throw new Error("the schema requires an element");
  return t;
};

/**
 * Checks one tool call (section 6 §10.1 step 4): the schema, the element, the value rules, the
 * output name, and the `done` rules. A bad call returns the reason the LLM hears next turn.
 */
export function checkCall(ctx: CallContext, name: string, input: unknown): Checked1<Checked> {
  if (!toolDefinitions(ctx.spec.kind).some((t) => t.name === name))
    return bad(`there is no tool named ${name}.`);
  const T = TOOL_SCHEMAS;
  switch (name as ToolName) {
    case "click": {
      const c = parsed(T.click, name, input);
      if (!c.ok) return c;
      return screen(ctx, "click", c.value, (t) => good({ type: "click", target: need(t) }));
    }
    case "type": {
      const c = parsed(T.type, name, input);
      if (!c.ok) return c;
      const v = typeValue(ctx, c.value.value, c.value.format);
      if (!v.ok) return v;
      const extra = {
        typed: c.value.value,
        ...(c.value.format === undefined ? {} : { format: c.value.format }),
      };
      return screen(
        ctx,
        "type",
        c.value,
        (t) => good({ type: "type", target: need(t), value: v.value }),
        extra,
      );
    }
    case "select": {
      const c = parsed(T.select, name, input);
      if (!c.ok) return c;
      if (MASK.test(c.value.option))
        return bad("pick an option by its words; a mask token is not a value.");
      const option = c.value.option;
      return screen(ctx, "select", c.value, (t) =>
        good({ type: "select", target: need(t), option }),
      );
    }
    case "set_checked": {
      const c = parsed(T.set_checked, name, input);
      if (!c.ok) return c;
      const checked = c.value.checked;
      return screen(ctx, "set_checked", c.value, (t) =>
        good({ type: "set_checked", target: need(t), checked }),
      );
    }
    case "press": {
      const c = parsed(T.press, name, input);
      if (!c.ok) return c;
      const key = c.value.key;
      return screen(ctx, "press", c.value, () => good({ type: "press", key, target: null }));
    }
    case "navigate": {
      const c = parsed(T.navigate, name, input);
      if (!c.ok) return c;
      const to = c.value.location;
      return screen(ctx, "navigate", c.value, () => good({ type: "navigate", to }));
    }
    case "scroll": {
      const c = parsed(T.scroll, name, input);
      if (!c.ok) return c;
      const direction = c.value.direction;
      return screen(ctx, "scroll", c.value, () => good({ type: "scroll", direction }));
    }
    case "read": {
      const c = parsed(T.read, name, input);
      return c.ok ? checkRead(ctx, c.value) : c;
    }
    case "done":
    case "report_outcome": {
      const c = parsed(T.done, name, input);
      return c.ok ? checkEnd(ctx, name as "done" | "report_outcome", c.value) : c;
    }
    case "wait": {
      const c = parsed(T.wait, name, input);
      return c.ok ? good({ tool: "wait", reason: c.value.reason, seconds: c.value.seconds }) : c;
    }
    case "stuck": {
      const c = parsed(T.stuck, name, input);
      return c.ok ? good({ tool: "stuck", reason: c.value.reason }) : c;
    }
  }
}
