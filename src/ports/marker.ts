// The marker port: draws element ID tags, like `e6`, onto a masked screenshot, offline.
// Follows design section 6 §8.4 (the marked screenshot) and docs/decisions.md (M03, owner
// approved). The core cannot import Playwright, so the drawing sits behind this port.
import type { Masked } from "./masked.js";
import type { Outcome } from "./outcome.js";
import type { Box, Png } from "./surface.js";

/** One tag: its text and where to draw it, in screenshot pixels. */
export type Tag = { text: string; box: Box };

/** Draws tags on a picture. It never loads a page from the network. */
export interface Marker {
  /**
   * Returns a new picture with every tag drawn at the top left of its box. The input is
   * already masked; the output holds nothing new but the tags. `failed`: nothing to send.
   */
  mark(
    png: Masked<Png>,
    tags: readonly Tag[],
    signal?: AbortSignal,
  ): Promise<Outcome<Png, "failed">>;
  /** Frees the drawing browser, if one is open. */
  close(): Promise<void>;
}
