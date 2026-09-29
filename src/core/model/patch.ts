// The tenant patch file (`intyy.patch/1.0`): small, bank-specific changes to a few targets or
// conditions in one base artifact. Follows design section 2 §18.2 (fields), §18.3 (what a patch
// may change), and §18.7 (the full example). Merge, drafting, and commands are designed only;
// this file builds the schema and its standalone checks (updates file §5).
import { z } from "zod";
import { TenantId } from "./common.js";
import { Decision, MatchKind, OpKind } from "./artifact.js";
import { MajorCapabilityLink, SnakeId } from "./artifact/shared.js";
import { PathPattern } from "./common.js";
import { RunKind } from "./artifact/provenance.js";
import { RunId } from "./ids.js";
import { Approval } from "./store-index.js";

/**
 * A position or size as a fraction of the window (section 2 §13.2, `region`). Redeclared here,
 * small, because `targets.ts` does not export its own copy.
 */
const RegionPatch = z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }).strict();

/**
 * A target's changed clues (section 2 §18.3): any clue, `null` to remove it. Never `id`.
 * Unlisted clues keep the base's value (section 2 §18.4).
 */
const CluePatch = z
  .object({
    role: z.union([z.string().min(1), z.null()]).optional(),
    name: z.union([z.string().min(1), z.null()]).optional(),
    label: z.union([z.string().min(1), z.null()]).optional(),
    text: z.union([z.string().min(1), z.null()]).optional(),
    region: z.union([RegionPatch, z.null()]).optional(),
    image: z.union([z.string().min(1), z.null()]).optional(),
    path: z.union([z.string().min(1), z.null()]).optional(),
  })
  .strict();

/** One `targets` change (section 2 §18.3): clues, and `within`. Never `id`. */
export const TargetPatch = z
  .object({
    clues: CluePatch.optional(),
    within: z.union([SnakeId, z.null()]).optional(),
  })
  .strict();

/** One target's change. */
export type TargetPatch = z.infer<typeof TargetPatch>;

/**
 * One `conditions` change (section 2 §18.3): a leaf condition's own fields. Never `id` or
 * `check`. A base condition that combines others (`all_of`, `any_of`, `not`) may not be patched
 * at all; a loader check with a base artifact enforces that.
 */
export const ConditionPatch = z
  .object({
    text: z.string().min(1).optional(),
    value: z.string().min(1).optional(),
    match: MatchKind.optional(),
    pattern: PathPattern.optional(),
    op: OpKind.optional(),
  })
  .strict();

/** One condition's change. */
export type ConditionPatch = z.infer<typeof ConditionPatch>;

/** One `provenance.runs` entry (section 2 §18.7): lighter than an artifact's, run ID and kind only. */
export const PatchRun = z.object({ run_id: RunId, kind: RunKind }).strict();

/** One source run. */
export type PatchRun = z.infer<typeof PatchRun>;

/**
 * `provenance` (section 2 §18.2, §18.7): runs, decisions, and who sealed the patch. The §18.7
 * example holds no `derived_from` and no `actions`, unlike an artifact's provenance; this follows
 * the example (docs/decisions.md, M04).
 */
export const PatchProvenance = z
  .object({
    runs: z.array(PatchRun).min(1),
    decisions: z.array(Decision),
    sealed: Approval.nullable(),
  })
  .strict();

/** A patch's provenance block. */
export type PatchProvenance = z.infer<typeof PatchProvenance>;

/** The tenant patch file (section 2 §18.2). */
export const Patch = z
  .object({
    schema: z.literal("intyy.patch/1.0"),
    tenant: TenantId,
    base: MajorCapabilityLink,
    revision: z.number().int().positive(),
    reason: z.string().min(1),
    targets: z.record(SnakeId, TargetPatch).optional(),
    conditions: z.record(SnakeId, ConditionPatch).optional(),
    provenance: PatchProvenance,
  })
  .strict();

/** A tenant patch. */
export type Patch = z.infer<typeof Patch>;
