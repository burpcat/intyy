// The table classifier: a fake twin of jev. It answers from a table of rows, by step, fault
// style, or input hash. It records each request before it answers. A call no row matches fails
// the test. It can play a timeout, an unavailable model, and bad output.
// Follows design section 5 §10.9 (the CI fake), section 9 §5.3 and §5.9. Never wired into production.
import type { Masked } from "../ports/masked.js";
import type {
  CallFailure,
  CallRecorder,
  Classifier,
  JevReconcileInput,
  JevReconcileOutput,
  JevTroubleInput,
  JevTroubleOutput,
} from "../ports/models.js";
import type { Outcome } from "../ports/outcome.js";
import {
  JevReconcileOutput as ReconcileSchema,
  JevTroubleOutput as TroubleSchema,
} from "../core/model/jev.js";
import { Table, type Row } from "./table.js";

/** The version string the fake reports. Real wiring has no jev adapter, so it never sees this. */
export const FAKE_JEV_VERSION = "jev@fake";

/** The rows for each call kind. A kind with no rows fails every call of that kind. */
export type ClassifierScript = {
  trouble?: readonly Row<JevTroubleOutput>[];
  reconcile?: readonly Row<JevReconcileOutput>[];
};

/** Answers from a table. */
export class TableClassifier implements Classifier {
  /** Every input it was sent, in order. */
  readonly seen: { kind: "trouble" | "reconcile"; input: JevTroubleInput | JevReconcileInput }[] =
    [];
  readonly #trouble: Table<JevTroubleOutput>;
  readonly #reconcile: Table<JevReconcileOutput>;

  /** `styleOf` reports the fault style now on screen, for rows that match by `style`. */
  constructor(
    script: ClassifierScript,
    private readonly styleOf: () => string | undefined = () => undefined,
  ) {
    this.#trouble = new Table(script.trouble ?? [], "jev trouble");
    this.#reconcile = new Table(script.reconcile ?? [], "jev reconcile");
  }

  /** Sorts one piece of trouble from the table. */
  trouble(
    input: Masked<JevTroubleInput>,
    record: CallRecorder,
  ): Promise<Outcome<JevTroubleOutput, CallFailure>> {
    this.seen.push({ kind: "trouble", input });
    return this.#trouble.call(input, input.step.id, this.styleOf(), record, TroubleSchema);
  }

  /** Judges one reconciliation check from the table. */
  reconcile(
    input: Masked<JevReconcileInput>,
    record: CallRecorder,
  ): Promise<Outcome<JevReconcileOutput, CallFailure>> {
    this.seen.push({ kind: "reconcile", input });
    return this.#reconcile.call(
      input,
      input.parent.commit_step.id,
      this.styleOf(),
      record,
      ReconcileSchema,
    );
  }
}
