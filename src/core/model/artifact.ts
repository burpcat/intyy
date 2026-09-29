// The artifact file (`intyy.artifact/1.0`): the ten blocks of section 2, assembled.
// Follows design section 2 §4 (the ten blocks), §8 (`schema`), and §19.9 (candidate mode).
// One schema handles both a candidate and a sealed file (owner decision, 2026-09-29):
// `identity.version`, `recovery.reconciliation`, and `provenance.sealed` may be null, and
// `about` strings may be empty. Section 6 §14.15's blocking review issues name two more gaps a
// fresh candidate can legitimately have: `recovery.commit_point` may be null ("No commit
// point"), and `provenance.actions[].human_tag` and `decided_by` may be null ("Undecided
// tags"). The strict rules of section 2 §19 (version present, sealed present, non-empty
// `about`, exactly-one commit point, every tag decided, and so on) are loader checks, written
// in task 2, not part of this shape.
import { z } from "zod";
import { About, Identity, RunsOn } from "./artifact/identity.js";
import { Contract } from "./artifact/contract.js";
import { Target } from "./artifact/targets.js";
import { Condition } from "./artifact/conditions.js";
import { Step } from "./artifact/steps.js";
import { Recovery } from "./artifact/recovery.js";
import { Provenance } from "./artifact/provenance.js";

export * from "./artifact/identity.js";
export * from "./artifact/contract.js";
export * from "./artifact/targets.js";
export * from "./artifact/conditions.js";
export * from "./artifact/steps.js";
export * from "./artifact/recovery.js";
export * from "./artifact/provenance.js";
export { SnakeId, MajorCapabilityLink } from "./artifact/shared.js";

/**
 * The artifact file. `recovery` is present only when `contract.effect` is `commits`
 * (section 2 §4); the loader checks that pairing.
 */
export const Artifact = z
  .object({
    schema: z.literal("intyy.artifact/1.0"),
    identity: Identity,
    runs_on: RunsOn,
    about: About,
    contract: Contract,
    targets: z.array(Target).min(1),
    conditions: z.array(Condition).min(1),
    steps: z.array(Step).min(1),
    recovery: Recovery.optional(),
    provenance: Provenance,
  })
  .strict();

/** One artifact, candidate or sealed. */
export type Artifact = z.infer<typeof Artifact>;
