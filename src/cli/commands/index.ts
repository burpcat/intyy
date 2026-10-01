// Every noun's commands, in the order `intyy --help` lists them.
// Follows design section 9 §7.1 (grammar) and build plan section 10 §5.2 (commands/<noun>.ts).
import type { Register } from "../program.js";
import { registerArtifact } from "./artifact.js";
import { registerCandidate } from "./candidate.js";
import { registerCapability } from "./capability.js";
import { registerCertify } from "./certify.js";
import { registerDiscover } from "./discover.js";
import { registerEvidence } from "./evidence.js";
import { registerFaults } from "./faults.js";
import { registerFixture } from "./fixture.js";
import { registerOperator } from "./operator.js";
import { registerPack } from "./pack.js";
import { registerPolicy } from "./policy.js";
import { registerReconcile } from "./reconcile.js";
import { registerReplay } from "./replay.js";
import { registerRun } from "./run.js";
import { registerSettings } from "./settings.js";
import { registerSpec } from "./spec.js";
import { registerStaff } from "./staff.js";
import { registerSuite } from "./suite.js";
import { registerTags } from "./tags.js";
import { registerTestdata } from "./testdata.js";
import { registerTrust } from "./trust.js";
import { registerJev, registerThresholds } from "./thresholds.js";

/** The real command list. `main.ts` passes it to `run`. */
export const commands: readonly Register[] = [
  registerArtifact,
  registerCandidate,
  registerCapability,
  registerCertify,
  registerDiscover,
  registerEvidence,
  registerFaults,
  registerFixture,
  registerJev,
  registerOperator,
  registerPack,
  registerPolicy,
  registerReconcile,
  registerReplay,
  registerRun,
  registerSettings,
  registerSpec,
  registerStaff,
  registerSuite,
  registerTags,
  registerTestdata,
  registerThresholds,
  registerTrust,
];
