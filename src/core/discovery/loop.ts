// The discovery loop: settle, observe, ask the LLM, check the call, gate, act, log, then check
// limits. Follows design section 6 §10.1 (one turn), §10.2 (gate feedback to the LLM), §10.3
// (checks on `done`), §10.4 (how a run ends), §6.2 (limits), §8 (observation), §12 (tags), §13
// (fingerprints), section 4 §7.7 (approvals in discovery), and section 9 §5.3 (model call order).
import type { Clock } from "../../ports/clock.js";
import type { Marker } from "../../ports/marker.js";
import type { Masked } from "../../ports/masked.js";
import type { Planner, PlannerReply } from "../../ports/models.js";
import type { RunFolder } from "../../ports/stores.js";
import type { Eyes, LeaseToken, Observation, Png } from "../../ports/surface.js";
import { capture } from "../capture/capture.js";
import type { FullLimits, RunSpec } from "../model/runspec.js";
import type { RunLog } from "../orchestrator/run-log.js";
import type { Gate, GateResult, Proposal } from "../safety/gate/gate.js";
import { masked, maskedTurn, wireBytes } from "../safety/redaction/compose.js";
import { fact, type Redactor } from "../safety/redaction/redactor.js";
import { captureFingerprint } from "./fingerprint.js";
import {
  buildScreen,
  childrenOf,
  historyText,
  maskedName,
  type ScreenView,
} from "./observation.js";
import type { LastResult, PromptModule } from "./prompts/types.js";
import { readOutput } from "./read.js";
import { turnPicture } from "./screenshot.js";
import { settle } from "./settle.js";
import {
  checkCall,
  toolDefinitions,
  type HeldInput,
  type ReadCall,
  type ScreenCall,
} from "./tools.js";

/** The operator's answer to a discovery approval: a risk hint, or null for decline (§7.7). */
export type RiskHint = "irreversible" | "reversible" | "idempotent";

/** What the loop asks the operator before an irreversible action. */
export type ApprovalAsk = {
  turn: number;
  element: string | null;
  /** The control's masked words. */
  label: Masked<string> | null;
  /** The masked screenshot of this turn, if one was saved. */
  screenshot: string | null;
};

/** What the operator answered. `decided` with `hint: null` is a decline. */
export type Answer =
  | { kind: "decided"; staff: string; hint: RiskHint | null }
  | { kind: "end_run"; staff: string }
  | { kind: "timed_out" }
  | { kind: "run_ended" };

/** The human side of discovery. M03 builds it on the mailbox (section 7 §13.4). */
export interface Supervisor {
  /** Asks for one of the four answers (section 4 §7.7). Waits for the operator. */
  approve(ask: ApprovalAsk, signal?: AbortSignal): Promise<Answer>;
  /** Reports the LLM stuck (takeover, reason `stuck`). M03 offers only `end_run`; M07 adds claims. */
  stuck(
    ask: { turn: number; reason: Masked<string>; screenshot: string | null },
    signal?: AbortSignal,
  ): Promise<Answer>;
}

/** How the loop ended (section 6 §10.4). */
export type LoopEnd = {
  status: "success" | "business_outcome" | "failed";
  code: string | null;
  turns: number;
  actions: number;
  blocked: number;
  invalid: number;
  commits: number;
  /** Milliseconds a human took to answer. Not counted against `max_minutes`. */
  humanMs: number;
};

/** Everything one loop needs. */
export type LoopDeps = {
  eyes: Eyes;
  gate: Gate;
  marker: Marker;
  planner: Planner;
  supervisor: Supervisor;
  redactor: Redactor;
  clock: Clock;
  log: RunLog;
  folder: RunFolder;
  prompt: PromptModule;
  spec: RunSpec;
  limits: FullLimits;
  /** The system prompt, built once from the task block. */
  system: Masked<string>;
  inputs: ReadonlyMap<string, HeldInput>;
  runId: string;
  formats: { date: readonly string[]; money: readonly string[] };
  lease: LeaseToken;
  /** Policy `llm.send_screenshots` (section 4 §10.5). */
  sendScreenshots: boolean;
  /** Marks the run `escalated` or `running` in the tenant index while a human is asked. */
  status: (s: "escalated" | "running") => Promise<void>;
  signal?: AbortSignal;
};

/** The words the LLM hears for a block (section 6 §10.2). Never the rule's details. */
function blockedText(rule: string): Masked<string> {
  if (rule.startsWith("allowlist.") || rule === "helper.path")
    return masked`Blocked by policy: that page is not allowed. Find another way.`;
  if (rule === "value.mask_token") return masked`Blocked: you typed a mask token. Use a reference.`;
  if (rule === "risk.read_only_run") return masked`Blocked: this task must not change data.`;
  return masked`Blocked by policy. Find another way.`;
}

/** A five-digit file prefix from a log line number (section 3 §7.4). */
const pad = (seq: number): string => String(seq).padStart(5, "0");

/** The loop's own state across turns. */
class State {
  turn = 0;
  actions = 0;
  blocked = 0;
  invalid = 0;
  invalidInRow = 0;
  commits = 0;
  humanMs = 0;
  failuresInRow = 0;
  last: LastResult = "none";
  feedback: Masked<string> | null = null;
  history: Masked<string>[] = [];
  read = new Set<string>();
  readAfterCommit = new Set<string>();
  repeatKey = "";
  repeats = 0;
}

/** One ended run. */
type End = { status: LoopEnd["status"]; code: string | null };

/** Runs the discovery loop until the run ends (section 6 §10.4). */
export async function runLoop(d: LoopDeps): Promise<LoopEnd> {
  const s = new State();
  const started = d.clock.now().getTime();
  const tools = toolDefinitions(d.spec.kind);
  const end = await turns(d, s, started, tools);
  return {
    ...end,
    turns: s.turn,
    actions: s.actions,
    blocked: s.blocked,
    invalid: s.invalid,
    commits: s.commits,
    humanMs: s.humanMs,
  };
}

/** Turns until one ends the run. */
async function turns(
  d: LoopDeps,
  s: State,
  started: number,
  tools: ReturnType<typeof toolDefinitions>,
): Promise<End> {
  for (;;) {
    if (d.signal?.aborted === true) return { status: "failed", code: "ended_by_operator" };
    if (s.actions >= d.limits.max_steps) return { status: "failed", code: "discovery_limit" };
    const worked = d.clock.now().getTime() - started - s.humanMs;
    if (worked >= d.limits.max_minutes * 60_000)
      return { status: "failed", code: "discovery_limit" };
    s.turn += 1;
    const ended = await oneTurn(d, s, tools);
    if (ended !== null) return ended;
    if (d.log.failed) return { status: "failed", code: "evidence_write_failed" };
  }
}

/** Observes the settled screen and saves what the LLM will see (section 6 §10.1 steps 1 and 2). */
async function observe(
  d: LoopDeps,
  s: State,
): Promise<
  | {
      o: Observation;
      view: ScreenView;
      image: Masked<Png> | null;
      shot: string | null;
      withheld: boolean;
    }
  | End
> {
  const settled = await settle(d.eyes, d.clock, d.signal);
  if (!settled.ok) return { status: "failed", code: "session_lost" };
  d.gate.settled();
  const o = settled.value;
  const view = buildScreen(o, d.redactor);
  const seq = d.log.nextSeq;
  const files: string[] = [];
  let shot: string | null = null;
  let image: Masked<Png> | null = null;
  let marked = false;
  let withheld = !d.sendScreenshots;
  if (d.sendScreenshots) {
    const pic = await turnPicture(d.eyes, d.marker, d.redactor, view, o, d.signal);
    if (pic.png === null) {
      withheld = true;
      await d.log.append({
        event: "warning",
        step: `t${String(s.turn)}`,
        by: "engine",
        data: { code: "screenshot_withheld", detail: pic.withheld },
      });
    } else {
      // Why: section 6 §8.4, the stored screenshot is the marked one, the one the LLM gets.
      shot = `screens/${pad(seq)}_observation.png`;
      const w = await d.folder.writeFile(shot, pic.png, d.signal);
      if (!w.ok) return { status: "failed", code: "evidence_write_failed" };
      files.push(shot);
      image = pic.png;
      marked = pic.marked;
    }
  }
  const snap = await capture(
    d.eyes,
    d.redactor,
    d.folder,
    { seq, name: "observation" },
    { screenshot: false, dom: false, a11y: true },
    d.signal,
  );
  if (!snap.ok) return { status: "failed", code: "evidence_write_failed" };
  files.push(...snap.value.files);
  await d.log.append({
    event: "observation",
    step: `t${String(s.turn)}`,
    by: "engine",
    data: {
      location: view.location,
      title: view.title,
      elements: view.ids.size,
      files: files.map(fact),
      marked,
    },
  });
  return { o, view, image, shot, withheld };
}

/** Asks the planner, with one retry (section 9 §5.3). Writes each call's bytes to `llm/` first. */
async function ask(
  d: LoopDeps,
  s: State,
  message: Masked<string>,
  image: Masked<Png> | null,
  tools: ReturnType<typeof toolDefinitions>,
): Promise<PlannerReply | End> {
  const turn = maskedTurn({
    model: d.spec.model,
    prompt: d.prompt.version,
    system: d.system,
    tools,
    message,
    image,
  });
  for (let attempt = 1; ; attempt++) {
    // Why the attempt number: no log line comes between a failed call and its retry, so both
    // share one `seq`. The retry must not overwrite the first call's stored bytes.
    const name = `${pad(d.log.nextSeq)}${attempt === 1 ? "" : `_${String(attempt)}`}_planner`;
    const record = async (part: "request" | "reply", bytes: Uint8Array): Promise<boolean> => {
      const w = await d.folder.writeFile(`llm/${name}_${part}.json`, wireBytes(bytes), d.signal);
      return w.ok;
    };
    const reply = await d.planner.next(turn, record, d.signal);
    if (reply.ok) {
      s.failuresInRow = 0;
      return reply.value;
    }
    if (reply.failure === "write_failed")
      return { status: "failed", code: "evidence_write_failed" };
    s.failuresInRow += 1;
    // Why no warning line: section 3's warning codes are fixed. The request file in llm/, with no
    // reply beside it, records the failed call.
    // Why: section 6 §10.4, two model failures in a row end the run.
    if (s.failuresInRow >= 2) return { status: "failed", code: "model_unavailable" };
  }
}

/**
 * One history line (section 6 §8.5): `t6 click e3 "Search" → ok  [flow_step]`, or with a typed
 * value, `t5 type e2 {input.member_id} → ok  [flow_step]`.
 */
function historyLine(
  d: LoopDeps,
  s: State,
  tool: string,
  target: string | null,
  what: { name?: Masked<string> | null; typed?: Masked<string> | null },
  result: Masked<string>,
  tag: string | null,
): Masked<string> {
  // Why the redactor on code words: only the redaction folder makes masked text.
  const r = d.redactor;
  const id = target === null ? masked`` : masked` ${r.text(target)}`;
  const shown =
    what.typed !== undefined && what.typed !== null
      ? masked` ${what.typed}`
      : what.name !== undefined && what.name !== null
        ? masked` "${what.name}"`
        : masked``;
  const g = tag === null ? masked`` : masked`  [${r.text(tag)}]`;
  return masked`t${s.turn} ${r.text(tool)}${id}${shown} → ${result}${g}`;
}

/** Plays one turn. Returns how the run ended, or null to go on. */
async function oneTurn(
  d: LoopDeps,
  s: State,
  tools: ReturnType<typeof toolDefinitions>,
): Promise<End | null> {
  const seen = await observe(d, s);
  if ("status" in seen) return seen;
  const { o, view, image, shot, withheld } = seen;
  // Why: section 4 §6.8, a page or frame load the guard blocked is told to the discovery LLM, and
  // the run goes on. Without it, a frame page just looks empty. The rule's details stay out (§10.2).
  const blocked = d.gate.blockedLoads().length;
  if (blocked > 0) {
    const told = masked`Blocked by policy: ${blocked} page or frame load(s) on this screen are not allowed, so parts may look empty. Find another way.`;
    s.feedback = s.feedback === null ? told : masked`${s.feedback} ${told}`;
  }
  const message = d.prompt.turn({
    turn: s.turn,
    limit: d.limits.max_steps,
    last: s.last,
    feedback: s.feedback,
    history: historyText(s.history),
    screen: view,
    withheld,
  });
  const reply = await ask(d, s, message, image, tools);
  if ("status" in reply) return reply;
  s.feedback = null;
  const step = `t${String(s.turn)}`;
  const usage = { input: reply.usage.input_tokens, output: reply.usage.output_tokens };

  const call = reply.call;
  const checked =
    call === null
      ? ({ ok: false, failure: "bad_call", detail: "reply with exactly one tool call." } as const)
      : checkCall(
          {
            spec: d.spec,
            view,
            turn: s.turn,
            inputs: d.inputs,
            runId: d.runId,
            formats: d.formats,
            progress: { commits: s.commits, read: s.read, readAfterCommit: s.readAfterCommit },
          },
          call.name,
          call.input,
        );
  await d.log.append({
    event: "llm_decision",
    step,
    by: "llm",
    data: {
      action: call === null ? null : { type: call.name, input: call.input },
      valid: checked.ok,
      ...(checked.ok ? {} : { problem: checked.detail }),
      model: reply.model,
      tokens: usage,
    },
  });
  if (!checked.ok) {
    s.invalid += 1;
    s.invalidInRow += 1;
    s.last = "bad_call";
    s.feedback = d.redactor.text(checked.detail);
    s.history.push(masked`t${s.turn} bad call`);
    if (s.invalidInRow >= d.limits.max_invalid)
      return stuck(d, s, masked`${s.invalidInRow} bad calls in a row.`, shot);
    return null;
  }
  s.invalidInRow = 0;
  const c = checked.value;
  switch (c.tool) {
    case "done":
      return { status: "success", code: null };
    case "report_outcome":
      return { status: "business_outcome", code: d.spec.expected_outcome?.code ?? null };
    case "stuck":
      return stuck(d, s, d.redactor.text(c.reason), shot);
    case "wait": {
      // Why: a wait on a screen that never changes is a repeat too (section 6 §6.2). A blank page
      // would otherwise take waits until max_minutes.
      const key = JSON.stringify(["wait", view.location, view.list]);
      s.repeats = key === s.repeatKey ? s.repeats + 1 : 1;
      s.repeatKey = key;
      if (s.repeats >= d.limits.max_repeat)
        return stuck(d, s, masked`Waited ${s.repeats} times with no change on screen.`, shot);
      await d.clock.after(c.seconds * 1000, d.signal);
      s.last = "ok";
      s.history.push(masked`t${s.turn} wait ${c.seconds}s`);
      return null;
    }
    case "read":
      return doRead(d, s, view, c);
    default:
      return act(d, s, o, view, c, shot);
  }
}

/** Reports the LLM stuck and waits for the operator (section 6 §6.2: stuck is a question). */
async function stuck(
  d: LoopDeps,
  s: State,
  reason: Masked<string>,
  shot: string | null,
): Promise<End> {
  const step = `t${String(s.turn)}`;
  await d.log.append({
    event: "escalation",
    step,
    by: "engine",
    data: { kind: "takeover", reason: "stuck", state: "open", detail: reason },
  });
  await d.status("escalated");
  const t0 = d.clock.now().getTime();
  const a = await d.supervisor.stuck({ turn: s.turn, reason, screenshot: shot }, d.signal);
  s.humanMs += d.clock.now().getTime() - t0;
  const state =
    a.kind === "timed_out" ? "timed_out" : a.kind === "run_ended" ? "run_ended" : "resolved";
  await d.log.append({
    event: "escalation",
    step,
    by: a.kind === "end_run" || a.kind === "decided" ? "human" : "engine",
    data: {
      kind: "takeover",
      reason: "stuck",
      state,
      decision: a.kind === "end_run" ? "end_run" : null,
      ...("staff" in a ? { staff_id: a.staff } : {}),
    },
  });
  return a.kind === "timed_out"
    ? { status: "failed", code: "escalation_timeout" }
    : { status: "failed", code: "ended_by_operator" };
}

/** Plays `read` (section 6 §9.3): converts, learns the value, and replies with its reference. */
async function doRead(d: LoopDeps, s: State, view: ScreenView, c: ReadCall): Promise<End | null> {
  s.actions += 1;
  const el = view.elements.get(c.element);
  const out = d.spec.outputs.find((x) => x.name === c.output);
  if (el === undefined || out === undefined)
    throw new Error("a checked read names a known element and output");
  const got = readOutput(el, c.source, c.pattern, out.type, c.format);
  const ref = d.redactor.text(`{output.${c.output}}`);
  const step = `t${String(s.turn)}`;
  if (!got.ok) {
    s.last = "failed";
    s.feedback = masked`read failed: ${d.redactor.text(got.detail ?? "no value")}.`;
    s.history.push(historyLine(d, s, "read", c.element, {}, masked`failed`, c.meta.tag));
    return null;
  }
  // Why: section 4 §9.6, an output becomes a known value once read, so it masks as its reference.
  d.redactor.addKnown({
    ref: `output.${c.output}`,
    value: got.value.value,
    label: "pii",
    type: out.type === "money" ? "money" : out.type === "date" ? "date" : "text",
    kind: out.type === "money" ? "money" : "account",
  });
  await d.log.append({
    event: "extract",
    step,
    by: "engine",
    data: { output: c.output, raw: got.value.raw, value: got.value.value },
  });
  s.read.add(c.output);
  if (s.commits > 0) s.readAfterCommit.add(c.output);
  s.last = "ok";
  s.feedback = masked`read ok: ${ref}`;
  s.history.push(historyLine(d, s, "read", c.element, {}, ref, c.meta.tag));
  return null;
}

/** The same action on the same control with no screen change counts as a repeat (§6.2). */
function repeatKey(c: ScreenCall, view: ScreenView): string {
  const el = c.element === null ? null : view.elements.get(c.element);
  return JSON.stringify([c.tool, el?.role, el?.clues.name, c.typed, view.location, view.list]);
}

/** Proposes one screen action to the gate, asks a human when the gate needs one, and acts. */
async function act(
  d: LoopDeps,
  s: State,
  o: Observation,
  view: ScreenView,
  c: ScreenCall,
  shot: string | null,
): Promise<End | null> {
  const key = repeatKey(c, view);
  s.repeats = key === s.repeatKey ? s.repeats + 1 : 1;
  s.repeatKey = key;
  if (s.repeats >= d.limits.max_repeat)
    return stuck(d, s, masked`The same action ran ${s.repeats} times with no change.`, shot);

  const step = `t${String(s.turn)}`;
  const kids = childrenOf(o.elements);
  const el = c.element === null ? undefined : view.elements.get(c.element);
  const name = el === undefined ? null : maskedName(d.redactor, el, kids);
  const typed = c.typed === undefined ? null : d.redactor.text(c.typed);
  const shown = { name, typed };
  const tag = c.meta.tag;

  // Why: section 6 §13.1, the fingerprint comes first; an input is cropped before typing.
  const fp =
    c.element === null || el === undefined
      ? null
      : await captureFingerprint(
          d.eyes,
          d.redactor,
          d.folder,
          o,
          el.ref,
          { seq: d.log.nextSeq, id: c.element, label: view.labels.get(c.element) },
          d.signal,
        );
  if (fp === "write_failed") return { status: "failed", code: "evidence_write_failed" };

  const proposal: Proposal = { actor: "llm", lease: d.lease, action: c.action, step };
  let result = await d.gate.act(proposal, d.signal);
  let hint: RiskHint | null = null;
  if (result.ok && result.value.decision === "needs_approval") {
    const answered = await approval(d, s, c, name, shot);
    if ("status" in answered) return answered;
    if (answered.hint === null) {
      s.last = "declined";
      s.feedback = masked`The operator declined that action.`;
      s.history.push(historyLine(d, s, c.tool, c.element, shown, masked`declined`, tag));
      return null;
    }
    hint = answered.hint;
    result = await d.gate.act({ ...proposal, approval: { by: answered.staff } }, d.signal);
  }
  if (!result.ok) {
    if (result.failure === "secret_unavailable")
      return { status: "failed", code: "secret_unavailable" };
    s.last = "failed";
    s.feedback = masked`That element changed before the action ran. Look again.`;
    s.history.push(historyLine(d, s, c.tool, c.element, shown, masked`failed`, tag));
    return null;
  }
  return afterGate(d, s, c, result.value, { fp, shown, hint, tag, step });
}

/** Handles the gate's answer: a block, or a done action (section 6 §10.2). */
async function afterGate(
  d: LoopDeps,
  s: State,
  c: ScreenCall,
  g: GateResult,
  x: {
    fp: unknown;
    shown: { name: Masked<string> | null; typed: Masked<string> | null };
    hint: RiskHint | null;
    tag: string;
    step: string;
  },
): Promise<End | null> {
  if (g.decision === "blocked") {
    s.blocked += 1;
    s.last = "blocked";
    s.feedback = blockedText(g.rule);
    s.history.push(historyLine(d, s, c.tool, c.element, x.shown, masked`blocked`, x.tag));
    if (s.blocked >= d.limits.max_blocked)
      return stuck(d, s, masked`${s.blocked} actions were blocked.`, null);
    return null;
  }
  s.actions += 1;
  const dispatched = g.act?.dispatched ?? "unknown";
  const ok = dispatched === true;
  if (x.hint === "irreversible" && ok) {
    s.commits += 1;
    s.readAfterCommit = new Set();
  }
  await d.log.append({
    event: "action",
    step: x.step,
    by: "llm",
    data: {
      type: c.tool,
      target: c.element,
      value: c.typed ?? null,
      format: c.format ?? null,
      option: c.option ?? null,
      checked: c.checked ?? null,
      key: c.key ?? null,
      result: ok ? "ok" : "failed",
      dispatched,
      transport: g.act?.transport ?? null,
      tag: x.tag,
      reason: c.meta.reason,
      expected: c.meta.expected,
      corrects: c.meta.corrects ?? null,
      fingerprint: x.fp,
    },
  });
  s.last = ok ? "ok" : "failed";
  if (!ok) s.feedback = masked`The action did not go through. Look at the screen again.`;
  s.history.push(
    historyLine(d, s, c.tool, c.element, x.shown, ok ? masked`ok` : masked`failed`, x.tag),
  );
  return null;
}

/** Asks the operator about one irreversible action (section 4 §7.7, the four answers). */
async function approval(
  d: LoopDeps,
  s: State,
  c: ScreenCall,
  name: Masked<string> | null,
  shot: string | null,
): Promise<{ staff: string; hint: RiskHint | null } | End> {
  const step = `t${String(s.turn)}`;
  await d.log.append({
    event: "escalation",
    step,
    by: "engine",
    data: { kind: "approval", reason: "discovery_irreversible", state: "open", label: name },
  });
  await d.status("escalated");
  const t0 = d.clock.now().getTime();
  const a = await d.supervisor.approve(
    { turn: s.turn, element: c.element, label: name, screenshot: shot },
    d.signal,
  );
  s.humanMs += d.clock.now().getTime() - t0;
  const decided = a.kind === "decided";
  await d.log.append({
    event: "escalation",
    step,
    by: decided ? "human" : "engine",
    data: {
      kind: "approval",
      reason: "discovery_irreversible",
      state: decided ? "resolved" : a.kind === "timed_out" ? "timed_out" : "run_ended",
      decision: decided ? (a.hint === null ? "decline" : `approve_${a.hint}`) : null,
      // Why: section 3 §6.4, the operator's answer is a hint the recorder drafts from.
      risk_hint: decided ? a.hint : null,
      ...(decided ? { staff_id: a.staff } : {}),
    },
  });
  if (a.kind === "timed_out") return { status: "failed", code: "escalation_timeout" };
  if (a.kind !== "decided") return { status: "failed", code: "ended_by_operator" };
  await d.status("running");
  return { staff: a.staff, hint: a.hint };
}
