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

/** Which run the requests belong to, and how long a human has to answer. */
export type SupervisorFacts = {
  runId: string;
  tenant: string;
  capability: string;
  /** Policy `escalation.approval_minutes` (section 4 §4.4). Stuck requests use it too in M03. */
  deadlineMinutes: number;
};

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
  ) {}

  async approve(ask: ApprovalAsk, signal?: AbortSignal): Promise<Answer> {
    const req = this.#request({
      kind: "approval",
      reason: "discovery_irreversible",
      step: { id: `t${String(ask.turn)}`, intent: null },
      trouble: null,
      approval: { words: ask.label, risk: "irreversible", authorization: "none" },
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
    return got.decision === "approved" ? { kind: "approved", staff: got.staff } : { kind: "declined" };
  }

  /** Builds and checks one request (section 7 §13.1). Every text passes the redactor. */
  #request(p: {
    kind: "approval" | "takeover";
    reason: "discovery_irreversible" | "stuck" | "no_authorization";
    step: { id: string; intent: string | null };
    trouble: { phase: string; detail: string } | null;
    approval: { words: string | null; risk: "irreversible"; authorization: string } | null;
    screenshot: string | null;
    decisions: string[];
    on_handback: string | null;
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
      ladder: [],
      commit: { state: "none" },
      operator_note: null,
      approval: p.approval,
      screenshot: p.screenshot,
      decisions: p.decisions,
      outcomes: [],
      deadline,
      lease: null,
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

  /** Opens a request and waits for the answer, the deadline, or the run's end. */
  async #ask(
    req: Masked<Request>,
    signal?: AbortSignal,
  ): Promise<
    | { kind: "decided"; staff: string; decision: string }
    | { kind: "timed_out" }
    | { kind: "run_ended" }
  > {
    // Why the timer starts before open(): open() writes a file a test or an operator can observe
    // on disk before this async function resumes. Starting the deadline first means the clock
    // always has a waiter registered by the time anyone can see the request (no wall-clock race).
    const stop = new AbortController();
    const onRun = (): void => {
      stop.abort();
    };
    signal?.addEventListener("abort", onRun, { once: true });
    const timer = this.clock.after(this.facts.deadlineMinutes * 60_000, stop.signal).then(
      () => "timeout" as const,
      () => "stopped" as const,
    );
    const opened = await this.port.open(req, signal);
    // Why: with no request on disk, no human can answer. Ending is the safe side.
    if (!opened.ok) {
      stop.abort();
      signal?.removeEventListener("abort", onRun);
      return { kind: "run_ended" };
    }
    const h: Handle = opened.value;
    const answer = this.port.next(h, stop.signal);
    const first = await Promise.race([answer, timer]);
    stop.abort();
    signal?.removeEventListener("abort", onRun);
    if (first === "timeout") {
      await this.port.close(h, "timed_out");
      return { kind: "timed_out" };
    }
    if (first === "stopped" || !first.ok || first.value.kind !== "decided") {
      await this.port.close(h, "run_ended");
      return { kind: "run_ended" };
    }
    await this.port.close(h, "resolved");
    return { kind: "decided", staff: first.value.staff, decision: first.value.decision };
  }
}
