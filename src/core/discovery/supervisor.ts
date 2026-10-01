// The discovery supervisor on the operator port: it opens an approval or a stuck request, waits
// for the operator's answer until the deadline, and closes the request. Follows design section 4
// §7.7 (the four answers), section 7 §13.1 (request fields), §13.4 (the operator port in the
// build), and section 9 §5.4 (the core owns the deadline; adapters never time out a human).
import type { Clock } from "../../ports/clock.js";
import type { Masked } from "../../ports/masked.js";
import type { Handle, Intervention as Request, OperatorPort } from "../../ports/operator.js";
import { APPROVAL_DECISIONS, Intervention } from "../model/mailbox.js";
import { fact, type Redactor } from "../safety/redaction/redactor.js";
import type { Answer, ApprovalAsk, RiskHint, Supervisor } from "./loop.js";

/** Every kind of intervention this supervisor may open (docs/decisions.md, M06). */
type RequestKind = Intervention["kind"];

/** Every reason an intervention may carry (docs/decisions.md, M06). */
type RequestReason = Intervention["reason"];

/** Which run the requests belong to, and how long a human has to answer. */
export type SupervisorFacts = {
  runId: string;
  tenant: string;
  capability: string;
  /** Policy `escalation.approval_minutes` (section 4 §4.4). Stuck requests use it too in M03. */
  deadlineMinutes: number;
  /** Minutes a claimed takeover has, from the claim (section 7 §13.3: default 60, range 15 to
   * 240). Out-of-range values are clamped. Omitted means the default. */
  claimedMinutes?: number;
};

/** What the supervisor tells its owner while it waits (section 7 §13.3, §13.4). */
export type SupervisorHooks = {
  /** A claim arrived and moved the deadline to `deadline` (an ISO time). */
  onClaim?: (staff: string, implicit: boolean, deadline: string) => void;
  /** An operator answered a native dialog (section 7 §13.4, `dialogs.jsonl`). The wait resumes
   * once this settles, so the engine's own click on the box lands before the next answer. */
  onDialog?: (staff: string, answer: "accept" | "dismiss") => unknown;
};

/** What a takeover can end with (section 7 §13.2). */
export type TakeoverAnswer =
  | { kind: "ended_run"; staff: string }
  | { kind: "set_outcome"; staff: string; code: string }
  | { kind: "released"; staff: string; note: string | null }
  | { kind: "timed_out" }
  | { kind: "run_ended" };

/** What a wait ends with, when a release cannot end it. */
type Waited =
  | { kind: "decided"; staff: string; decision: string; outcome?: string }
  | { kind: "timed_out" }
  | { kind: "run_ended" };

/** A release (the handback) ended the wait. */
type Released = { kind: "released"; staff: string; note: string | null };

/** Section 7 §13.3: a claimed takeover has 60 minutes, policy range 15 to 240. */
const CLAIMED_DEFAULT_MINUTES = 60;
const CLAIMED_MIN_MINUTES = 15;
const CLAIMED_MAX_MINUTES = 240;

/** The risk hint behind each approval answer (section 3 §6.4, `risk_hint`). */
const HINTS: Record<(typeof APPROVAL_DECISIONS)[number], RiskHint | null> = {
  approve_irreversible: "irreversible",
  approve_reversible: "reversible",
  approve_idempotent: "idempotent",
  decline: null,
};

/** True when `d` is one of the four approval answers. */
const isApproval = (d: string): d is (typeof APPROVAL_DECISIONS)[number] =>
  (APPROVAL_DECISIONS as readonly string[]).includes(d);

/** The supervisor for one discovery run. */
export class OperatorSupervisor implements Supervisor {
  constructor(
    private readonly port: OperatorPort,
    private readonly clock: Clock,
    private readonly redactor: Redactor,
    private readonly facts: SupervisorFacts,
    private readonly hooks: SupervisorHooks = {},
  ) {}

  async approve(ask: ApprovalAsk, signal?: AbortSignal): Promise<Answer> {
    const req = this.#request({
      kind: "approval",
      reason: "discovery_irreversible",
      step: { id: `t${String(ask.turn)}`, intent: null },
      trouble: null,
      approval: {
        words: ask.label,
        risk: "irreversible",
        authorization: "none",
        ...(ask.action === undefined ? {} : { action: ask.action }),
        ...(ask.rule === undefined ? {} : { rule: ask.rule }),
        ...(ask.path === undefined ? {} : { path: ask.path }),
        ...(ask.detail === undefined ? {} : { detail: ask.detail }),
      },
      screenshot: ask.screenshot,
      decisions: [...APPROVAL_DECISIONS],
      on_handback: null,
    });
    const got = await this.#ask(req, signal);
    if (got.kind !== "decided") return got;
    // Why: the CLI checks the decision word; a hand-written file might not. Unknown means decline.
    const hint = isApproval(got.decision) ? HINTS[got.decision] : null;
    return { kind: "decided", staff: got.staff, hint };
  }

  async stuck(
    ask: { turn: number; reason: Masked<string>; screenshot: string | null },
    signal?: AbortSignal,
  ): Promise<Answer> {
    const req = this.#request({
      kind: "takeover",
      reason: "stuck",
      step: { id: `t${String(ask.turn)}`, intent: null },
      trouble: { phase: "discovery", detail: ask.reason },
      approval: null,
      screenshot: ask.screenshot,
      decisions: ["end_run"],
      on_handback: "M03 has no handback. The only answer is end_run; M07 adds claims.",
    });
    const got = await this.#ask(req, signal);
    return got.kind === "decided" ? { kind: "end_run", staff: got.staff } : got;
  }

  /**
   * Asks the supervised-mode start confirmation (section 7 §4 step 6, after the prelude and
   * before the task's own steps; docs/decisions.md, M05): `approved` or `declined`, on the same
   * mailbox and deadline machinery as {@link commitApproval}.
   */
  async startConfirmation(
    signal?: AbortSignal,
  ): Promise<
    | { kind: "approved"; staff: string }
    | { kind: "declined" }
    | { kind: "timed_out" }
    | { kind: "run_ended" }
  > {
    const req = this.#request({
      kind: "start_confirmation",
      reason: "supervised_mode",
      step: { id: "start", intent: null },
      trouble: null,
      approval: null,
      screenshot: null,
      decisions: ["approved", "declined"],
      on_handback: null,
    });
    const got = await this.#ask(req, signal);
    if (got.kind !== "decided") return got;
    return got.decision === "approved"
      ? { kind: "approved", staff: got.staff }
      : { kind: "declined" };
  }

  /**
   * Asks a replay commit approval: `approved` or `declined` (docs/decisions.md, M05). Reuses the
   * same mailbox request and deadline as discovery's `approve` (section 7 §13.1, §13.4), with the
   * two-word decision set section 4 §7.8's "no authorization" pause needs, not the four discovery
   * answers.
   */
  async commitApproval(
    ask: { step: string; intent: string; screenshot: string | null },
    signal?: AbortSignal,
  ): Promise<
    | { kind: "approved"; staff: string }
    | { kind: "declined" }
    | { kind: "timed_out" }
    | { kind: "run_ended" }
  > {
    const req = this.#request({
      kind: "approval",
      reason: "no_authorization",
      step: { id: ask.step, intent: ask.intent },
      trouble: null,
      approval: { words: null, risk: "irreversible", authorization: "none" },
      screenshot: ask.screenshot,
      decisions: ["approved", "declined"],
      on_handback: null,
    });
    const got = await this.#ask(req, signal);
    if (got.kind !== "decided") return got;
    // Why not "unknown decision word": a hand-written decision.json might hold anything else.
    // Not acting is the safe side (section 4 §2.3, docs/decisions.md M03).
    return got.decision === "approved"
      ? { kind: "approved", staff: got.staff }
      : { kind: "declined" };
  }

  /**
   * Opens a rung 4 takeover, with the ladder's full context (section 5 §8.9, section 7 §13.1):
   * the step, the trouble, every rung so far, the commit state, and any handler
   * `operator_note`. An operator claims it, works in the browser, and answers `release` (the
   * handback), `end_run`, or `set_outcome` with one of `outcomes` (section 7 §13.2;
   * docs/decisions.md, M07). A claim moves the deadline (section 7 §13.3).
   */
  async takeover(
    ask: {
      reason: "stuck" | "needs_human_handler" | "unexpected_human_input";
      step: { id: string; intent: string | null };
      trouble: { phase: string; detail: string } | null;
      ladder: readonly unknown[];
      commit: { state: string; notice: string | null };
      operatorNote: string | null;
      screenshot: string | null;
      /** The outcome codes `set_outcome` may name at this step. None: no `set_outcome`. */
      outcomes?: readonly string[];
    },
    signal?: AbortSignal,
  ): Promise<TakeoverAnswer> {
    const outcomes = ask.outcomes ?? [];
    const req = this.#request({
      kind: "takeover",
      reason: ask.reason,
      step: ask.step,
      trouble: ask.trouble,
      approval: null,
      screenshot: ask.screenshot,
      decisions: outcomes.length === 0 ? ["end_run"] : ["end_run", "set_outcome"],
      on_handback: "The bot will check where the screen is, then continue.",
      ladder: ask.ladder,
      commit: ask.commit,
      operatorNote: ask.operatorNote,
      outcomes: [...outcomes],
      // Why "nobody": the lease is free for an operator to claim (section 7 §12.2).
      lease: "nobody",
    });
    const got = await this.#ask(req, signal, true);
    if (got.kind === "released") return got;
    if (got.kind !== "decided") return got;
    if (got.decision === "set_outcome") {
      // Why: a hand-written decision.json might name any code. Not acting is the safe side.
      if (got.outcome !== undefined && outcomes.includes(got.outcome))
        return { kind: "set_outcome", staff: got.staff, code: got.outcome };
    }
    return { kind: "ended_run", staff: got.staff };
  }

  /**
   * Asks whether to retry the commit, after `absent_by_check` (section 7 §13.2, §13.4;
   * docs/decisions.md, M06): `retry` opens a new child run with a new run ID; `no_retry` ends
   * this one.
   */
  async retryDecision(
    ask: { step: string; screenshot: string | null },
    signal?: AbortSignal,
  ): Promise<
    | { kind: "retry"; staff: string }
    | { kind: "no_retry"; staff: string }
    | { kind: "timed_out" }
    | { kind: "run_ended" }
  > {
    const req = this.#request({
      kind: "retry_decision",
      reason: "retry_needs_approval",
      step: { id: ask.step, intent: null },
      trouble: null,
      approval: null,
      screenshot: ask.screenshot,
      decisions: ["retry", "no_retry"],
      on_handback: null,
    });
    const got = await this.#ask(req, signal);
    if (got.kind !== "decided") return got;
    return got.decision === "retry"
      ? { kind: "retry", staff: got.staff }
      : { kind: "no_retry", staff: got.staff };
  }

  /**
   * Asks a human to find the truth when the plain-code reconciliation check cannot
   * (section 7 §13.2, §13.4; docs/decisions.md, M06): no browser needed, the human checks the
   * app directly. Only plain code or a human may answer this; a model never claims a refusal
   * (section 5 §2.3).
   */
  async reconciliationDecision(
    ask: { step: string; waived?: boolean },
    signal?: AbortSignal,
  ): Promise<
    | { kind: "found"; staff: string }
    | { kind: "not_found"; staff: string }
    | { kind: "timed_out" }
    | { kind: "run_ended" }
  > {
    const req = this.#request({
      kind: "reconciliation_decision",
      // Why: section 3 §5.7; a waiver has no check to be unclear.
      reason: ask.waived === true ? "reconciliation_waived" : "reconciliation_unclear",
      step: { id: ask.step, intent: null },
      trouble: null,
      approval: null,
      screenshot: null,
      decisions: ["found", "not_found"],
      on_handback: null,
    });
    const got = await this.#ask(req, signal);
    if (got.kind !== "decided") return got;
    return got.decision === "found"
      ? { kind: "found", staff: got.staff }
      : { kind: "not_found", staff: got.staff };
  }

  /** Builds and checks one request (section 7 §13.1). Every text passes the redactor.
   * `ladder`, `commit`, and `operatorNote` default to "nothing to show" for the discovery and
   * start-confirmation kinds, which carry none; the ladder's rung 4 (docs/decisions.md, M06)
   * passes its own. */
  #request(p: {
    kind: RequestKind;
    reason: RequestReason;
    step: { id: string; intent: string | null };
    trouble: { phase: string; detail: string } | null;
    approval: {
      words: string | null;
      risk: "irreversible";
      authorization: string;
      action?: string;
      rule?: string;
      path?: string | null;
      detail?: string | null;
    } | null;
    screenshot: string | null;
    decisions: string[];
    on_handback: string | null;
    ladder?: readonly unknown[];
    commit?: { state: string; notice: string | null };
    operatorNote?: string | null;
    outcomes?: string[];
    lease?: string;
  }): Masked<Request> {
    const now = this.clock.now();
    const deadline = this.#deadline();
    const req: Intervention = Intervention.parse({
      schema: "intyy.intervention/1.0",
      run_id: this.facts.runId,
      tenant: this.facts.tenant,
      capability: this.facts.capability,
      kind: p.kind,
      reason: p.reason,
      step: p.step,
      trouble: p.trouble,
      ladder: p.ladder ?? [],
      commit: p.commit ?? { state: "none", notice: null },
      operator_note: p.operatorNote ?? null,
      approval: p.approval,
      screenshot: p.screenshot,
      decisions: p.decisions,
      outcomes: p.outcomes ?? [],
      deadline,
      lease: p.lease ?? null,
      on_handback: p.on_handback,
      opened_at: now.toISOString(),
    });
    // Why facts: the digit-run rule would mask a screenshot's `00031_` prefix or an ID.
    return this.redactor.value({
      ...req,
      run_id: fact(req.run_id),
      screenshot: req.screenshot === null ? null : fact(req.screenshot),
      deadline: req.deadline === null ? null : fact(req.deadline),
      opened_at: fact(req.opened_at),
    });
  }

  /** The deadline, as an ISO time (section 7 §13.3). Why `setTime`: core never makes a Date. */
  #deadline(): string {
    const at = this.clock.now();
    at.setTime(at.getTime() + this.facts.deadlineMinutes * 60_000);
    return at.toISOString();
  }

  /**
   * Opens a request and waits for the answer, the deadline, or the run's end. A claim, and a
   * dialog answer, never end the wait. A claim on a takeover moves the deadline. With
   * `handback`, a release ends the wait; otherwise a release is ignored.
   */
  async #ask(req: Masked<Request>, signal?: AbortSignal, handback?: false): Promise<Waited>;
  async #ask(req: Masked<Request>, signal: AbortSignal | undefined, handback: true): Promise<Waited | Released>;
  async #ask(
    req: Masked<Request>,
    signal?: AbortSignal,
    handback = false,
  ): Promise<Waited | Released> {
    // Why the timer starts before open(): open() writes a file a test or an operator can observe
    // on disk before this async function resumes. Starting the deadline first means the clock
    // always has a waiter registered by the time anyone can see the request (no wall-clock race).
    const stop = new AbortController();
    const onRun = (): void => {
      stop.abort();
    };
    signal?.addEventListener("abort", onRun, { once: true });
    // Why check here too: an already-aborted signal (Ctrl-C before this call even started)
    // never fires its "abort" event again, so the listener above alone would miss it and wait
    // out the full deadline.
    if (signal?.aborted === true) stop.abort();
    let timerStop = new AbortController();
    const startTimer = (minutes: number): Promise<"timeout" | "stopped"> => {
      timerStop.abort(); // the old deadline no longer counts
      timerStop = new AbortController();
      return this.clock.after(minutes * 60_000, AbortSignal.any([stop.signal, timerStop.signal])).then(
        () => "timeout" as const,
        () => "stopped" as const,
      );
    };
    let timer = startTimer(this.facts.deadlineMinutes);
    const finish = (): void => {
      stop.abort();
      timerStop.abort();
      signal?.removeEventListener("abort", onRun);
    };
    const opened = await this.port.open(req, signal);
    // Why: with no request on disk, no human can answer. Ending is the safe side.
    if (!opened.ok) {
      finish();
      return { kind: "run_ended" };
    }
    const h: Handle = opened.value;
    for (;;) {
      const first = await Promise.race([this.port.next(h, stop.signal), timer]);
      if (first === "timeout") {
        finish();
        await this.port.close(h, "timed_out");
        return { kind: "timed_out" };
      }
      if (first === "stopped" || !first.ok) {
        finish();
        await this.port.close(h, "run_ended");
        return { kind: "run_ended" };
      }
      const ev = first.value;
      if (ev.kind === "claimed") {
        if (req.kind === "takeover") {
          const minutes = this.#claimedMinutes();
          timer = startTimer(minutes);
          this.hooks.onClaim?.(ev.staff, ev.implicit, this.#deadlineIn(minutes));
        }
        continue;
      }
      if (ev.kind === "dialog") {
        await this.hooks.onDialog?.(ev.staff, ev.answer);
        continue;
      }
      if (ev.kind === "released" && !handback) continue;
      finish();
      await this.port.close(h, "resolved");
      if (ev.kind === "released") return { kind: "released", staff: ev.staff, note: ev.note ?? null };
      return {
        kind: "decided",
        staff: ev.staff,
        decision: ev.decision,
        ...(ev.outcome === undefined ? {} : { outcome: ev.outcome }),
      };
    }
  }

  /** Minutes a claimed takeover has, clamped to the policy range (section 7 §13.3). */
  #claimedMinutes(): number {
    const m = this.facts.claimedMinutes ?? CLAIMED_DEFAULT_MINUTES;
    return Math.min(CLAIMED_MAX_MINUTES, Math.max(CLAIMED_MIN_MINUTES, m));
  }

  /** The time `minutes` from now, as an ISO time. Why `setTime`: core never makes a Date. */
  #deadlineIn(minutes: number): string {
    const at = this.clock.now();
    at.setTime(at.getTime() + minutes * 60_000);
    return at.toISOString();
  }
}
