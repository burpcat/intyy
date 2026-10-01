// The canary markers for a publish or verify: `canary_members` from `intyy.json`, plus every secret
// value bound in the tenant's settings, resolved in memory. Follows the updates file §12 ("Canary
// sources") and design section 4 §14. Values never leave memory and are never printed.
import type { Settings } from "../model/settings.js";
import { settingsBindings } from "../model/settings.js";
import { Secret } from "../../ports/secret.js";
import type { Secrets } from "../../ports/secrets.js";

/** The marker values, and the binding names that had no value (they cannot leak, so only warn). */
export type Markers = { values: string[]; missing: string[] };

/** Resolves the markers. A bound secret with no value is listed in `missing`, by name. */
export async function canaryMarkers(
  canaryMembers: readonly string[],
  settings: Settings,
  secrets: Secrets,
): Promise<Markers> {
  const values = [...canaryMembers];
  const missing: string[] = [];
  for (const b of settingsBindings(settings)) {
    const got = await secrets.resolve({ source: "env", key: b.key });
    // Why Secret.open: a canary must be the raw value. It is compared in memory and dropped.
    if (got.ok) values.push(Secret.open(got.value));
    else missing.push(b.key);
  }
  return { values, missing };
}
