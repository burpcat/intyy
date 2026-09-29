// The `identity`, `runs_on`, and `about` blocks: the unique key, the surface it runs on, and
// the plain summary. Follows design section 2 §9, §10, §11, and the candidate-mode owner
// decision of 2026-09-29 (`identity.version` may be null in a candidate).
import { z } from "zod";
import { AppId, PathPattern } from "../common.js";
import { CapabilityName } from "../runspec.js";

/** A semver string, like `1.0.0` (section 2 §5.2). */
export const Semver = z.string().regex(/^\d+\.\d+\.\d+$/, "a semver like 1.0.0");

/**
 * A session capability link, `app/capability@major`, or `null` when this artifact holds its
 * own login (section 2 §10, §5.1). Same shape as a run spec's `session` field.
 */
export const SessionLink = z
  .string()
  .regex(/^[a-z][a-z0-9_-]*\/[a-z][a-z0-9_]*@[1-9]\d*$/, "a link like kvfcu/sign_in@1")
  .nullable();

/**
 * `identity` (section 2 §9): app, capability, and version. Together they form the unique key.
 * `version` is `null` in a candidate; a loader check requires it before sealing.
 */
export const Identity = z
  .object({
    app: AppId,
    capability: CapabilityName,
    version: Semver.nullable(),
  })
  .strict();

/** The artifact's identity block. */
export type Identity = z.infer<typeof Identity>;

/** `runs_on.viewport`: window size and pixel density at recording (section 2 §10). */
const Viewport = z
  .object({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    scale: z.number().positive(),
  })
  .strict();

/**
 * An app version wildcard, like `8.*` (section 2 §10, §7.3). Text and version fields let `*`
 * match any character, unlike a path pattern.
 */
const AppVersionPattern = z.string().regex(/^[^\s/]+$/, "an app version wildcard like 8.*");

/**
 * `runs_on` (section 2 §10): surface, app versions, viewport, entry path, every path the run
 * visits, and an optional session link.
 */
export const RunsOn = z
  .object({
    surface: z.enum(["web", "desktop"]),
    app_versions: z.array(AppVersionPattern).min(1),
    viewport: Viewport,
    entry: PathPattern,
    paths: z.array(PathPattern).min(1),
    session: SessionLink,
  })
  .strict();

/** The artifact's `runs_on` block. */
export type RunsOn = z.infer<typeof RunsOn>;

/**
 * `about` (section 2 §11): the plain summary humans and the calling agent read. Strings may be
 * empty in a candidate (owner decision, 2026-09-29); a loader check requires them non-empty
 * before sealing.
 */
export const About = z
  .object({
    title: z.string(),
    summary: z.string(),
    when_to_use: z.string(),
    limits: z.string(),
  })
  .strict();

/** The artifact's `about` block. */
export type About = z.infer<typeof About>;
