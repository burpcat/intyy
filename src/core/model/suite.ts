// The certify suite (`intyy.suite/1.0`): input classes, the standard fault matrix, stability
// runs, reconciliation drills, and hand-written extra cases. Follows design section 8 §6.1 and
// section 9 §8.7.
import { z } from "zod";
import { SnakeId } from "./artifact/shared.js";
import { ContractValue } from "./common.js";
import { FaultPlacement } from "./faults.js";
import { PackProvenance } from "./pack.js";
import { Approval } from "./store-index.js";

export { Decision, PackProvenance as SuiteProvenance } from "./pack.js";

/** `app/capability@major`: one capability's major version, every tenant (section 8 §6.1). */
export const CapabilityMajor = z
  .string()
  .regex(/^[a-z][a-z0-9_-]*\/[a-z][a-z0-9_]*@\d+$/, "app/capability@major");

/** One input value: a literal, or a pool reference like `@members.valid` (section 8 §6.2). Both
 * shapes are plain strings on the wire; the certify runner tells them apart at run time. */
export const CaseInputValue = ContractValue;

/** One input class: inputs and the expected result (section 8 §6.1). */
export const SuiteClass = z
  .object({ id: SnakeId, inputs: z.record(z.string(), CaseInputValue), expect: z.object({ status: z.string().min(1) }).loose() })
  .strict();

/** An input class. */
export type SuiteClass = z.infer<typeof SuiteClass>;

/** Which class runs the standard fault profiles (section 8 §6.1, §6.3). */
export const Matrix = z
  .object({ class: SnakeId, profiles: z.union([z.literal("standard"), z.array(z.string().min(1))]) })
  .strict();

/** Entropy levels, seeds, and twins for one class (section 8 §6.1, §9.3). */
export const Stability = z
  .object({
    class: SnakeId,
    levels: z.array(z.number().min(0).max(1)).min(1),
    seeds: z.number().int().positive(),
    twins: z.boolean(),
  })
  .strict();

/** How many reconciliation drills to run (section 8 §6.1, §14.2). */
export const Drills = z.object({ count: z.number().int().nonnegative() }).strict();

/** One hand-written case: faults at named steps, and their expected result (section 8 §6.1). */
export const ExtraCase = z
  .object({
    id: SnakeId,
    class: SnakeId,
    faults: z.array(FaultPlacement).min(1),
    expect: z.object({ status: z.string().min(1) }).loose(),
  })
  .strict();

/** An extra case. */
export type ExtraCase = z.infer<typeof ExtraCase>;

/** A setup run, whose result feeds a later class's inputs (section 8 §6.1). */
export const SuiteSetup = z.object({ capability: CapabilityMajor, class: SnakeId }).strict();

/** One certify suite (section 8 §6.1): what "trusted" means for one capability major. */
export const Suite = z
  .object({
    schema: z.literal("intyy.suite/1.0"),
    capability: CapabilityMajor,
    revision: z.number().int().positive(),
    reason: z.string().min(1),
    classes: z.array(SuiteClass).min(1),
    matrix: Matrix,
    stability: Stability,
    drills: Drills,
    extra: z.array(ExtraCase),
    setup: z.array(SuiteSetup),
    provenance: PackProvenance,
    approved: Approval.optional(),
  })
  .strict();

/** A certify suite. */
export type Suite = z.infer<typeof Suite>;

/**
 * Loader checks beyond the schema (section 8 §6.1): every class and extra-case ID is unique, and
 * `matrix.class`, `stability.class`, and each extra case's `class` name a real class. Checking
 * an `extra` case against the capability's real step IDs waits for the certify runner (M06 task
 * 8), since that needs the capability's sealed artifact, not just the suite file.
 */
export function checkSuite(doc: Suite): string[] {
  const problems: string[] = [];
  const classIds = new Set<string>();
  for (const c of doc.classes) {
    if (classIds.has(c.id)) problems.push(`duplicate_class: ${c.id}`);
    classIds.add(c.id);
  }
  const extraIds = new Set<string>();
  for (const e of doc.extra) {
    if (extraIds.has(e.id)) problems.push(`duplicate_extra: ${e.id}`);
    extraIds.add(e.id);
    if (!classIds.has(e.class)) problems.push(`unknown_class: extra ${e.id} names class ${e.class}`);
  }
  if (!classIds.has(doc.matrix.class)) problems.push(`unknown_class: matrix names class ${doc.matrix.class}`);
  if (!classIds.has(doc.stability.class)) {
    problems.push(`unknown_class: stability names class ${doc.stability.class}`);
  }
  return problems;
}
