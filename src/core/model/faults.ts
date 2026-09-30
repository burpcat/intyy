// The fault profile set (`intyy.faults/1.0`): which faults an app's harness can inject, where to
// place them, and how each must end. Follows design section 8 §6.3 and section 9 §8.7.
import { z } from "zod";
import { AppId } from "./common.js";
import { SnakeId } from "./artifact/shared.js";
import { Approval } from "./store-index.js";

/**
 * A harness fault kind (CONTRACT §6.2). A second, independent copy of `ports/harness.ts`'s
 * `NamedFaultKind`: `src/core/` may not import `ports/harness.ts` (only `core/certify/` may;
 * build plan section 10 §5.3).
 */
export const FaultKind = z.enum([
  "session_expire",
  "known_popup",
  "unknown_popup",
  "supervisor_required",
  "server_error",
  "maintenance",
  "drop_after_confirm",
]);

/** A harness fault kind. */
export type FaultKind = z.infer<typeof FaultKind>;

/** Where in the recipe a fault lands (section 8 §6.3). */
export const Anchor = z.union([
  z.literal("@commit_point"),
  z.literal("@each_request_step"),
  z.string().regex(/^@step:[a-z][a-z0-9_]*$/, "@step:<id>"),
]);

/** A fault's anchor. */
export type Anchor = z.infer<typeof Anchor>;

/** Which of the step's requests a fault targets. Only `first` in 1.0 (section 8 §6.3). */
export const FaultWhich = z.literal("first");

/**
 * One fault placement: a kind and where it lands (section 8 §6.3). Shared by a fault profile and
 * a suite's hand-written `extra` case (section 8 §6.1).
 */
export const FaultPlacement = z.object({ kind: FaultKind, at: Anchor, which: FaultWhich.optional() }).strict();

/** One fault placement. */
export type FaultPlacement = z.infer<typeof FaultPlacement>;

/**
 * One expected ending, by helper window (section 8 §6.3). `fails:<code>` names a hard-failure
 * code the run ends with.
 */
export const ExpectRule = z.union([
  z.literal("recovers"),
  z.literal("recovers_or_escalates"),
  z.literal("reconciles_found"),
  z.literal("reconciles_absent"),
  z.string().regex(/^fails:[a-z][a-z0-9_]*$/, "fails:<code>"),
]);

/** An expected ending. */
export type ExpectRule = z.infer<typeof ExpectRule>;

/**
 * One fault profile (section 8 §6.3's "standard kvfcu set" table, written as data). `expect_commit`
 * is the ending when the placement lands on the commit step; `expect_window` is the ending for
 * every other step. The table marks `expect_window` "—" only for `@commit_point`, which never
 * lands anywhere else.
 */
export const FaultProfile = z
  .object({
    id: SnakeId,
    kind: FaultKind,
    at: Anchor,
    expect_commit: ExpectRule,
    expect_window: ExpectRule.optional(),
  })
  .strict()
  .refine(
    (p) => (p.at === "@commit_point" ? p.expect_window === undefined : p.expect_window !== undefined),
    { message: "expect_window: set unless `at` is @commit_point, which never lands elsewhere" },
  );

/** One fault profile. */
export type FaultProfile = z.infer<typeof FaultProfile>;

/**
 * The fault profile set for one app (section 8 §6.3). The two judge tables of section 8 §8.4 and
 * §8.5 (explained endings, jev truth) are optional in 1.0 (docs/decisions.md, M06) and are not
 * modeled here: their own design sections are outside this milestone's reading.
 */
export const Faults = z
  .object({
    schema: z.literal("intyy.faults/1.0"),
    app: AppId,
    revision: z.number().int().positive(),
    profiles: z.array(FaultProfile),
    approved: Approval.optional(),
  })
  .strict();

/** A fault profile set. */
export type Faults = z.infer<typeof Faults>;

/** Loader check beyond the schema: every profile ID is unique (section 8 §6.3). */
export function checkFaults(doc: Faults): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const p of doc.profiles) {
    if (seen.has(p.id)) problems.push(`duplicate_profile: ${p.id}`);
    seen.add(p.id);
  }
  return problems;
}
