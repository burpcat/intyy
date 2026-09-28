// The fixture site the surface contract suite runs on: a few small screens, as a scripted graph.
// The live run serves the same screens as HTML from a helper server (M02 task 12), never the bank app.
// Design section 9 §5.9 (snapshot surface) and section 7 §9 (dialogs and pop-ups).
import type { FakeSite } from "../../../src/fakes/snapshot-surface/index.js";

/** The fake's origin. Loopback, like every test host. */
export const FAKE_ORIGIN = "http://127.0.0.1:9180";

/** Paths the suite's allowlist allows. `/__test__/*` is denied, as in the kvfcu app layer. */
export const SITE_PATHS = {
  allow: ["/", "/members", "/lookup", "/frame"],
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
        elements: [
          {
            id: "member_id",
            role: "textbox",
            roleGroup: "text_entry",
            label: "Member ID",
            field: { kind: "text", value: "" },
            form: { id: "search", submits: false },
            box: box(16),
          },
          {
            id: "password",
            role: "textbox",
            roleGroup: "text_entry",
            label: "Password",
            field: { kind: "password", value: "" },
            form: { id: "search", submits: false },
            box: box(48),
          },
          {
            id: "search",
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
            id: "help",
            role: "button",
            roleGroup: "button_like",
            name: "Help",
            text: "Help",
            frame: 0,
            box: box(240),
          },
          {
            id: "joint",
            role: "checkbox",
            roleGroup: "check",
            label: "Joint",
            field: { kind: "check", checked: false },
            box: box(304),
          },
          {
            id: "kind",
            role: "combobox",
            roleGroup: "choice",
            label: "Kind",
            field: { kind: "choice", value: "Savings" },
            box: box(336),
          },
          {
            id: "chart",
            role: "img",
            roleGroup: "container",
            name: "Chart",
            unreadable: true,
            box: { x: 16, y: 272, width: 200, height: 100 },
          },
        ],
      },
      "/members": {
        elements: [
          { id: "title", role: "heading", roleGroup: "container", text: "Members", box: box(16) },
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
