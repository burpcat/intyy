// The handler draft file (`intyy.handler_draft/1.0`): a proposed pack handler, before review.
// Follows design section 5 §12.2. `handler` is the real pack handler schema (M06 defines it,
// docs/decisions.md, M04): the draft's own `fixtures.no_fire` starts empty, which the schema
// allows (section 5 §13.3's "at least one" is a fixture-suite check, not a shape rule).
import { z } from "zod";
import { AppId, TenantId } from "./common.js";
import { RunId } from "./ids.js";
import { Condition } from "./artifact/conditions.js";
import { Handler } from "./pack.js";
import { SnakeId } from "./artifact/shared.js";
import { Target } from "./artifact/targets.js";

/** Who drafted this handler (section 5 §12.2). */
export const DraftSource = z
  .object({
    kind: z.enum(["recorder", "takeover", "reviewer"]),
    run_id: RunId,
    seq: z.array(z.number().int().nonnegative()).min(1),
    tenant: TenantId,
    app_version: z.string().min(1),
  })
  .strict();

/** One draft's source. */
export type DraftSource = z.infer<typeof DraftSource>;

/** One action's drafted risk, beside the rules' class (section 5 §12.2, §12.4). */
export const RiskHint = z
  .object({
    subject: z.string().min(1),
    class: z.enum(["idempotent", "reversible", "irreversible"]),
    /** `rules`: the risk classifier's class. `gate`: the gate's `observed` class for a human
     * action (section 5 §12.4). */
    source: z.enum(["rules", "gate"]),
  })
  .strict();

/** One risk hint. */
export type RiskHint = z.infer<typeof RiskHint>;

/**
 * `intyy.handler_draft/1.0` (section 5 §12.2): a proposed handler, its drafted detector and
 * response, and the trouble screen as a `fire` fixture. `fixtures.no_fire` starts empty; a
 * reviewer adds at least one at review (section 5 §12.5).
 */
export const HandlerDraft = z
  .object({
    schema: z.literal("intyy.handler_draft/1.0"),
    id: SnakeId,
    app: AppId,
    source: DraftSource,
    suggested_scope: z.literal("tenant"),
    targets: z.array(Target),
    conditions: z.array(Condition),
    /** The proposed handler, in pack format (section 5 §12.2). */
    handler: Handler,
    risk_hints: z.array(RiskHint),
    fixtures: z.object({ fire: SnakeId, no_fire: z.array(SnakeId) }).strict(),
  })
  .strict();

/** One handler draft. */
export type HandlerDraft = z.infer<typeof HandlerDraft>;
