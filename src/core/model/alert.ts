// An alert file (`intyy.alert/1.0`): trouble the drift reader found, for a person to read.
// Follows design section 8 §13.1 (alert format), §12.4 (early warnings), §13.2 (patterns), §13.3 (change points).
import { z } from "zod";
import { RunId } from "./ids.js";
import { TenantId } from "./common.js";

/** An alert ID: `alert_` plus the run ID shape (section 9 §5.7). */
export const AlertId = z.string().regex(/^alert_\d{4}-\d{2}-\d{2}_[0-9a-hjkmnp-tv-z]{10}$/);

/**
 * What the alert is about. The first six are the early warnings of section 8 §12.4 (`clue_drift`
 * waits for patch drafting, so nothing writes it yet). `one_tenant` and `outage` are the §13.2
 * patterns. `change_point` ties a drop to an engine, jev, or handler set change (§13.3).
 * `live_write_failed` is the failed score write of §5.6.
 */
export const AlertPattern = z.enum([
  "margin_drop",
  "clue_drift",
  "detector_drift",
  "app_health",
  "timeout_pressure",
  "commit_uncertain",
  "contradiction",
  "one_tenant",
  "outage",
  "change_point",
  "live_write_failed",
]);

/** An alert pattern. */
export type AlertPattern = z.infer<typeof AlertPattern>;

/** One alert (section 8 §13.1). */
export const Alert = z
  .object({
    schema: z.literal("intyy.alert/1.0"),
    id: AlertId,
    tenant: TenantId,
    /** When the drift reader raised it. */
    at: z.iso.datetime(),
    /** Key text of each key involved, like `kvfcu/open_share_subaccount@1.0.0`. */
    keys: z.array(z.string().min(1)).min(1),
    pattern: AlertPattern,
    /** What the reader saw, in one plain sentence. Holds no input values. */
    detail: z.string().min(1),
    /** Same finding, same fingerprint: the reader raises each finding once (never twice for the same runs). */
    fingerprint: z.string().min(1),
    evidence_runs: z.array(RunId),
    suggested_fix: z.string().min(1),
    state: z.enum(["open", "acted", "dismissed"]),
    /** Who closed it, when, and with what. `null` while open. `note` holds the staff's text. */
    closed: z
      .object({ by: z.string().min(1), at: z.iso.datetime(), note: z.string().min(1) })
      .strict()
      .nullable(),
  })
  .strict();

/** One alert. */
export type Alert = z.infer<typeof Alert>;
