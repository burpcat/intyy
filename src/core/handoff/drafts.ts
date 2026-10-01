// Draft handlers from takeovers: reads a run's log, finds each takeover a human handed back, and
// drafts one proposed pack handler from the trouble screen and the human's masked actions.
// Follows design section 5 §12 (learned handlers, §12.4 class rules), section 7 §16.5 (which
// takeovers draft) and section 9 §6.2, §8.5 (`library/drafts/handlers/`, `pack draft`).
//
// Simplification (ponytail: the same ceiling as `recorder/drafts.ts`): the detector is the
// screen's first plain heading, dialog, or alert name, plus the first acted control. Section 5
// §12.3's "text the normal screen lacks" needs every sealed normal fixture for the location, which
// this call does not have. A human edits the draft before it is used (section 5 §12.3).
import { z } from "zod";
import type { EvidenceStore, DraftStore } from "../../ports/stores.js";
import type { Clues, Target } from "../model/artifact/targets.js";
import { HandlerDraft, type RiskHint } from "../model/handler-draft.js";
import type { Handler, HandlerAction } from "../model/pack.js";
import { ConditionRegistry, elementVisibleCheck, stabilize, textVisibleCheck } from "../recorder/conditions.js";
import { pickId, ROLE_SUFFIX, slugify, stripMaskTokens } from "../recorder/targets.js";
import { fromA11ySnapshot } from "../targets/a11y-snapshot.js";

/** A human control's fingerprint, as `capture.ts` logged it (section 7 §14.2). Lenient: a log
 * line may carry more than this reads. */
const HumanFingerprint = z
  .object({
    role: z.string(),
    name: z.string().nullable(),
    label: z.string().nullable(),
    text: z.string().nullable(),
    region: z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }).nullable(),
    path: z.string(),
  })
  .loose();

/** One human `action` line's `data` (`HumanCapture.#data`). */
const HumanData = z
  .object({
    type: z.enum(["click", "type", "select", "set_checked", "press", "navigate"]),
    value: z.string().nullable(),
    option: z.string().nullable(),
    checked: z.boolean().nullable(),
    key: z.string().nullable(),
    fingerprint: HumanFingerprint.nullable(),
  })
  .loose();

/** The parts of any log line this reads. `data` is checked per event. */
const Line = z
  .object({ seq: z.number().int(), event: z.string(), by: z.string(), step: z.string().nullable(), data: z.unknown() })
  .loose();

const Risk = z.enum(["idempotent", "reversible", "irreversible"]);
type Risk = z.infer<typeof Risk>;

/** One human action, with the class the gate gave it. */
type Acted = { seq: number; data: z.infer<typeof HumanData>; risk: Risk };

/** The trouble screen's saved files, from a `ladder` line's `files` (section 3 §7.4). */
type Trouble = { a11y: string; screen: string | null };

/** One takeover found in a log. */
type Found = {
  step: string;
  reason: string;
  openSeq: number;
  decision: string | null;
  trouble: Trouble | null;
  actions: Acted[];
};

/** Why a takeover made no draft. */
export type SkipReason =
  | "needs_human_handler"
  | "not_unknown_state"
  | "no_decision_to_hand_back"
  | "ended_run"
  | "set_outcome"
  | "no_actions"
  | "no_trouble_screen"
  | "no_detector";

/** A takeover that made no draft, and why. */
export type Skipped = { step: string; seq: number; reason: SkipReason };

/** Reads the takeovers out of a run's log lines, in order. A line that does not fit is left out. */
function findTakeovers(lines: readonly unknown[]): Found[] {
  const found: Found[] = [];
  let trouble: Trouble | null = null;
  let open: Found | null = null;
  let lastRisk: Risk | null = null;
  for (const raw of lines) {
    const line = Line.safeParse(raw);
    if (!line.success) continue;
    const { seq, event, by, step, data } = line.data;
    if (typeof data !== "object" || data === null) continue;
    const d = data as Record<string, unknown>;
    if (event === "ladder" && open === null && Array.isArray(d.files)) {
      const files = d.files.filter((f): f is string => typeof f === "string");
      const a11y = files.find((f) => f.startsWith("a11y/"));
      if (a11y !== undefined) trouble = { a11y, screen: files.find((f) => f.endsWith(".png")) ?? null };
    } else if (event === "gate" && d.actor === "human") {
      // Why: `observeHuman` and the dialog answer log the gate line first, then the action line.
      const risk = Risk.safeParse(d.risk);
      lastRisk = risk.success ? risk.data : null;
    } else if (event === "escalation" && d.kind === "takeover") {
      if (d.state === "open" && typeof d.reason === "string") {
        open = { step: step ?? "", reason: d.reason, openSeq: seq, decision: null, trouble, actions: [] };
        trouble = null;
      } else if (open !== null && (d.state === "resolved" || d.state === "timed_out" || d.state === "run_ended")) {
        open.decision = typeof d.decision === "string" ? d.decision : null;
        found.push(open);
        open = null;
      }
    } else if (event === "action" && by === "human" && open !== null) {
      const human = HumanData.safeParse(data);
      // Why `irreversible` when no gate line came first: section 5 §12.4, "unsure starts as
      // irreversible", so the draft cannot be recoverable on a guess.
      if (human.success) open.actions.push({ seq, data: human.data, risk: lastRisk ?? "irreversible" });
      lastRisk = null;
    }
  }
  return found;
}

/** One acted control's cleaned clues: mask tokens out, and a name only a button-like control
 * logs (section 4 §9.10). `null` for an action with no control. */
function cluesOf(a: Acted): Clues | null {
  const fp = a.data.fingerprint;
  if (fp === null) return null;
  const clues: Clues = { role: fp.role, path: fp.path };
  const name = fp.name === null ? null : stripMaskTokens(fp.name);
  const label = fp.label === null ? null : stripMaskTokens(fp.label);
  const text = fp.text === null ? null : stripMaskTokens(fp.text);
  if (name !== null) clues.name = name;
  if (label !== null) clues.label = label;
  if (text !== null) clues.text = text;
  if (fp.region !== null) clues.region = fp.region;
  return clues;
}

/** One target per distinct control (role and path), named like the recorder names them. */
function buildTargets(actions: readonly Acted[]): { targets: Target[]; idOf: Map<Acted, string> } {
  const targets: Target[] = [];
  const idOf = new Map<Acted, string>();
  const byKey = new Map<string, string>();
  const used = new Set<string>();
  for (const a of actions) {
    const clues = cluesOf(a);
    if (clues === null) continue;
    const key = `${clues.role ?? ""}\u0000${clues.path ?? ""}`;
    const seen = byKey.get(key);
    if (seen !== undefined) {
      idOf.set(a, seen);
      continue;
    }
    const words = slugify(clues.name ?? clues.label ?? clues.text ?? "");
    const suffix = ROLE_SUFFIX[clues.role ?? ""] ?? (clues.role ?? "control");
    const id = pickId(words === "" ? suffix : `${words}_${suffix}`, used);
    used.add(id);
    byKey.set(key, id);
    idOf.set(a, id);
    targets.push({ id, description: `The ${clues.role ?? "control"}${clues.name === undefined ? "" : ` "${clues.name}"`}.`, clues });
  }
  return { targets, idOf };
}

/** One human action as a pack response action, or `null` when it has no legal form (section 5
 * §6.4): no target, no value, a key outside the pack's key shape, or `navigate`. The risk is the
 * gate's class (section 5 §12.4: "Risk flags start as the rules' class"). */
function toAction(a: Acted, targetId: string | null): HandlerAction | null {
  if (a.risk === "irreversible") return null;
  const risk = a.risk;
  const d = a.data;
  switch (d.type) {
    case "click":
      return targetId === null ? null : { type: "click", target: targetId, risk };
    case "select": {
      const value = d.option ?? "";
      return targetId === null || value === "" ? null : { type: "select", target: targetId, value, risk };
    }
    case "set_checked":
      return targetId === null || d.checked === null ? null : { type: "set_checked", target: targetId, checked: d.checked, risk };
    case "press":
      return d.key !== null && /^[A-Z][A-Za-z0-9]*$/.test(d.key) ? { type: "press", key: d.key, risk } : null;
    case "type":
    case "navigate":
      return null;
  }
}

/** True when the human typed anything section 5 §12.4 keeps out of a pack: `[human_text]`,
 * `[secret]`, or a known input's reference. */
function typedSensitive(a: Acted): boolean {
  const v = a.data.value ?? "";
  return a.data.type === "type" && (v === "[human_text]" || v === "[secret]" || /^\{input\.[a-z0-9_]+\}$/.test(v));
}

/** The first plain heading, dialog, or alert name on the trouble screen, or `undefined`. "Plain"
 * means masking and stabilizing change nothing (section 5 §12.3: drop anything with a reference,
 * token, or mask). */
function landmark(a11y: string): string | undefined {
  const view = fromA11ySnapshot(a11y, "");
  for (const e of view.elements) {
    if (!["heading", "dialog", "alertdialog", "alert"].includes(e.role)) continue;
    const text = (e.name ?? e.text ?? "").trim();
    if (text !== "" && stabilize(text) === text && !/[{}[\]]/.test(text)) return text;
  }
  return undefined;
}

/** What {@link buildTakeoverDrafts} needs besides the log. */
export type TakeoverDraftContext = {
  runId: string;
  app: string;
  tenant: string;
  appVersion: string;
  /** The saved `a11y/` files the log names, by path. A takeover whose screen is missing here
   * makes no draft. */
  a11y: ReadonlyMap<string, string>;
};

/** One drafted handler, and the trouble files to copy beside it (the `fire` fixture). */
export type TakeoverDraft = { draft: HandlerDraft; trouble: Trouble };

/** What {@link buildTakeoverDrafts} returns. */
export type TakeoverDrafts = { drafts: TakeoverDraft[]; skipped: Skipped[] };

/** The trouble screen's saved paths a log names, so the caller can read them before drafting. */
export function troublePaths(lines: readonly unknown[]): string[] {
  return findTakeovers(lines).flatMap((t) => (t.trouble === null ? [] : [t.trouble.a11y]));
}

/**
 * Drafts one handler per takeover that qualifies (section 5 §12.1, §12.4; section 7 §16.5). A
 * takeover qualifies when it opened for an unknown state (`stuck`), a human handed it back, and
 * the human acted. A `needs_human` handler's takeover, one that ended in `set_outcome`, and one
 * that ended the run make none: the state is known, the outcome belongs to the artifact, or the
 * human gave up. Pure: the same log always gives the same drafts.
 */
export function buildTakeoverDrafts(lines: readonly unknown[], ctx: TakeoverDraftContext): TakeoverDrafts {
  const drafts: TakeoverDraft[] = [];
  const skipped: Skipped[] = [];
  for (const t of findTakeovers(lines)) {
    const skip = (reason: SkipReason): void => void skipped.push({ step: t.step, seq: t.openSeq, reason });
    if (t.reason === "needs_human_handler") skip("needs_human_handler");
    else if (t.reason !== "stuck") skip("not_unknown_state");
    else if (t.decision === "end_run") skip("ended_run");
    else if (t.decision === "set_outcome") skip("set_outcome");
    else if (t.decision !== "handed_back") skip("no_decision_to_hand_back");
    else if (t.actions.length === 0) skip("no_actions");
    else {
      const screen = t.trouble === null ? undefined : ctx.a11y.get(t.trouble.a11y);
      if (t.trouble === null || screen === undefined) skip("no_trouble_screen");
      else {
        const draft = draftOne(t, t.trouble, screen, ctx);
        if (draft === null) skip("no_detector");
        else drafts.push({ draft, trouble: t.trouble });
      }
    }
  }
  return { drafts, skipped };
}

/** One takeover's draft, or `null` when the screen gives no detector at all (section 5 §12.3,
 * "a screen made only of member data cannot get a detector"). */
function draftOne(t: Found, trouble: Trouble, a11y: string, ctx: TakeoverDraftContext): HandlerDraft | null {
  const id = `${t.step === "" ? "trouble" : t.step}_t${String(t.openSeq)}`;
  const { targets, idOf } = buildTargets(t.actions);
  const firstTarget = t.actions.map((a) => idOf.get(a)).find((x): x is string => x !== undefined);
  const text = landmark(a11y);
  const checks = [
    ...(text === undefined ? [] : [textVisibleCheck(text)]),
    ...(firstTarget === undefined ? [] : [elementVisibleCheck(firstTarget)]),
  ];
  const first = checks[0];
  if (first === undefined) return null;
  const registry = new ConditionRegistry();
  const detector = registry.intern(
    checks.length === 1 ? first : { check: "all_of", checks },
    `${id}_detector`,
    `The ${id} trouble screen is showing.`,
  );
  const mapped = t.actions.map((a) => toAction(a, idOf.get(a) ?? null));
  const actions = mapped.filter((m): m is HandlerAction => m !== null);
  // Why this order of rules: section 5 §12.4. Any typed text, any irreversible class, or an
  // action with no legal form needs a human. A pack response holds at most 5 actions.
  const recoverable = !t.actions.some(typedSensitive) && actions.length === t.actions.length && actions.length <= 5;
  const description = `Drafted from a takeover at step ${t.step} of ${ctx.runId}. A reviewer must edit this before it is used.`;
  const fixtures = { fire: [`${id}_fire`], no_fire: [] };
  const handler: Handler = recoverable
    ? {
        id,
        description,
        class: "recoverable",
        detector,
        response: actions,
        limits: { per_step: 1, per_run: 1 },
        on_exhausted: { class: "needs_human", operator_note: `${description} It kept recurring.` },
        fixtures,
      }
    : {
        id,
        description,
        class: "needs_human",
        detector,
        operator_note: `A person handled this at step ${t.step}.${text === undefined ? "" : ` The screen showed "${text}".`} Review it.`,
        fixtures,
      };
  const risk_hints: RiskHint[] = t.actions.map((a) => ({
    subject: `${ctx.runId}#${String(a.seq)}`,
    class: a.risk,
    source: "gate",
  }));
  return HandlerDraft.parse({
    schema: "intyy.handler_draft/1.0",
    id,
    app: ctx.app,
    source: {
      kind: "takeover",
      run_id: ctx.runId,
      seq: [t.openSeq, ...t.actions.map((a) => a.seq)],
      tenant: ctx.tenant,
      app_version: ctx.appVersion,
    },
    suggested_scope: "tenant",
    targets,
    conditions: [...registry.list()],
    handler,
    risk_hints,
    fixtures: { fire: `${id}_fire`, no_fire: [] },
  });
}

/** What {@link draftTakeovers} needs: the run's evidence, and the draft store. */
export type DraftTakeoverDeps = { evidence: EvidenceStore; drafts: DraftStore<HandlerDraft> };

/** What {@link draftTakeovers} did. `existing` lists drafts it did not replace; `failed`, drafts the
 * store could not write. */
export type DraftTakeoverResult = { written: string[]; existing: string[]; failed: string[]; skipped: Skipped[] };

/**
 * Drafts handlers from one finished run's takeovers and writes them (section 7 §16.5). The
 * trouble screen's saved a11y snapshot and screenshot go beside the draft as the `fire` fixture's
 * files; both were masked when the run saved them. A draft that already exists is kept.
 */
export async function draftTakeovers(
  deps: DraftTakeoverDeps,
  run: { tenant: string; runId: string; app: string; appVersion: string },
  signal?: AbortSignal,
): Promise<DraftTakeoverResult> {
  const out: DraftTakeoverResult = { written: [], existing: [], failed: [], skipped: [] };
  const events = await deps.evidence.events(run.tenant, run.runId, signal);
  const folder = await deps.evidence.openRun(run.tenant, run.runId, signal);
  if (!events.ok || !folder.ok) return out;
  const a11y = new Map<string, string>();
  for (const path of troublePaths(events.value)) {
    const got = await folder.value.readFile(path, signal);
    if (got.ok) a11y.set(path, new TextDecoder().decode(got.value));
  }
  const built = buildTakeoverDrafts(events.value, { ...run, a11y });
  out.skipped = built.skipped;
  for (const { draft, trouble } of built.drafts) {
    const files: Record<string, Uint8Array | string> = { [`${draft.fixtures.fire}/a11y.yaml`]: a11y.get(trouble.a11y) ?? "" };
    if (trouble.screen !== null) {
      const png = await folder.value.readFile(trouble.screen, signal);
      if (png.ok) files[`${draft.fixtures.fire}/screen.png`] = png.value;
    }
    const put = await deps.drafts.put(run.app, draft.id, draft, files, signal);
    if (put.ok) out.written.push(draft.id);
    else if (put.failure === "conflict") out.existing.push(draft.id);
    else out.failed.push(draft.id);
  }
  return out;
}
