// Proves picture voting at replay (design section 7 §6.3 to §6.9 and §21 "Clue voting"; section 4
// §9.12 "a crop with any box in it is dropped"): the stripped button wins on region + image, the
// renamed button still fails, ties and "winner, alone" follow §6.6, a masked candidate crop is
// dropped, and a missing or unreadable recorded crop leaves `image` out of the vote. M08.
import { describe, expect, test } from "vitest";
import { findTarget } from "../../../src/core/replay/find-target.js";
import type { Target } from "../../../src/core/model/artifact/targets.js";
import {
  candidateLikenesses,
  loadRecordedPictures,
  type CropSource,
  type Pictures,
} from "../../../src/core/targets/picture.js";
import type { Pixels } from "../../../src/core/targets/png.js";
import { fromObservation } from "../../../src/core/targets/screen.js";
import { vote } from "../../../src/core/targets/vote.js";
import { encodePng } from "../../../src/fakes/png.js";
import { ok, fail } from "../../../src/ports/outcome.js";
import type { Eyes, Observation, Png, SurfaceElement } from "../../../src/ports/surface.js";
import { el, redactor, screen } from "../discovery/kit.js";

/** A 20x10 picture: black left of `split`, white from it on. `invert` swaps the colors. */
function half(split: number, invert = false): Pixels {
  const data = new Uint8Array(20 * 10 * 4);
  for (let y = 0; y < 10; y++) {
    for (let x = 0; x < 20; x++) {
      const v = (x < split) !== invert ? 0 : 255;
      data.set([v, v, v, 255], (y * 20 + x) * 4);
    }
  }
  return { w: 20, h: 10, data };
}

const RECORDED = half(10);
const SAME = encodePng(RECORDED);
const INVERSE = encodePng(half(10, true));

/** An eyes stub: `crop` returns the PNG bytes held for the ref; nothing else is used. */
function eyesWith(crops: Record<string, Uint8Array>): Eyes {
  const stub = {
    crop: (ref: unknown) => {
      const bytes = crops[String(ref)];
      return Promise.resolve(bytes === undefined ? fail("stale_element") : ok(bytes as Png));
    },
  };
  return stub as unknown as Eyes;
}

/** The Search button's box: at 1280x800 it is region x 0.5, y 0.4, w 0.05, h 0.03. */
const SEARCH_BOX = { x: 640, y: 320, width: 64, height: 24 };
const FAR_BOX = { x: 64, y: 640, width: 64, height: 24 };

function button(id: string, extra: Partial<SurfaceElement> = {}): SurfaceElement {
  return el(id, { role: "button", roleGroup: "button_like", box: SEARCH_BOX, ...extra });
}

function target(clues: Target["clues"]): Target {
  return { id: "search_button", description: "the search button", clues };
}

const byId = (t: Target): ReadonlyMap<string, Target> => new Map([[t.id, t]]);

const FULL = target({
  role: "button",
  name: "Search",
  label: "Search",
  text: "Search",
  region: { x: 0.5, y: 0.4, w: 0.05, h: 0.03 },
  image: "search_button.png",
  path: "good",
});

function pictures(crops: Record<string, Uint8Array>, recorded = RECORDED): Pictures {
  return { eyes: eyesWith(crops), recorded: new Map([["search_button", recorded]]) };
}

describe("a stripped button (section 7 §6.9)", () => {
  test("wins on region + image + path; the other bare image differs and scores low", async () => {
    const o: Observation = screen([
      button("bare_a", { clues: { path: "good" } }),
      button("bare_b", { clues: { path: "other" }, box: FAR_BOX }),
    ]);
    const l = await candidateLikenesses(
      pictures({ bare_a: SAME, bare_b: INVERSE }),
      o,
      FULL,
      byId(FULL),
      redactor(),
    );
    expect(l.get("search_button")?.get("0")).toBe(1);
    expect(l.get("search_button")?.get("1")).toBe(0);
    const v = vote(FULL, fromObservation(o), byId(FULL), undefined, l);
    expect(v.kind).toBe("winner");
    expect(v.facts.score).toBe(1);
    expect(v.facts.agreeing).toEqual(expect.arrayContaining(["region", "image", "path"]));
    expect(v.facts.missing).toEqual(expect.arrayContaining(["name", "text"]));
  });

  test("without pictures, region + path alone stay under the 0.20 evidence floor", () => {
    const o = screen([button("bare_a", { clues: { path: "good" } })]);
    const v = vote(FULL, fromObservation(o), byId(FULL));
    expect(v.kind).toBe("not_found");
  });
});

describe("a renamed button (section 7 §6.9)", () => {
  test("name, label, text, and image differ: score 0.15, not found; the log carries the likeness", async () => {
    // The live crop is black for 19 of 20 columns: 9 columns differ, so likeness is 0.55.
    const o = screen([
      button("renamed", { clues: { name: "Find", label: "Find", text: "Find", path: "good" } }),
    ]);
    const l = await candidateLikenesses(
      pictures({ renamed: encodePng(half(19)) }),
      o,
      FULL,
      byId(FULL),
      redactor(),
    );
    const measured = l.get("search_button")?.get("0");
    expect(measured).toBeCloseTo(0.55, 10);
    const r = findTarget(FULL, o, byId(FULL), undefined, redactor(), l);
    expect(r.kind).toBe("not_found");
    // Why 0.15, not the design's "about 0.17": §6.4 says a differing clue adds its weight to the
    // total, and all six clues are on both sides: 0.15 / 1.00. §6.9's 0.90 total leaves image out.
    expect(r.facts.score).toBeCloseTo(0.15, 10);
    const image = r.facts.differing.find((d) => d.clue === "image");
    expect(image).toEqual({ clue: "image", value: measured });
    expect(r.facts.differing.map((d) => d.clue)).toEqual(expect.arrayContaining(["name", "label", "text"]));
  });
});

describe("ties and a lone winner (section 7 §6.6)", () => {
  const T = target({ role: "button", region: { x: 0.5, y: 0.4, w: 0.05, h: 0.03 }, image: "search_button.png" });
  const two = screen([button("a"), button("b")]);

  test("two candidates that both match, margin under 0.15: ambiguous", async () => {
    const l = await candidateLikenesses(pictures({ a: SAME, b: SAME }), two, T, byId(T), redactor());
    const v = vote(T, fromObservation(two), byId(T), undefined, l);
    expect(v.kind).toBe("ambiguous");
  });

  /**
   * Target `name` + `region` + `image` (weights 0.30, 0.10, 0.10; total 0.50). Both candidates
   * agree on the name, so score = 0.6 + 0.2 * (region degree + image degree). Region degree falls
   * from 1 at 0.03 to 0 at 0.20 (center distance); image degree from 1 at likeness 0.90 to 0 at 0.60.
   */
  const N = target({ role: "button", name: "Search", region: { x: 0.5, y: 0.4, w: 0.05, h: 0.03 }, image: "search_button.png" });
  /** A button whose center sits `dx` (a viewport fraction) right of the recorded center. */
  const shifted = (id: string, dx: number) =>
    button(id, { clues: { name: "Search", path: id }, box: { ...SEARCH_BOX, x: 640 + dx * 1280 } });
  const likenessOf = (a: number, b: number) =>
    new Map([["search_button", new Map([["0", a], ["1", b]])]]);

  test("best 0.75, second 0.65, margin 0.10: the only one at 0.70 wins", () => {
    // A: region 0.5 (distance 0.115), image 0.25 (likeness 0.675). B: region 0.25 (0.1575), image 0.
    const o = screen([shifted("a", 0.115), shifted("b", 0.1575)]);
    const v = vote(N, fromObservation(o), byId(N), undefined, likenessOf(0.675, 0.6));
    expect(v.kind).toBe("winner");
    expect(v.facts.score).toBeCloseTo(0.75, 10);
    expect(v.facts.margin).toBeCloseTo(0.1, 10);
  });

  test("best 0.75, second 0.72: both reach 0.70, margin 0.03: ambiguous", () => {
    // B: region 0.25, image 0.35 (likeness 0.705).
    const o = screen([shifted("a", 0.115), shifted("b", 0.1575)]);
    const v = vote(N, fromObservation(o), byId(N), undefined, likenessOf(0.675, 0.705));
    expect(v.kind).toBe("ambiguous");
  });
});

describe("a masked candidate crop is dropped (section 4 §9.12)", () => {
  test("no likeness entry; image missing; the other clues still vote", async () => {
    const T = target({ role: "button", name: "Search", region: { x: 0.5, y: 0.4, w: 0.05, h: 0.03 }, image: "search_button.png" });
    const o = screen([
      button("bare", { clues: { name: "Search", path: "p" } }),
      // A filled field gets a mask box, and it overlaps the button's box.
      el("secret", {
        role: "textbox",
        roleGroup: "text_entry",
        field: { kind: "text", filled: true },
        box: { x: 650, y: 325, width: 100, height: 20 },
      }),
    ]);
    const l = await candidateLikenesses(pictures({ bare: SAME }), o, T, byId(T), redactor());
    expect(l.get("search_button")?.size).toBe(0);
    const v = vote(T, fromObservation(o), byId(T), undefined, l);
    expect(v.kind).toBe("winner");
    expect(v.facts.missing).toContain("image");
    expect(v.facts.agreeing).toEqual(expect.arrayContaining(["name", "region"]));
  });
});

describe("loadRecordedPictures", () => {
  const sealed = (files: Record<string, Uint8Array>): CropSource => ({
    getSealedCrop: (_a, _v, targetId) => {
      const bytes = files[targetId];
      return Promise.resolve(bytes === undefined ? fail("not_found") : ok(bytes));
    },
  });
  const run = (files: Record<string, Uint8Array>, ...targets: Target[]) =>
    loadRecordedPictures(sealed(files), "app/cap", "1.0.0", targets);

  test("reads and decodes each target's crop", async () => {
    const got = await run({ search_button: SAME }, FULL);
    expect(Array.from(got.get("search_button")?.data ?? [])).toEqual(Array.from(RECORDED.data));
  });

  test("a missing crop, an undecodable crop, and a target with no image clue leave no entry", async () => {
    const other: Target = { id: "other", description: "x", clues: { name: "Other" } };
    expect((await run({}, FULL)).size).toBe(0);
    expect((await run({ search_button: Uint8Array.from([1, 2, 3]) }, FULL)).size).toBe(0);
    expect((await run({ other: SAME }, other)).size).toBe(0);
  });

  test("with no recorded picture, image is missing for every candidate", async () => {
    const o = screen([button("bare", { clues: { name: "Search", text: "Search", path: "good" } })]);
    const none: Pictures = { eyes: eyesWith({ bare: SAME }), recorded: new Map() };
    const l = await candidateLikenesses(none, o, FULL, byId(FULL), redactor());
    expect(l.size).toBe(0);
    const v = vote(FULL, fromObservation(o), byId(FULL), undefined, l);
    expect(v.kind).toBe("winner");
    expect(v.facts.missing).toContain("image");
  });
});
