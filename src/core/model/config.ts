// The data root file `intyy.json` (`intyy.config/1.0`).
// Follows design section 9 §6.1, build plan section 10 §10.1, and the updates file §12.
import { z } from "zod";
import { EnvName, TenantId } from "./common.js";

/** The data root marker. `model_keys` names environment variables, never values. */
export const Config = z
  .object({
    schema: z.literal("intyy.config/1.0"),
    library: z.string().min(1),
    state: z.string().min(1),
    publish: z.string().min(1),
    default_tenant: TenantId,
    model_keys: z.object({ claude: EnvName, jev: EnvName }).strict(),
    /** Reserved member numbers the canary scanner looks for. Example: `["100240"]`. */
    canary_members: z.array(z.string().regex(/^\d+$/)),
  })
  .strict();

/** The data root config. */
export type Config = z.infer<typeof Config>;
