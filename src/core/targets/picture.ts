// Picture likeness at replay: the recorded crop of a target against each live candidate's crop.
// Follows design section 7 §6.3 (`image` clue, plain code, no model), section 4 §9.12 (a crop
// with a mask box in it is dropped), §7.8 check 4 (the gate's picture match), and section 6 §13
// (crops are recorded before typing).
import type { Outcome } from "../../ports/outcome.js";
import type { ElementRef, Eyes, Observation } from "../../ports/surface.js";
import type { Rev } from "../../ports/stores.js";
import type { Target } from "../model/artifact/targets.js";
import { maskedCrop } from "../safety/redaction/images.js";
import type { Redactor } from "../safety/redaction/redactor.js";
import { likeness } from "./likeness.js";
import { decodePng, type Pixels } from "./png.js";
import { filterByRole } from "./vote.js";

/** Decoded recorded crops by target ID. A target with no entry has no usable picture. */
export type RecordedPictures = ReadonlyMap<string, Pixels>;

/** What `findTarget` needs to compare pictures: the live eyes and the recorded crops. */
export type Pictures = { eyes: Eyes; recorded: RecordedPictures };

/** Measured likeness, by target ID, then by screen element ID (`fromObservation`'s index). A
 * candidate with no entry has no crop to compare: its `image` clue is missing (section 7 §6.4). */
export type Likenesses = ReadonlyMap<string, ReadonlyMap<string, number>>;

/** The part of the artifact store that gives back sealed crops. */
export interface CropSource {
  getSealedCrop(
    artifactId: string,
    version: Rev,
    targetId: string,
    signal?: AbortSignal,
  ): Promise<Outcome<Uint8Array, "not_found">>;
}

/**
 * Reads and decodes each sealed crop of `targets` that has an `image` clue. A missing or
 * unreadable crop leaves no entry: that target's `image` clue is then missing, never differing.
 */
export async function loadRecordedPictures(
  store: CropSource,
  artifactId: string,
  version: Rev,
  targets: readonly Target[],
  signal?: AbortSignal,
): Promise<RecordedPictures> {
  const out = new Map<string, Pixels>();
  for (const t of targets) {
    if (t.clues.image === undefined) continue;
    const bytes = await store.getSealedCrop(artifactId, version, t.id, signal);
    if (!bytes.ok) continue;
    const px = decodePng(bytes.value);
    if (px.ok) out.set(t.id, px.value);
  }
  return out;
}

/**
 * The live likeness of one element to a recorded crop, or null when there is none to compare: a
 * dropped crop (a mask box touches it, section 4 §9.12), a stale element, or unreadable pixels.
 */
export async function pictureLikeness(
  eyes: Eyes,
  o: Observation,
  ref: ElementRef,
  redactor: Redactor,
  recorded: Pixels,
  signal?: AbortSignal,
): Promise<number | null> {
  const crop = await maskedCrop(eyes, o, ref, redactor, signal);
  if (!crop.ok) return null;
  const px = decodePng(crop.value);
  return px.ok ? likeness(recorded, px.value) : null;
}

/**
 * Measures every role-filtered candidate of `target` and of each `within` ancestor that has a
 * recorded crop. Run before the sync vote (section 7 §6). Why every candidate: the vote needs the
 * other bare images' low likeness too (§6.9, "Other bare images have a different picture").
 */
export async function candidateLikenesses(
  pictures: Pictures,
  o: Observation,
  target: Target,
  targetsById: ReadonlyMap<string, Target>,
  redactor: Redactor,
  signal?: AbortSignal,
): Promise<Likenesses> {
  const out = new Map<string, Map<string, number>>();
  for (let t: Target | undefined = target; t !== undefined; t = t.within === undefined ? undefined : targetsById.get(t.within)) {
    const recorded = pictures.recorded.get(t.id);
    if (t.clues.image === undefined || recorded === undefined) continue;
    const row = new Map<string, number>();
    const pool = filterByRole(
      t.clues.role,
      o.elements.map((el, i) => ({ role: el.role, roleGroup: el.roleGroup, ref: el.ref, i })),
    );
    for (const c of pool) {
      const l = await pictureLikeness(pictures.eyes, o, c.ref, redactor, recorded, signal);
      if (l !== null) row.set(String(c.i), l);
    }
    out.set(t.id, row);
  }
  return out;
}

/** The target's decoded sealed crop as the gate's `confirmed.picture` field, or nothing
 * (section 4 §7.8 check 4). Built to spread into an object. */
export function picOf(recorded: RecordedPictures | undefined, target: Target): { picture?: Pixels } {
  const picture = recorded?.get(target.id);
  return picture === undefined ? {} : { picture };
}
