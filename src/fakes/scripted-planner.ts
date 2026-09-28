// The scripted planner: a fake twin of the Claude adapter. Each call runs the next scripted step.
// It keeps the model call order: the request bytes are recorded first, and a failed record sends
// nothing. Follows design section 9 §5.3 (model call order) and §5.9 (fake twins).
import type { Masked } from "../ports/masked.js";
import type {
  CallRecorder,
  ModelFailure,
  Planner,
  PlannerReply,
  PlannerTurn,
} from "../ports/models.js";
import { fail, ok, type Outcome } from "../ports/outcome.js";

/** One scripted answer: a tool call, no call, or a model failure. */
export type Scripted = { name: string; input: unknown } | null | { failure: ModelFailure };

/** A step: a fixed answer, or one worked out from the turn it is shown. */
export type Step = Scripted | ((turn: PlannerTurn) => Scripted);

/** The request bytes the fake records: the turn as JSON, the picture as base64. */
export function fakeRequestBytes(turn: PlannerTurn): Uint8Array {
  const image = turn.image === null ? null : Buffer.from(turn.image).toString("base64");
  return new TextEncoder().encode(JSON.stringify({ ...turn, image }));
}

/** Answers from a script. Past its end, it calls `stuck`. */
export class ScriptedPlanner implements Planner {
  /** Every turn it was sent, in order. */
  readonly seen: PlannerTurn[] = [];
  #next = 0;

  constructor(private readonly steps: readonly Step[]) {}

  async next(
    turn: Masked<PlannerTurn>,
    record: CallRecorder,
  ): Promise<Outcome<PlannerReply, ModelFailure | "write_failed">> {
    // Why: section 9 §5.3, the stored copy is the sent copy, so the write comes first.
    if (!(await record("request", fakeRequestBytes(turn)))) return fail("write_failed");
    this.seen.push(turn);
    // Why not `??`: a scripted `null` is a reply with no tool call, not the script's end.
    const step: Step =
      this.#next < this.steps.length
        ? (this.steps[this.#next] ?? null)
        : { name: "stuck", input: { reason: "The script ended." } };
    this.#next += 1;
    const answer = typeof step === "function" ? step(turn) : step;
    if (answer !== null && "failure" in answer) return fail(answer.failure);
    const reply: PlannerReply = {
      call: answer,
      model: "scripted",
      usage: { input_tokens: 0, output_tokens: 0 },
    };
    if (!(await record("reply", new TextEncoder().encode(JSON.stringify(reply)))))
      return fail("write_failed");
    return ok(reply);
  }
}
