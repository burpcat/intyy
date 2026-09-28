// A scripted supervisor for loop tests: answers approvals and stuck reports from a list.
// The mailbox adapter is the real one (section 9 §10.5). Follows design section 9 §5.9.
import type { Answer, ApprovalAsk, Supervisor } from "../core/discovery/loop.js";
import type { Masked } from "../ports/masked.js";

/** Answers in order. Past the end, every question ends the run. */
export class ScriptedSupervisor implements Supervisor {
  readonly approvals: ApprovalAsk[] = [];
  readonly stucks: { turn: number; reason: Masked<string> }[] = [];
  #next = 0;

  constructor(private readonly answers: readonly Answer[] = []) {}

  approve(ask: ApprovalAsk): Promise<Answer> {
    this.approvals.push(ask);
    return Promise.resolve(this.#take());
  }

  stuck(ask: { turn: number; reason: Masked<string> }): Promise<Answer> {
    this.stucks.push({ turn: ask.turn, reason: ask.reason });
    return Promise.resolve(this.#take());
  }

  #take(): Answer {
    const a = this.answers[this.#next] ?? { kind: "end_run", staff: "op_017" };
    this.#next += 1;
    return a;
  }
}
