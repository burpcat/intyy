// Key text and key paths: `kvfcu/open_share_subaccount@1.0.0+p3` on the command line, and the
// score folder's path on disk. Follows design section 8 §5.1 and section 9 §6.3, §8.4 (key text).
import { fail, ok, type Outcome } from "../../ports/outcome.js";
import { CapabilityKey, ScoreKey } from "../model/score.js";

/** `<patch>` in a key path: `base` for no patch, else `p3` (section 9 §6.3). */
function patchSegment(revision: number | null): string {
  return revision === null ? "base" : `p${String(revision)}`;
}

/** The key's folder under `state/trust/scores/`: `<tenant>/<app>/<capability>@<version>/<app_version>/<patch>`. */
export function keyPath(key: ScoreKey): string {
  return `${key.tenant}/${key.capability}/${key.app_version}/${patchSegment(key.patch_revision)}`;
}

/** The key a folder path names, or `null` when it does not fit the layout. */
export function parseKeyPath(path: string): ScoreKey | null {
  const parts = path.split("/");
  if (parts.length !== 5) return null;
  const [tenant, app, cap, appVersion, patch] = parts;
  const patchRevision = patch === "base" ? null : /^p([1-9]\d*)$/.exec(patch ?? "")?.[1];
  if (patchRevision === undefined) return null;
  const parsed = ScoreKey.safeParse({
    capability: `${app ?? ""}/${cap ?? ""}`,
    tenant,
    app_version: appVersion,
    patch_revision: patchRevision === null ? null : Number(patchRevision),
  });
  return parsed.success ? parsed.data : null;
}

/**
 * Parses key text, `<app>/<capability>@<x.y.z>` with an optional `+p<n>` patch (section 9 §8.4).
 * The tenant comes from `--tenant` and the app version from the tenant's settings, so the caller supplies both.
 */
export function parseKeyText(
  text: string,
  tenant: string,
  appVersion: string,
): Outcome<ScoreKey, "bad_key"> {
  const m = /^(.+?)(?:\+p([1-9]\d*))?$/.exec(text);
  const capability = CapabilityKey.safeParse(m?.[1]);
  if (!capability.success) {
    return fail("bad_key", "write a key like kvfcu/open_share_subaccount@1.0.0, or ...@1.0.0+p3 with a patch");
  }
  const key = ScoreKey.safeParse({
    capability: capability.data,
    tenant,
    app_version: appVersion,
    patch_revision: m?.[2] === undefined ? null : Number(m[2]),
  });
  return key.success ? ok(key.data) : fail("bad_key", key.error.message);
}
