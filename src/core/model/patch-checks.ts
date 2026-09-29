// Loader checks for the tenant patch file (`intyy.patch/1.0`) beyond its schema. Follows design
// section 2 §18.3 (what a patch may change) and section 2 §19.2 (references resolve), narrowed
// by the owner decision (docs/decisions.md, M04): with an optional base artifact, every ID the
// patch touches must exist in the base, and no change may touch a combined condition (`all_of`,
// `any_of`, or `not`). The §18.3 field allow lists and ID formats are already the schema's job
// (`.strict()` objects and `SnakeId` record keys, in `patch.ts`), so nothing repeats them here.
import type { Artifact } from "./artifact.js";
import { D_REF } from "./artifact-checks-shared.js";
import type { Patch } from "./patch.js";

/** One problem `checkPatch` found. A patch has no candidate placeholders, so every one rejects. */
export type PatchProblem = { readonly code: string; readonly path: string; readonly message: string };

/** A patch tries to change a condition that combines others (section 2 §18.3). */
const COMBINED_CONDITION = "combined_condition_patch";

/**
 * Runs the base-dependent checks. With no `base`, this returns no problems: like section 2
 * §19.6's policy checks, "the artifact loader alone cannot run them" applies here too.
 */
export function checkPatch(patch: Patch, base?: Artifact): PatchProblem[] {
  if (base === undefined) return [];
  const problems: PatchProblem[] = [];
  const targetIds = new Set(base.targets.map((t) => t.id));
  const conditionsById = new Map(base.conditions.map((c) => [c.id, c] as const));

  for (const id of Object.keys(patch.targets ?? {})) {
    if (!targetIds.has(id)) {
      problems.push({ code: D_REF, path: `targets.${id}`, message: `${id} is not a target in the base artifact` });
    }
  }
  for (const change of Object.values(patch.targets ?? {})) {
    if (typeof change.within === "string" && !targetIds.has(change.within)) {
      problems.push({ code: D_REF, path: "targets", message: `${change.within} is not a target in the base artifact` });
    }
  }

  for (const id of Object.keys(patch.conditions ?? {})) {
    const baseCondition = conditionsById.get(id);
    if (baseCondition === undefined) {
      problems.push({ code: D_REF, path: `conditions.${id}`, message: `${id} is not a condition in the base artifact` });
      continue;
    }
    if (baseCondition.check === "all_of" || baseCondition.check === "any_of" || baseCondition.check === "not") {
      problems.push({
        code: COMBINED_CONDITION,
        path: `conditions.${id}`,
        message: `${id} combines other conditions; a patch may not change it`,
      });
    }
  }
  return problems;
}
