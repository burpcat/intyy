// Proves each Zod schema's type equals the port type it backs, so the two never drift apart.
// Design section 9 §5.1: inputs and outputs are Zod types.
import { expectTypeOf, test } from "vitest";
import type { LockFile } from "../../src/core/model/lock.js";
import type { LockInfo } from "../../src/ports/locks.js";

test("the lock file schema matches the lock port", () => {
  expectTypeOf<LockFile>().toEqualTypeOf<LockInfo>();
});
