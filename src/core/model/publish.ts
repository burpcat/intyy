// The publish manifest (`intyy.publish/1.0`): what `evidence publish` copied, by whom, and when.
// Follows design section 9 §6.6 ("what, by whom, when, and source hashes") and the updates file §12.
import { z } from "zod";
import { Sha256Hash } from "./canonical.js";
import { TenantId } from "./common.js";

/**
 * One published thing. A `key` item is a trust snapshot: its id is the key path under
 * `state/trust/scores/` (`<tenant>/<app>/<capability>@<version>/<app_version>/<patch>`), published
 * to `trust/scores/<id>/`. `run` and `batch` items name their tenant (a run ID alone does not say which
 * folder holds it). An `artifact` item's id is `<app>/<capability>@<version>` and its `hash` is the
 * seal hash the artifact index records.
 */
export const PublishItem = z
  .object({
    kind: z.enum(["run", "batch", "artifact", "key"]),
    id: z.string().min(1),
    tenant: TenantId.optional(),
    hash: Sha256Hash.optional(),
  })
  .strict();

/** One published item. */
export type PublishItem = z.infer<typeof PublishItem>;

/**
 * `evidence/manifest.json`. `source_hashes` maps each copied file's path under `evidence/` to the
 * SHA-256 of its bytes. Each publish adds to the set, so `by` and `at` name the latest publish.
 */
export const PublishManifest = z
  .object({
    schema: z.literal("intyy.publish/1.0"),
    items: z.array(PublishItem),
    by: z.string().min(1),
    at: z.iso.datetime(),
    source_hashes: z.record(z.string().min(1), Sha256Hash),
  })
  .strict();

/** The publish manifest. */
export type PublishManifest = z.infer<typeof PublishManifest>;
