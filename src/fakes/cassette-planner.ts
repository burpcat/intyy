// The cassette planner: replays a saved discovery run's replies turn by turn, with no model.
// A turn whose message differs from the saved one stops the run loudly: the app or intyy changed.
// Follows design section 9 §16 ("Planner cassette") and §5.3 (the model call order still holds).
import { sha256Hex } from "../core/model/canonical.js";
import type { Cassette } from "../core/model/cassette.js";
import type { Masked } from "../ports/masked.js";
import type {
  CallRecorder,
  ModelFailure,
  Planner,
  PlannerReply,
  PlannerTurn,
} from "../ports/models.js";
import { fail, ok, type Outcome } from "../ports/outcome.js";
import { fakeRequestBytes } from "./scripted-planner.js";

/**
 * A message as the cassette compares it: every digit run is `#`. Why: the app shows real times,
 * like the last login, that change on every run (CONTRACT §7). Words, roles, and structure still
 * must match exactly.
 */
export const shape = (message: string): string => message.replace(/\d+/g, "#");

/** The first line where two texts differ, as a short report. */
function firstDiff(want: string, got: string): string {
  const a = want.split("\n");
  const b = got.split("\n");
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (shape(a[i] ?? "") !== shape(b[i] ?? "") || (a[i] === undefined) !== (b[i] === undefined))
      return `line ${String(i + 1)}:\n  saved: ${a[i] ?? "(none)"}\n  now:   ${b[i] ?? "(none)"}`;
  }
  return "(no line differs)";
}

/** Replays a cassette. It throws when a turn does not match: a cassette mismatch is a bug. */
export class CassettePlanner implements Planner {
  #next = 0;

  constructor(private readonly cassette: Cassette) {}

  /** How many turns it replayed. */
  get played(): number {
    return this.#next;
  }

  async next(
    turn: Masked<PlannerTurn>,
    record: CallRecorder,
  ): Promise<Outcome<PlannerReply, ModelFailure | "write_failed">> {
    const n = this.#next + 1;
    const saved = this.cassette.turns[this.#next];
    if (saved === undefined)
      throw new Error(
        `cassette ${this.cassette.run_id}: the run asked for turn ${String(n)}, past its end`,
      );
    if (`sha256:${sha256Hex(turn.system)}` !== this.cassette.system)
      throw new Error(`cassette ${this.cassette.run_id}: the system prompt changed`);
    if (shape(turn.message) !== shape(saved.message))
      throw new Error(
        `cassette ${this.cassette.run_id}: turn ${String(n)} saw a changed observation, ${firstDiff(saved.message, turn.message)}`,
      );
    if (!(await record("request", fakeRequestBytes(turn)))) return fail("write_failed");
    this.#next += 1;
    if (!(await record("reply", new TextEncoder().encode(JSON.stringify(saved.reply)))))
      return fail("write_failed");
    return ok(saved.reply);
  }
}
