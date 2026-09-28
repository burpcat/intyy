// Proves the marked screenshot: tags on controls at their screenshot place, the masked picture
// unmarked when the marker fails, and nothing when the picture is withheld. Design section 6
// §8.4, section 4 §9.11; M03 task 3.
import { describe, expect, test } from "vitest";
import { buildScreen } from "../../../src/core/discovery/observation.js";
import { tagsFor, turnPicture } from "../../../src/core/discovery/screenshot.js";
import { FakeMarker, readFakeMarked } from "../../../src/fakes/marker.js";
import { ok } from "../../../src/ports/outcome.js";
import type { Eyes, Observation, Png } from "../../../src/ports/surface.js";
import { el, redactor, screen } from "./kit.js";

const box = (x: number, y: number) => ({ x, y, width: 80, height: 20 });

/** A screen with a heading, a button, a field, and a button scrolled out of view. */
function page(extra: Partial<Observation> = {}): Observation {
  return screen(
    [
      el("h", { role: "heading", clues: { path: "h1", text: "Sign in" }, box: box(10, 10) }),
      el("b", {
        role: "button",
        roleGroup: "button_like",
        clues: { path: "b", name: "Go" },
        box: box(100, 300),
      }),
      el("f", {
        role: "textbox",
        roleGroup: "text_entry",
        clues: { path: "i", label: "User" },
        field: { kind: "text", value: "" },
        box: box(100, 250),
      }),
      el("far", {
        role: "button",
        roleGroup: "button_like",
        clues: { path: "b2", name: "Far" },
        box: box(100, 2000),
      }),
    ],
    { scroll: { x: 0, y: 200 }, ...extra },
  );
}

/** Eyes that always see `o` and shoot a fixed fake picture. */
function eyes(o: Observation): Eyes {
  return {
    observe: () => Promise.resolve(ok(o)),
    screenshot: () => Promise.resolve(ok(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]) as Png)),
    snapshots: () => Promise.resolve(ok({ dom: "", a11y: "" })),
    crop: () => Promise.resolve(ok(new Uint8Array() as Png)),
    events: async function* () {},
  };
}

describe("tags (section 6 §8.4)", () => {
  test("controls in view get their ID at their place in the screenshot", () => {
    const o = page();
    const view = buildScreen(o, redactor());
    expect(tagsFor(view, o)).toEqual([
      { text: "e2", box: { x: 100, y: 100, width: 80, height: 20 } },
      { text: "e3", box: { x: 100, y: 50, width: 80, height: 20 } },
    ]);
  });
});

describe("turn picture", () => {
  test("the masked picture is marked with the tags", async () => {
    const o = page();
    const r = redactor();
    const pic = await turnPicture(eyes(o), new FakeMarker(), r, buildScreen(o, r), o);
    expect(pic.marked).toBe(true);
    expect(pic.png).not.toBeNull();
    expect(readFakeMarked(pic.png ?? new Uint8Array()).tags.map((t) => t.text)).toEqual([
      "e2",
      "e3",
    ]);
  });

  test("a failed marker still sends the masked picture, unmarked", async () => {
    const o = page();
    const r = redactor();
    const pic = await turnPicture(eyes(o), new FakeMarker(true), r, buildScreen(o, r), o);
    expect(pic).toMatchObject({ marked: false, withheld: null });
    expect([...(pic.png ?? [])]).toEqual([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  });

  test("an open native box withholds the picture, and the marker never runs", async () => {
    const o = page({ dialog: { kind: "alert", message: "Saved" } });
    const r = redactor();
    const marker = new FakeMarker();
    const pic = await turnPicture(eyes(o), marker, r, buildScreen(o, r), o);
    expect(pic).toEqual({ png: null, marked: false, withheld: "dialog_open" });
    expect(marker.calls).toBe(0);
  });
});
