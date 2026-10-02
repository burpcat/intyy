// Proves clue voting (design section 7 §6): the winner rule, `within`, the role filter, the frame
// filter, and the two minimum-evidence rules. Names and values are made up. M04 task 5.
import { describe, expect, test } from "vitest";
import type { Target } from "../../../src/core/model/artifact/targets.js";
import { fromObservation } from "../../../src/core/targets/screen.js";
import { filterByFrame, vote } from "../../../src/core/targets/vote.js";
import { el, screen } from "../discovery/kit.js";

/** A minimal target: an ID, a made-up description, and clues. */
function target(id: string, clues: Target["clues"], within?: string): Target {
  return within === undefined
    ? { id, description: id, clues }
    : { id, description: id, within, clues };
}

/** A target map with just `targets`, for `vote`'s `within` lookups. */
function byId(...targets: Target[]): ReadonlyMap<string, Target> {
  return new Map(targets.map((t) => [t.id, t]));
}

describe("the winner rule (section 7 §6.6, §6.9)", () => {
  test("the winner rule: floor, label clue, bare image, rename, and tie", () => {
    // a stripped Search button: region and path alone score 1.00, but the evidence floor blocks it.
    {
      // Why: section 7 §6.9's worked example also scores the image clue. M08 has no pixel
      // compare yet, so `image` is always missing here (see vote.ts). Region and path alone
      // cap at 0.15 weight, under the 0.20 evidence floor (section 7 §6.5, rule 1) even at a
      // perfect score. This also shows rule 2 (a name/label/text/image clue must agree) can
      // never fail on its own here: region+path can never reach 0.20 by themselves, so any
      // candidate that clears rule 1 already has a name, label, text, or image clue agreeing.
      const t = target("search_button", {
        role: "button",
        name: "Search",
        text: "Search",
        region: { x: 0.72, y: 0.31, w: 0.05, h: 0.03 },
        path: "body > div > button[2]",
      });
      const today = screen([
        el("btn", {
          role: "button",
          roleGroup: "button_like",
          clues: { path: "body > div > button[2]" },
          box: { x: 921.6, y: 248, width: 64, height: 24 },
        }),
      ]);
      const v = vote(t, fromObservation(today), byId(t));
      expect(v.kind).toBe("not_found");
      expect(v.facts.score).toBe(1);
      expect(v.facts.missing).toEqual(expect.arrayContaining(["name", "text"]));
    }

    // a stripped Search button wins when its label clue survives.
    {
      const t = target("search_button", {
        role: "button",
        label: "Search",
        region: { x: 0.72, y: 0.31, w: 0.05, h: 0.03 },
        path: "body > div > button[2]",
      });
      const today = screen([
        el("btn", {
          role: "button",
          roleGroup: "button_like",
          clues: { path: "body > div > button[2]", label: "Search" },
          box: { x: 921.6, y: 248, width: 64, height: 24 },
        }),
      ]);
      const v = vote(t, fromObservation(today), byId(t));
      expect(v.kind).toBe("winner");
      if (v.kind === "winner") expect(v.elementId).toBe("0");
    }

    // a button stripped to a bare image (role img, not clickable in the DOM) stays a candidate and wins on region and image.
    {
      const t = target("search_button", {
        role: "button",
        name: "Search",
        region: { x: 0.72, y: 0.31, w: 0.05, h: 0.03 },
        image: "crops/search_button.png",
        path: "body > div > input[0]",
      });
      const today = screen([
        el("bullet", { role: "img", roleGroup: "container", clues: { path: "body > img[0]" }, box: { x: 10, y: 10, width: 7, height: 7 } }),
        el("btn", { role: "img", roleGroup: "container", clues: { path: "body > div > img[0]" }, box: { x: 921.6, y: 248, width: 64, height: 24 } }),
      ]);
      const likenesses = new Map([["search_button", new Map([["0", 0.1], ["1", 0.95]])]]);
      const v = vote(t, fromObservation(today), byId(t), undefined, likenesses);
      expect(v.kind).toBe("winner");
      if (v.kind === "winner") expect(v.elementId).toBe("1");
      expect(v.facts.missing).toContain("name");
      expect(v.facts.agreeing).toEqual(expect.arrayContaining(["region", "image"]));
    }

    // a renamed button fails: name and text differ, so target_not_found.
    {
      const t = target("search_button", {
        role: "button",
        name: "Search",
        text: "Search",
        region: { x: 0.72, y: 0.31, w: 0.05, h: 0.03 },
        path: "body > div > button[2]",
      });
      const today = screen([
        el("btn", {
          role: "button",
          roleGroup: "button_like",
          clues: { path: "body > div > button[2]", name: "Find", text: "Find" },
          box: { x: 921.6, y: 248, width: 64, height: 24 },
        }),
      ]);
      const v = vote(t, fromObservation(today), byId(t));
      expect(v.kind).toBe("not_found");
      expect(v.facts.score).toBeLessThan(0.7);
      expect(v.facts.differing).toEqual(expect.arrayContaining(["name", "text"]));
    }

    // a tie is target_ambiguous.
    {
      const t = target("open_button", { role: "button", name: "Open" });
      const today = screen([
        el("a", { role: "button", roleGroup: "button_like", clues: { path: "a", name: "Open" } }),
        el("b", { role: "button", roleGroup: "button_like", clues: { path: "b", name: "Open" } }),
      ]);
      const v = vote(t, fromObservation(today), byId(t));
      expect(v.kind).toBe("ambiguous");
      expect(v.facts.margin).toBe(0);
    }
  });
});

describe("`within` (section 7 §6.2)", () => {
  test("an ambiguous parent makes the child ambiguous too, without scoring the child", () => {
    const panel = target("panel", { role: "form", name: "Search Panel" });
    const go = target("go_button", { role: "button", name: "Go" }, "panel");
    const today = screen([
      el("p1", { role: "form", roleGroup: "container", clues: { path: "p1", name: "Search Panel" } }),
      el("p2", { role: "form", roleGroup: "container", clues: { path: "p2", name: "Search Panel" } }),
      el("go", { role: "button", roleGroup: "button_like", clues: { path: "p1 > go", name: "Go" } }),
    ]);
    const v = vote(go, fromObservation(today), byId(panel, go));
    expect(v.kind).toBe("ambiguous");
    expect(v.facts.candidates).toBe(0);
  });
});

describe("the role-group filter (section 7 §6.1)", () => {
  test("the role-group filter blocks a wrong group and falls back on an exact role", () => {
    // a matching name on the wrong role group never wins.
    {
      const t = target("search_button", { role: "button", name: "Search" });
      const today = screen([
        // A perfect name match, but a navigation-role link: filtered out before scoring.
        el("link", { role: "link", roleGroup: "navigation", href: "/help", clues: { path: "link", name: "Search" } }),
      ]);
      const v = vote(t, fromObservation(today), byId(t));
      expect(v.kind).toBe("not_found");
      expect(v.facts.candidates).toBe(0);
    }

    // an unmapped role falls back to an exact role match, not a guessed group.
    {
      // "spinnerbutton" is not in the design's role-group table. A same-named "button" must not
      // pass as a stand-in: a `container` guess would wrongly let it, or wrongly exclude the
      // real element if the guess landed elsewhere.
      const t = target("refresh_button", { role: "spinnerbutton", name: "Refresh" });
      const today = screen([
        el("a", { role: "spinnerbutton", roleGroup: "button_like", clues: { path: "a", name: "Refresh" } }),
        el("b", { role: "button", roleGroup: "button_like", clues: { path: "b", name: "Refresh" } }),
      ]);
      const v = vote(t, fromObservation(today), byId(t));
      expect(v.kind).toBe("winner");
      if (v.kind === "winner") expect(v.elementId).toBe("0");
      expect(v.facts.candidates).toBe(1);
    }
  });
});

describe("the frame filter (section 9 §5, frames as `frame[n]`)", () => {
  test("a target is matched only in the frame it was recorded in", () => {
    const t = target("open_sub_link", { role: "link", name: "Open Sub-Account", path: "frame[2] > body > div > a[0]" });
    const menu = el("menu", { role: "link", roleGroup: "navigation", href: "/menu", clues: { path: "frame[1] > body > div > a[0]", name: "Open Sub-Account" } });
    const page = el("page", { role: "link", roleGroup: "navigation", href: "/page", clues: { path: "frame[2] > body > div > a[0]", name: "Open Sub-Account" } });

    // two links with the same name in two frames: the vote picks the recorded frame's link.
    {
      const v = vote(t, fromObservation(screen([menu, page])), byId(t));
      expect(v.kind).toBe("winner");
      if (v.kind === "winner") expect(v.elementId).toBe("1");
      expect(v.facts.candidates).toBe(1);
    }

    // only the other frame's link on screen: not_found, with no fallback to another frame.
    {
      const v = vote(t, fromObservation(screen([menu])), byId(t));
      expect(v.kind).toBe("not_found");
      expect(v.facts.candidates).toBe(0);
    }

    // a top-page path drops elements under frame[n] and keeps a native dialog control.
    const items = [{ path: "frame[1] > body > a[0]" }, { path: "body > a[0]" }, { path: "native:dialog > accept" }];
    expect(filterByFrame("body > div > a[0]", items)).toEqual([{ path: "body > a[0]" }, { path: "native:dialog > accept" }]);

    // no path clue keeps everything.
    expect(filterByFrame(undefined, items)).toEqual(items);
  });
});

describe("replay reads a field's label by the discovery rule (section 6 §13.2)", () => {
  test("replay finds a field by its layout label or the words beside it", () => {
    // a field recorded with its layout label is found when its markup label is shorter.
    {
      // Why: discovery records the cell beside the field ("Member No. *"); markup ties only
      // "Member No.". Reading markup alone made the label differ and dropped the score to 0.64.
      const t = target("member_no_box", {
        role: "textbox",
        name: "Member No.",
        label: "Member No. *",
        region: { x: 0.3, y: 0.19, w: 0.07, h: 0.024 },
        path: "form > input[0]",
      });
      const today = screen([
        el("cell", { clues: { path: "form > td[0]", text: "Member No. *" }, box: { x: 250, y: 151, width: 120, height: 20 } }),
        el("box", {
          role: "textbox",
          roleGroup: "text_entry",
          clues: { path: "form > input[0]", name: "Member No.", label: "Member No." },
          box: { x: 384, y: 151, width: 91, height: 20 },
        }),
      ]);
      const v = vote(t, fromObservation(today), byId(t));
      expect(v.kind).toBe("winner");
      if (v.kind === "winner") expect(v.elementId).toBe("1");
    }

    // a read value with no markup label is found by the words beside it.
    {
      const t = target("account_no_generic", {
        role: "generic",
        label: "Account No.",
        region: { x: 0.32, y: 0.24, w: 0.07, h: 0.017 },
        path: "tr[3] > td[1] > b[0]",
      });
      const today = screen([
        el("cell", { clues: { path: "tr[3] > td[0]", text: "Account No." }, box: { x: 250, y: 192, width: 150, height: 14 } }),
        el("value", { clues: { path: "tr[3] > td[1] > b[0]", text: "100245-S02" }, box: { x: 410, y: 192, width: 94, height: 14 } }),
      ]);
      const v = vote(t, fromObservation(today), byId(t));
      expect(v.kind).toBe("winner");
      if (v.kind === "winner") expect(v.elementId).toBe("1");
    }
  });
});
