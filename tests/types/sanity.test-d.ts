// Proves the `types` Vitest project type-checks *.test-d.ts files. Build plan section 10 §5.4.
import { expectTypeOf, test } from "vitest";

test("the types project runs", () => {
  expectTypeOf<"a" | "b">().toExtend<string>();
  expectTypeOf<string>().not.toExtend<"a" | "b">();
});
