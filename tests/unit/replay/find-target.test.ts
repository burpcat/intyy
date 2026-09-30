// Proves findTarget, replay's clue-voting wiring (design section 7 §6, §6.8; section 3 §6.4;
// section 4 §9.10), end to end on the snapshot fake (section 7 §21, "Clue voting"): a stripped
// button and the evidence floor, a renamed button, a tie, a clear winner's live ref, the
// target_vote facts' shape, and that no raw known value or unmasked screen text reaches the
// logged bytes. M05 task 5.
import { describe, expect, test } from "vitest";
import { findTarget } from "../../../src/core/replay/find-target.js";
import { RunLog } from "../../../src/core/orchestrator/run-log.js";
import { SteppingClock } from "../../../src/fakes/clock.js";
import {
  SnapshotSurface,
  type FakeElement,
  type FakeSite,
} from "../../../src/fakes/snapshot-surface/index.js";
import { FakeEvidenceStore } from "../../../src/fakes/stores.js";
import type { Target } from "../../../src/core/model/artifact/targets.js";
import type { Allowlist, Observation } from "../../../src/ports/surface.js";
import { redactor } from "../discovery/kit.js";

const ORIGIN = "http://127.0.0.1:9280";
/** This suite only reads observations; it never acts, so a bare "allow everything" is enough. */
const ALLOW: Allowlist = { check: () => ({ allowed: true, irreversible: false }), popups: false };

/** A one-screen site at `/`, holding `elements`. */
function siteOf(elements: readonly FakeElement[]): FakeSite {
  return { origin: ORIGIN, screens: { "/": { elements } } };
}

/** Observes a scripted site's start page through the snapshot fake. No gate: read only. */
async function observe(site: FakeSite): Promise<Observation> {
  const opened = await new SnapshotSurface(site).open({
    origin: site.origin,
    allowlist: ALLOW,
    viewport: { width: 1280, height: 800 },
    locale: "en-US",
    timeZone: "America/New_York",
    visible: false,
  });
  if (!opened.ok) throw new Error("open failed");
  const o = await opened.value.eyes.observe();
  if (!o.ok) throw new Error("observe failed");
  return o.value;
}

/** A target: an ID, a made-up description, and clues. */
function target(id: string, clues: Target["clues"]): Target {
  return { id, description: id, clues };
}

/** A target map with just `t`, for `findTarget`'s `within` lookups. */
function byId(...targets: Target[]): ReadonlyMap<string, Target> {
  return new Map(targets.map((t) => [t.id, t]));
}

const NO_REFS = undefined;

/** A Search button's clues: name, text, region, and the fake's own generated path. */
const SEARCH_CLUES: Target["clues"] = {
  role: "button",
  name: "Search",
  text: "Search",
  region: { x: 0.5, y: 0.4, w: 0.05, h: 0.03 },
  path: "button[btn]",
};
/** The box that matches `SEARCH_CLUES.region` at a 1280x800 viewport. */
const SEARCH_BOX = { x: 640, y: 320, width: 64, height: 24 };

describe("findTarget (section 7 §6, §21 'Clue voting')", () => {
  test("a stripped button: region and path alone don't clear the evidence floor", async () => {
    // Why not_found, not winner: section 7 §21's worked example scores the image clue too, but
    // M08 has no picture likeness yet, so image is always missing (docs/decisions.md, M04).
    // Region (0.10) + path (0.05) cap at 0.15, under the 0.20 evidence floor.
    const t = target("search_button", SEARCH_CLUES);
    const site = siteOf([
      { id: "btn", role: "button", roleGroup: "button_like", box: SEARCH_BOX },
    ]);
    const found = findTarget(t, await observe(site), byId(t), NO_REFS, redactor());
    expect(found.kind).toBe("not_found");
    expect(found.facts.score).toBe(1);
    expect(found.facts.missing).toEqual(expect.arrayContaining(["name", "text"]));
    expect(found.facts.differing).toEqual([]);
  });

  test("a renamed button fails: name and text differ, so target_not_found", async () => {
    const t = target("search_button", SEARCH_CLUES);
    const site = siteOf([
      {
        id: "btn",
        role: "button",
        roleGroup: "button_like",
        name: "Find",
        text: "Find",
        box: SEARCH_BOX,
      },
    ]);
    const found = findTarget(t, await observe(site), byId(t), NO_REFS, redactor());
    expect(found.kind).toBe("not_found");
    expect(found.facts.score).toBeLessThan(0.7);
    // Why button-like carries a value: section 4 §9.10, names only for button-like candidates.
    expect(found.facts.differing).toEqual([
      { clue: "name", value: "Find" },
      { clue: "text", value: "Find" },
    ]);
  });

  test("a tie is target_ambiguous", async () => {
    const t = target("open_button", { role: "button", name: "Open" });
    const site = siteOf([
      { id: "a", role: "button", roleGroup: "button_like", name: "Open" },
      { id: "b", role: "button", roleGroup: "button_like", name: "Open" },
    ]);
    const found = findTarget(t, await observe(site), byId(t), NO_REFS, redactor());
    expect(found.kind).toBe("ambiguous");
    expect(found.facts.margin).toBe(0);
    expect(found.facts.candidates).toBe(2);
  });

  test("a clear winner: its live ref is ready to act on, and the shape is a target_vote line", async () => {
    const t = target("search_button", { role: "button", name: "Search" });
    const site = siteOf([
      { id: "btn", role: "button", roleGroup: "button_like", name: "Search", box: SEARCH_BOX },
      { id: "other", role: "button", roleGroup: "button_like", name: "Cancel" },
    ]);
    const o = await observe(site);
    const found = findTarget(t, o, byId(t), NO_REFS, redactor());
    expect(found.kind).toBe("winner");
    if (found.kind !== "winner") return;
    expect(found.ref).toBe(o.elements.find((e) => e.clues.name === "Search")?.ref);
    expect(found.facts).toEqual({
      candidates: 2,
      winner: "0",
      score: 1,
      margin: 1,
      agreeing: ["name"],
      differing: [],
      missing: [],
    });
  });

  test("target_vote line: no raw known value or unmasked screen text reaches the logged bytes", async () => {
    const r = redactor(); // knows input.member_id = "100107" (docs/discovery/kit.js)
    const t = target("search_button", { role: "button", name: "Search" });
    const site = siteOf([
      { id: "btn", role: "button", roleGroup: "button_like", name: "Search 100107" },
    ]);
    const found = findTarget(t, await observe(site), byId(t), NO_REFS, r);
    expect(found.kind).toBe("not_found"); // the only clue, `name`, differs
    expect(found.facts.differing).toEqual([{ clue: "name", value: "Search {input.member_id}" }]);

    const store = new FakeEvidenceStore();
    const created = await store.createRun("kvfcu", "run_2026-01-15_0000000000");
    if (!created.ok) throw new Error("createRun failed");
    const log = new RunLog(created.value, r, new SteppingClock());
    const wrote = await log.append({
      event: "target_vote",
      step: "click_search",
      by: "engine",
      data: found.facts,
    });
    expect(wrote).toBe(true);

    const events = await store.events("kvfcu", created.value.runId);
    if (!events.ok) throw new Error("events failed");
    const bytes = JSON.stringify(events.value);
    expect(bytes).not.toContain("100107");
    expect(bytes).toContain("{input.member_id}");
  });
});
