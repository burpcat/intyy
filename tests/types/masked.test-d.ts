// Proves a raw string does not fit where Masked is required. Design section 9 §5.1 and §16.
import { expectTypeOf, test } from "vitest";
import type { Masked } from "../../src/ports/masked.js";

test("a raw string does not fit where Masked is required", () => {
  expectTypeOf<string>().not.toExtend<Masked<string>>();
  expectTypeOf<Masked<string>>().toExtend<string>();

  const logText: (text: Masked<string>) => void = () => undefined;
  // @ts-expect-error a raw string is not Masked
  logText("raw member text");
});
