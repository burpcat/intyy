// Proves the `unit` Vitest project runs. Build plan section 10 §5.4.
import { expect, test } from "vitest";

test("the unit project runs", () => {
  expect(1 + 1).toBe(2);
});
