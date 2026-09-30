// The fixture site the surface contract suite runs on: a few small screens, as a scripted graph.
// The live run serves the same screens as HTML from a helper server (M02 task 12), never the bank app.
// Design section 9 §5.9 (snapshot surface) and section 7 §9 (dialogs and pop-ups).
import type { FakeSite } from "../../../src/fakes/snapshot-surface/index.js";

/** The fake's origin. Loopback, like every test host. */
export const FAKE_ORIGIN = "http://127.0.0.1:9180";

/** Paths the suite's allowlist allows. `/__test__/*` is denied, as in the kvfcu app layer. */
export const SITE_PATHS = {
  allow: ["/", "/members", "/lookup", "/frame", "/pixel.gif", "/data.json"],
  deny: ["/__test__/*"],
  irreversible: [],
  case_sensitive: true,
};

/** Builds the scripted site at an origin. */
export function fixtureSite(origin: string): FakeSite {
  const box = (y: number): { x: number; y: number; width: number; height: number } => ({
    x: 16,
    y,
    width: 120,
    height: 24,
  });
  return {
    origin,
    screens: {
      "/": {
        // Why: the same elements, in the same document order, as the HTML page the helper
        // server serves (tests/live/fixture-server.ts), so both backends print one tree.
        elements: [
          {
            id: "search_form",
            role: "form",
            roleGroup: "container",
            name: "Member ID Password Search",
            text: "Member ID Password Search",
            box: { x: 8, y: 8, width: 600, height: 24 },
          },
          {
            id: "member_id",
            parent: "search_form",
            role: "textbox",
            roleGroup: "text_entry",
            label: "Member ID",
            field: { kind: "text", value: "" },
            form: { id: "search", submits: false },
            box: box(16),
          },
          {
            id: "password",
            parent: "search_form",
            role: "textbox",
            roleGroup: "text_entry",
            label: "Password",
            field: { kind: "password", value: "" },
            form: { id: "search", submits: false },
            box: box(48),
          },
          {
            id: "search",
            parent: "search_form",
            role: "button",
            roleGroup: "button_like",
            name: "Search",
            text: "Search",
            form: { id: "search", submits: true },
            box: box(80),
            onClick: { go: "/members" },
          },
          {
            id: "members",
            role: "link",
            roleGroup: "navigation",
            name: "Members",
            text: "Members",
            href: "/members",
            box: box(112),
          },
          {
            id: "ncua",
            role: "link",
            roleGroup: "navigation",
            name: "NCUA",
            text: "NCUA",
            href: "https://www.ncua.gov/",
            box: box(144),
          },
          {
            id: "delete",
            role: "button",
            roleGroup: "button_like",
            name: "Delete",
            text: "Delete",
            box: box(176),
            onClick: { dialog: { kind: "confirm", message: "Delete member?" } },
          },
          {
            id: "lookup",
            role: "button",
            roleGroup: "button_like",
            name: "Lookup",
            text: "Lookup",
            box: box(208),
            onClick: { popup: "/lookup" },
          },
          {
            id: "help_frame",
            role: "iframe",
            roleGroup: "container",
            name: "help",
            tooltip: "help",
            box: { x: 16, y: 240, width: 300, height: 60 },
          },
          {
            id: "chart",
            role: "canvas",
            roleGroup: "container",
            name: "Chart",
            unreadable: true,
            box: { x: 16, y: 304, width: 200, height: 100 },
          },
          {
            id: "joint",
            role: "checkbox",
            roleGroup: "check",
            label: "Joint",
            field: { kind: "check", checked: false },
            box: box(408),
          },
          {
            id: "kind",
            role: "combobox",
            roleGroup: "choice",
            label: "Kind",
            field: { kind: "choice", value: "Savings" },
            box: box(440),
          },
          {
            id: "add_note",
            role: "button",
            roleGroup: "button_like",
            name: "Add note",
            text: "Add note",
            box: box(472),
            onClick: {
              insert: { id: "note", role: "generic", roleGroup: "container", text: "Note added" },
            },
          },
          {
            id: "help",
            parent: "help_frame",
            role: "button",
            roleGroup: "button_like",
            name: "Help",
            text: "Help",
            frame: 0,
            box: box(248),
          },
          {
            // Why: section 7 §7.2, "a pop-up covered Confirm": a click's readiness check fails
            // before any input event, so it stays `dispatched: false`.
            id: "covered",
            role: "button",
            roleGroup: "button_like",
            name: "Covered",
            text: "Covered",
            box: box(504),
            covered: true,
          },
        ],
      },
      "/members": {
        elements: [
          { id: "title", role: "heading", roleGroup: "container", text: "Members", box: box(16) },
        ],
        // Why: section 7 §5.1, a fixed case for the static/data resource tag.
        requests: [
          { url: `${origin}/pixel.gif`, resource: "static" },
          { url: `${origin}/data.json`, resource: "data" },
        ],
      },
      "/lookup": {
        elements: [
          {
            id: "close",
            role: "button",
            roleGroup: "button_like",
            name: "Close",
            text: "Close",
            box: box(16),
            onClick: { closePopup: true },
          },
        ],
      },
    },
  };
}
