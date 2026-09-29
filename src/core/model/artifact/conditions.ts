// The `conditions` block: named and nested screen checks, in one shared language.
// Follows design section 2 §14. `ref` is written as `{ "ref": "<id>" }` with no `check` field
// in the section 21 full example, though §14.2 lists `check` as always required. This schema
// follows the example (see task report): `check: "ref"` may be omitted.
import { z } from "zod";
import { PathPattern } from "../common.js";
import { SnakeId } from "./shared.js";

/** `element_state.state` values (section 2 §14.4). */
export const ElementState = z.enum(["enabled", "disabled", "checked", "unchecked", "selected"]);

/** How text or a field value must match (section 2 §14.4). */
export const MatchKind = z.enum(["exact", "contains", "wildcard"]);

/** `count.item` values (section 2 §14.4). */
export const ItemKind = z.enum(["row", "list_item", "option"]);

/** `count.op` values (section 2 §14.4). */
export const OpKind = z.enum(["equals", "at_least", "at_most"]);

/**
 * Fields for each leaf check type, keyed by `check` (section 2 §14.3). Defined once; both the
 * nested form (§14.5, no `id` or `description`) and the top-level form (§14.2, with `id` and
 * `description`) build their variants from these.
 */
const leafFields = {
  element_visible: { target: SnakeId },
  element_state: { target: SnakeId, state: ElementState },
  text_visible: {
    text: z.string().min(1),
    match: MatchKind,
    within: SnakeId.optional(),
    case_sensitive: z.boolean().optional(),
  },
  field_value: {
    target: SnakeId,
    value: z.string().min(1),
    match: MatchKind,
    format: z.string().min(1).optional(),
    case_sensitive: z.boolean().optional(),
  },
  count: { within: SnakeId, item: ItemKind, op: OpKind, value: z.number().int().nonnegative() },
  location: { pattern: PathPattern },
} as const;

/** One leaf check, in a nested position: `check`, plus that check's own fields. */
function nestedLeaf<K extends keyof typeof leafFields>(check: K) {
  return z.object({ check: z.literal(check), ...leafFields[check] }).strict();
}

/** The same leaf check, at the top level: also carries `id` and `description`. */
function topLeaf<K extends keyof typeof leafFields>(check: K) {
  return z.object({ ...idDescription, check: z.literal(check), ...leafFields[check] }).strict();
}

/** A leaf check, in a nested position: no `id` or `description` (section 2 §14.2, §14.3). */
type NestedCheckT =
  | { check: "element_visible"; target: string }
  | { check: "element_state"; target: string; state: z.infer<typeof ElementState> }
  | {
      check: "text_visible";
      text: string;
      match: z.infer<typeof MatchKind>;
      within?: string | undefined;
      case_sensitive?: boolean | undefined;
    }
  | {
      check: "field_value";
      target: string;
      value: string;
      match: z.infer<typeof MatchKind>;
      format?: string | undefined;
      case_sensitive?: boolean | undefined;
    }
  | {
      check: "count";
      within: string;
      item: z.infer<typeof ItemKind>;
      op: z.infer<typeof OpKind>;
      value: number;
    }
  | { check: "location"; pattern: string }
  | { check: "all_of"; checks: NestedCheckT[] }
  | { check: "any_of"; checks: NestedCheckT[] }
  | { check: "not"; of: NestedCheckT }
  | { check?: "ref" | undefined; ref: string };

/**
 * A nested check (section 2 §14.5): inside `all_of`, `any_of`, or `not`. Holds no `id` or
 * `description` (§14.2). Recursive, so it needs an explicit type.
 */
export const NestedCheck: z.ZodType<NestedCheckT> = z.lazy(() =>
  z.union([
    nestedLeaf("element_visible"),
    nestedLeaf("element_state"),
    nestedLeaf("text_visible"),
    nestedLeaf("field_value"),
    nestedLeaf("count"),
    nestedLeaf("location"),
    z.object({ check: z.literal("all_of"), checks: z.array(NestedCheck).min(1) }).strict(),
    z.object({ check: z.literal("any_of"), checks: z.array(NestedCheck).min(1) }).strict(),
    z.object({ check: z.literal("not"), of: NestedCheck }).strict(),
    z.object({ check: z.literal("ref").optional(), ref: SnakeId }).strict(),
  ]),
);

const idDescription = { id: SnakeId, description: z.string().min(1) };

/**
 * `conditions[]` (section 2 §14): a top-level, named screen check. Used by preconditions,
 * checkpoints, and outcome detectors.
 */
export const Condition = z.union([
  topLeaf("element_visible"),
  topLeaf("element_state"),
  topLeaf("text_visible"),
  topLeaf("field_value"),
  topLeaf("count"),
  topLeaf("location"),
  z
    .object({ ...idDescription, check: z.literal("all_of"), checks: z.array(NestedCheck).min(1) })
    .strict(),
  z
    .object({ ...idDescription, check: z.literal("any_of"), checks: z.array(NestedCheck).min(1) })
    .strict(),
  z.object({ ...idDescription, check: z.literal("not"), of: NestedCheck }).strict(),
  z.object({ ...idDescription, check: z.literal("ref").optional(), ref: SnakeId }).strict(),
]);

/** One named, top-level condition. */
export type Condition = z.infer<typeof Condition>;
