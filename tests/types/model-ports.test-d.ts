// Proves a Classifier or Reviewer stub that ignores the CallRecorder fails to compile, so every
// model call keeps the write-before-send order. Design section 9 §5.3.
import { expectTypeOf, test } from "vitest";
import type { Masked } from "../../src/ports/masked.js";
import type {
  CallRecorder,
  Classifier,
  JevTroubleInput,
  Reviewer,
} from "../../src/ports/models.js";

test("the model ports take a CallRecorder as the second argument", () => {
  expectTypeOf<Classifier["trouble"]>().parameter(1).toEqualTypeOf<CallRecorder>();
  expectTypeOf<Classifier["reconcile"]>().parameter(1).toEqualTypeOf<CallRecorder>();
  expectTypeOf<Reviewer["fixStep"]>().parameter(1).toEqualTypeOf<CallRecorder>();
  expectTypeOf<Reviewer["secondOpinion"]>().parameter(1).toEqualTypeOf<CallRecorder>();
});

test("a stub that puts the signal where the recorder goes does not compile", () => {
  const stub: Pick<Classifier, "trouble"> = {
    // @ts-expect-error the second argument must be the CallRecorder, not a signal
    trouble: (input: Masked<JevTroubleInput>, signal?: AbortSignal) =>
      Promise.reject(new Error(`${input.schema} ${signal ? "s" : "n"}`)),
  };
  expectTypeOf(stub).toBeObject();
});

test("a call that passes no recorder does not compile", () => {
  const classifier = null as unknown as Classifier;
  const input = null as unknown as Masked<JevTroubleInput>;
  // @ts-expect-error record is required
  expectTypeOf(classifier.trouble(input)).toBeObject();
});
