// The fake marker: the twin of the Playwright marker. It returns a fake PNG whose JSON body names
// the tags it drew, so tests can read them back. Follows design section 9 §5.9 and section 6 §8.4.
import type { Marker, Tag } from "../ports/marker.js";
import type { Masked } from "../ports/masked.js";
import { fail, ok, type Outcome } from "../ports/outcome.js";
import type { Png } from "../ports/surface.js";

/** The PNG file signature. */
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** What a fake marked picture holds after its signature. */
export type FakeMarked = { base: number[]; tags: Tag[] };

/** Reads a fake marked picture back. */
export function readFakeMarked(png: Uint8Array): FakeMarked {
  return JSON.parse(new TextDecoder().decode(png.slice(PNG_SIGNATURE.length))) as FakeMarked;
}

/** Marks by writing JSON. `broken` makes every call fail, like a crashed browser. */
export class FakeMarker implements Marker {
  calls = 0;
  constructor(private readonly broken = false) {}

  mark(png: Masked<Png>, tags: readonly Tag[]): Promise<Outcome<Png, "failed">> {
    this.calls += 1;
    if (this.broken) return Promise.resolve(fail("failed"));
    const body: FakeMarked = { base: [...png.slice(0, 16)], tags: [...tags] };
    const json = new TextEncoder().encode(JSON.stringify(body));
    const bytes = new Uint8Array(PNG_SIGNATURE.length + json.length);
    bytes.set(PNG_SIGNATURE);
    bytes.set(json, PNG_SIGNATURE.length);
    return Promise.resolve(ok(bytes as Png));
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}
