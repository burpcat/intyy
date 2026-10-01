// The table reviewer: a fake twin of the Claude reviewer. It answers from a table of rows, by
// step, fault style, or input hash. It records each request before it answers. A call no row
// matches fails the test. It can play a give-up, a timeout, and bad output.
// Follows design section 5 §10.9 ("The reviewer fake works the same way"), section 9 §5.3 and §5.9.
import type { Masked } from "../ports/masked.js";
import type {
  CallFailure,
  CallRecorder,
  JevReconcileInput,
  JevReconcileOutput,
  Reviewer,
  ReviewerInput,
  ReviewerOutput,
} from "../ports/models.js";
import type { Outcome } from "../ports/outcome.js";
import { JevReconcileOutput as ReconcileSchema } from "../core/model/jev.js";
import { ReviewerOutput as FixSchema } from "../core/model/reviewer.js";
import { Table, type Row } from "./table.js";

/** The rows for each call kind. A kind with no rows fails every call of that kind. */
export type ReviewerScript = {
  fixStep?: readonly Row<ReviewerOutput>[];
  secondOpinion?: readonly Row<JevReconcileOutput>[];
};

/** Answers from a table. */
export class TableReviewer implements Reviewer {
  /** Every input it was sent, in order. */
  readonly seen: { kind: "fixStep" | "secondOpinion"; input: ReviewerInput | JevReconcileInput }[] =
    [];
  readonly #fix: Table<ReviewerOutput>;
  readonly #second: Table<JevReconcileOutput>;

  /** `styleOf` reports the fault style now on screen, for rows that match by `style`. */
  constructor(
    script: ReviewerScript,
    private readonly styleOf: () => string | undefined = () => undefined,
  ) {
    this.#fix = new Table(script.fixStep ?? [], "reviewer fixStep");
    this.#second = new Table(script.secondOpinion ?? [], "reviewer secondOpinion");
  }

  /** Proposes one action from the table. */
  fixStep(
    input: Masked<ReviewerInput>,
    record: CallRecorder,
  ): Promise<Outcome<ReviewerOutput, CallFailure>> {
    this.seen.push({ kind: "fixStep", input });
    return this.#fix.call(input, input.step.id, this.styleOf(), record, FixSchema);
  }

  /** Gives a second opinion from the table. */
  secondOpinion(
    input: Masked<JevReconcileInput>,
    record: CallRecorder,
  ): Promise<Outcome<JevReconcileOutput, CallFailure>> {
    this.seen.push({ kind: "secondOpinion", input });
    return this.#second.call(
      input,
      input.parent.commit_step.id,
      this.styleOf(),
      record,
      ReconcileSchema,
    );
  }
}
