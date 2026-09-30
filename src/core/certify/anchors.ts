// Anchor expansion: `@commit_point`, `@step:<id>`, and `@each_request_step` become an exact
// route key and counter, through the route map. Follows design section 8 §6.3, §6.4; the M06
// owner decision: "`certify case` with an `@each_request_step` profile and no `--at` is
// refused, and the request steps are listed."
import { fail, ok, type Outcome } from "../../ports/outcome.js";
import type { Anchor } from "../model/faults.js";
import { requestSteps, type RouteMap, type RouteMapEntry } from "./route-map.js";

/** Why an anchor did not resolve to a route. */
export type AnchorFailure =
  /** `@each_request_step` with no `--at`: `detail` lists the request steps. */
  | "needs_at"
  /** `@commit_point`, but the artifact names none. */
  | "no_commit_point"
  /** The named step sent no request in the baseline (a fill step, for example). */
  | "no_request";

/**
 * Resolves one anchor to a route map entry. `at` is the caller's `--at` override (an explicit
 * `@step:<id>`), used only when `anchor` is `@each_request_step`; anything else ignores it.
 */
export function resolveAnchor(
  anchor: Anchor,
  routeMap: RouteMap,
  commitStepId: string | null,
  at?: string,
): Outcome<RouteMapEntry, AnchorFailure> {
  if (anchor === "@commit_point") {
    if (commitStepId === null) return fail("no_commit_point");
    const found = routeMap.get(commitStepId);
    return found === undefined ? fail("no_request") : ok(found);
  }
  if (anchor === "@each_request_step") {
    if (at === undefined) return fail("needs_at");
    const stepId = at.replace(/^@step:/, "");
    const found = routeMap.get(stepId);
    return found === undefined ? fail("no_request") : ok(found);
  }
  // `@step:<id>`, from a suite `extra` case's own fault placement.
  const stepId = anchor.replace(/^@step:/, "");
  const found = routeMap.get(stepId);
  return found === undefined ? fail("no_request") : ok(found);
}

/** The request steps to list in a `needs_at` refusal (section 8 §6.4's job: "Result: step to
 * route key and counter"). */
export function requestStepsFor(routeMap: RouteMap): string[] {
  return requestSteps(routeMap);
}
