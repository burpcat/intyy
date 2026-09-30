// The fixture file (`intyy.fixture/1.0`): a saved, masked screen a pack's detectors run against.
// Follows design section 5 §13.1 (format), §13.2 (offline checking).
import { z } from "zod";
import { AppId, TenantId } from "./common.js";
import { RunId } from "./ids.js";
import { SnakeId } from "./artifact/shared.js";

/** `trouble`: an interruption. `normal`: an expected screen (section 5 §13.1). */
export const FixtureKind = z.enum(["trouble", "normal"]);

/** One fixture file kind, by its own file name (section 5 §13.1). `screen.png` is needed only
 * when a used target has an `image` clue; `dom.html` only for a `path` clue. */
export const FixtureFile = z.enum(["a11y.yaml", "dom.html", "screen.png"]);

/** A position or size as a fraction of the viewport (same shape as an artifact target's
 * `region` clue, section 2 §13.2). Optional on a fixture (owner decision, 2026-09-30): a
 * `region` clue then simply leaves the vote, same as any clue the source capture lacks. */
export const FixtureBox = z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }).strict();

/** Which run and turn this fixture was captured from (section 5 §13.1, `source run and seq`). */
export const FixtureSource = z.object({ run_id: RunId, seq: z.number().int().nonnegative() }).strict();

/** One fixture (section 5 §13.1): a folder of masked capture files, plus this file naming them. */
export const Fixture = z
  .object({
    schema: z.literal("intyy.fixture/1.0"),
    id: SnakeId,
    app: AppId,
    tenant: TenantId,
    /** The bank app's own version, like `9.2` (`KVFCU_VERSION`, `CONTRACT.md`). */
    app_version: z.string().min(1),
    /** The bank app's branding variant, like `keystone` or `lakeshore` (`KVFCU_VARIANT`). */
    variant: z.string().min(1),
    /** The URL path and query the screen was captured at, for a `location` check. */
    location: z.string().min(1),
    viewport: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }).strict(),
    /** By element index in the saved `a11y.yaml`, top to bottom, 0-based. Optional (§13.2). */
    boxes: z.record(z.string(), FixtureBox).optional(),
    source: FixtureSource,
    kind: FixtureKind,
    /** A section 5 §13.1 file this fixture's turn never saved (such as a withheld screenshot):
     * left out, never invented (same rule as a `normal` fixture at seal, docs/decisions.md, M04). */
    missing: z.array(FixtureFile).optional(),
  })
  .strict();

/** One fixture's `meta.json`. */
export type Fixture = z.infer<typeof Fixture>;
