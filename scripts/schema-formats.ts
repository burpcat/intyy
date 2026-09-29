// Every file format's Zod schema, by its `schemas/` file name. Split out of `schemas.ts` so
// `tests/unit/model/schemas-registry.test.ts` can import the same map and catch a schema no one
// registered here. Follows build plan section 10 §5.2.
import { z } from "zod";
import { Artifact } from "../src/core/model/artifact.js";
import { Cassette } from "../src/core/model/cassette.js";
import { Config } from "../src/core/model/config.js";
import { LockFile } from "../src/core/model/lock.js";
import { ClosedFile, DecisionFile, Intervention } from "../src/core/model/mailbox.js";
import { Patch } from "../src/core/model/patch.js";
import { Policy } from "../src/core/model/policy.js";
import { RunSpec } from "../src/core/model/runspec.js";
import { Settings } from "../src/core/model/settings.js";
import { StaffFile } from "../src/core/model/staff.js";
import { IndexLine } from "../src/core/model/store-index.js";

/** Every file format, by its schema name (its `schema` literal, with `/` written as `-`). */
export const formats: Record<string, z.ZodType> = {
  "intyy.artifact-1.0": Artifact,
  "intyy.patch-1.0": Patch,
  "intyy.config-1.0": Config,
  "intyy.staff-1.0": StaffFile,
  "intyy.policy-1.0": Policy,
  "intyy.settings-1.0": Settings,
  "intyy.index-1.0": IndexLine,
  "intyy.lock-1.0": LockFile,
  "intyy.runspec-1.0": RunSpec,
  "intyy.intervention-1.0": Intervention,
  "intyy.decision-1.0": DecisionFile,
  "intyy.closed-1.0": ClosedFile,
  "intyy.cassette-1.0": Cassette,
};
