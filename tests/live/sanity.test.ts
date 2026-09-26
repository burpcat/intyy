// Proves the `live` Vitest project runs. It does not touch the bank app. Build plan section 10 §5.4.
import { expect, test } from "vitest";

test("the live project runs", () => {
  expect(true).toBe(true);
});
