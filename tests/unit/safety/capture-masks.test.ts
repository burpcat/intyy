// Proves image and snapshot masking: boxes cover every element rules 1 to 4 name, a masking
// failure refuses to save, crops follow their rules, and snapshots keep no raw text or values.
// Design section 4 §9.11 to §9.13, section 3 §7.6; section 4 §14, "Screenshot masks"; M02 task 9.
// Names here are made up. Seed member 100240 is the canary and never appears.
import { describe, expect, test } from "vitest";
import {
  boxedElements,
  maskedCrop,
  maskedScreenshot,
} from "../../../src/core/safety/redaction/images.js";
import { Redactor, redactionRules } from "../../../src/core/safety/redaction/redactor.js";
import { maskA11y, maskDom } from "../../../src/core/safety/redaction/snapshots.js";
import { ok, type Outcome } from "../../../src/ports/outcome.js";
import type {
  ElementRef,
  Eyes,
  Observation,
  Png,
  SurfaceElement,
} from "../../../src/ports/surface.js";
import { testPolicy } from "../../contract/surface/gate-kit.js";

const policy = testPolicy({ allow: ["/"], deny: [], irreversible: [] });

/** A fresh redactor that knows member 100107 as an input. */
function redactor(): Redactor {
  const r = new Redactor(redactionRules(policy));
  r.addKnown({
    ref: "input.member_id",
    value: "100107",
    label: "pii",
    type: "text",
    kind: "member",
  });
  return r;
}

const ref = (id: string) => id as unknown as ElementRef;
const box = (x: number, y: number, w = 100, h = 20) => ({ x, y, width: w, height: h });

let nextY = 0;

/** One element with defaults. Each gets its own box, one row down. */
function el(id: string, extra: Partial<SurfaceElement> = {}): SurfaceElement {
  nextY += 30;
  return {
    ref: ref(id),
    role: "generic",
    roleGroup: "container",
    clues: { path: id },
    enabled: true,
    box: box(0, nextY),
    ...extra,
  };
}

/** A screen with one element of each kind the rules name, and some that stay visible. */
const screen: Observation = {
  url: "http://127.0.0.1:9183/",
  title: "",
  page: "main",
  popups: 0,
  dialog: null,
  viewport: { width: 1280, height: 800 },
  scroll: { x: 0, y: 0 },
  elements: [
    // Rule 1: text the rules change. The known member ID, and a cell under a "Name" header.
    el("r1_member", { clues: { path: "p", text: "Member 100107" } }),
    el("r1_cell", {
      role: "cell",
      clues: { path: "td", text: "DANA QUILLFEATHER" },
      context: { column: "Name" },
    }),
    el("r1_left", {
      role: "cell",
      clues: { path: "td", text: "02134" },
      context: { left: "Zip" },
    }),
    el("r1_labelled", {
      clues: { path: "div", text: "LEE WREN", label: "Member Name" },
    }),
    // Rule 2: a text field with a value, and a dropdown whose shown option changes.
    el("r2_field", {
      role: "textbox",
      roleGroup: "text_entry",
      clues: { path: "input", label: "Note" },
      field: { kind: "text", value: "call back" },
    }),
    el("r2_choice", {
      role: "combobox",
      roleGroup: "choice",
      clues: { path: "select", label: "Account Holder" },
      field: { kind: "choice", value: "LEE WREN" },
    }),
    // Rule 3: a secret-filled field.
    el("r3_secret", {
      role: "textbox",
      roleGroup: "text_entry",
      clues: { path: "input", label: "Password" },
      field: { kind: "password", filled: true },
    }),
    // Rule 4: what the redactor cannot read.
    el("r4_canvas", { role: "canvas", unreadable: true, clues: { path: "canvas" } }),
    // Visible: plain labels, empty fields, a safe dropdown, a checkbox.
    el("v_search", {
      role: "button",
      roleGroup: "button_like",
      clues: { path: "b", name: "Search", text: "Search" },
    }),
    el("v_heading", { role: "heading", clues: { path: "h1", text: "Member search" } }),
    el("v_empty", {
      role: "textbox",
      roleGroup: "text_entry",
      clues: { path: "input", label: "Member ID" },
      field: { kind: "text", value: "" },
    }),
    el("v_kind", {
      role: "combobox",
      roleGroup: "choice",
      clues: { path: "select", label: "Kind" },
      field: { kind: "choice", value: "Savings" },
    }),
    el("v_check", {
      role: "checkbox",
      roleGroup: "check",
      clues: { path: "cb" },
      field: { kind: "check", checked: true },
    }),
    el("v_branch", {
      role: "cell",
      clues: { path: "td", text: "Main" },
      context: { column: "Branch" },
    }),
  ],
};

const ids = (els: readonly SurfaceElement[]) => els.map((e) => e.ref as unknown as string).sort();

describe("what gets a box (section 4 §9.11)", () => {
  test("boxes cover every element rules 1 to 4 name, and nothing else", () => {
    expect(ids(boxedElements(screen, redactor()))).toEqual(
      [
        "r1_cell",
        "r1_labelled",
        "r1_left",
        "r1_member",
        "r2_choice",
        "r2_field",
        "r3_secret",
        "r4_canvas",
      ].sort(),
    );
  });

  test("rule 1 boxes the smallest element that holds the text", () => {
    const o: Observation = {
      ...screen,
      elements: [
        el("form", {
          clues: { path: "form", text: "Member 100107 Search" },
          box: box(0, 0, 500, 200),
        }),
        el("span", { clues: { path: "span", text: "Member 100107" }, box: box(10, 10, 100, 20) }),
      ],
    };
    expect(ids(boxedElements(o, redactor()))).toEqual(["span"]);
  });

  test("without boxes, both a container and its child are boxed", () => {
    const o: Observation = {
      ...screen,
      elements: [
        el("form", { clues: { path: "form", text: "Member 100107" }, box: null }),
        el("span", { clues: { path: "span", text: "Member 100107" }, box: null }),
      ],
    };
    expect(ids(boxedElements(o, redactor()))).toEqual(["form", "span"]);
  });
});

/** A scripted eyes: each observe returns the next screen; screenshot answers as told. */
function scriptedEyes(screens: Observation[], shot: Outcome<Png, "page_gone" | "stale_element">) {
  let i = 0;
  const masks: ElementRef[][] = [];
  const eyes: Eyes = {
    observe: () => Promise.resolve(ok(screens[Math.min(i++, screens.length - 1)] ?? screen)),
    screenshot: (m) => {
      masks.push([...m]);
      return Promise.resolve(shot);
    },
    snapshots: () => Promise.resolve(ok({ dom: "", a11y: "" })),
    crop: () => Promise.resolve(ok(new Uint8Array([1]) as Png)),
    events: () => ({
      [Symbol.asyncIterator]: () => ({
        next: () => Promise.resolve({ done: true, value: undefined }),
      }),
    }),
  };
  return { eyes, masks };
}

const PNG = ok(new Uint8Array([0x89, 0x50]) as Png);

describe("screenshots fail closed (section 4 §9.11)", () => {
  test("the screenshot is taken with every box", async () => {
    const s = scriptedEyes([screen, screen], PNG);
    const shot = await maskedScreenshot(s.eyes, redactor());
    expect(shot.ok).toBe(true);
    expect(s.masks[0]?.map(String).sort()).toEqual(ids(boxedElements(screen, redactor())));
  });

  test("a stale mask refuses to save", async () => {
    const s = scriptedEyes([screen, screen], { ok: false, failure: "stale_element" });
    expect(await maskedScreenshot(s.eyes, redactor())).toEqual({
      ok: false,
      failure: "stale_mask",
    });
  });

  test("an element that needs a box and appears mid-shot refuses to save", async () => {
    const later: Observation = {
      ...screen,
      elements: [...screen.elements, el("late", { clues: { path: "p", text: "SSN 123-45-6789" } })],
    };
    const s = scriptedEyes([screen, later], PNG);
    expect(await maskedScreenshot(s.eyes, redactor())).toEqual({
      ok: false,
      failure: "screen_changed",
    });
  });

  test("an open native dialog refuses to save", async () => {
    const d: Observation = { ...screen, dialog: { kind: "confirm", message: "Close 100107?" } };
    const s = scriptedEyes([d], PNG);
    expect(await maskedScreenshot(s.eyes, redactor())).toEqual({
      ok: false,
      failure: "dialog_open",
    });
    expect(s.masks).toEqual([]);
  });
});

describe("image crops (section 4 §9.12)", () => {
  const eyes = scriptedEyes([screen], PNG).eyes;
  const crop = async (id: string, o: Observation = screen) => {
    const r = await maskedCrop(eyes, o, ref(id), redactor());
    return r.ok ? "kept" : r.failure;
  };

  test("a button and an empty input may be cropped", async () => {
    expect(await crop("v_search")).toBe("kept");
    expect(await crop("v_empty")).toBe("kept");
  });

  test("rows, cells, filled inputs, and secret fields are never cropped", async () => {
    expect(await crop("v_branch")).toBe("not_croppable");
    expect(await crop("r2_field")).toBe("not_croppable");
    expect(await crop("r3_secret")).toBe("not_croppable");
  });

  test("a crop that a mask box touches is dropped", async () => {
    const o: Observation = {
      ...screen,
      elements: [
        el("btn", {
          role: "button",
          roleGroup: "button_like",
          clues: { path: "b", name: "Go" },
          box: box(0, 0),
        }),
        el("near", { clues: { path: "p", text: "Member 100107" }, box: box(50, 10) }),
      ],
    };
    expect(await crop("btn", o)).toBe("boxed");
  });

  test("a button whose own text is masked is dropped", async () => {
    const o: Observation = {
      ...screen,
      elements: [
        el("btn", {
          role: "button",
          roleGroup: "button_like",
          clues: { path: "b", name: "Open 100107" },
        }),
      ],
    };
    expect(await crop("btn", o)).toBe("boxed");
  });

  test("without geometry, a crop is dropped", async () => {
    const o: Observation = {
      ...screen,
      elements: [
        el("btn", {
          role: "button",
          roleGroup: "button_like",
          clues: { path: "b", name: "Go" },
          box: null,
        }),
      ],
    };
    expect(await crop("btn", o)).toBe("no_box");
  });
});

describe("DOM snapshots (section 4 §9.13, section 3 §7.6)", () => {
  const html = `<!DOCTYPE html><html><head><title>Member 100107</title>
<script>var m = {id: "100107", name: "Dana Quillfeather"};</script></head>
<body onload="init()">
<!-- member 100107 Dana Quillfeather -->
<form action="/members/100107/save"><input type="hidden" name="sid" value="S-99812">
<input name="memo" value="Dana Quillfeather" placeholder="SSN 123-45-6789" title="Member Name: Dana Quillfeather">
<textarea name="n">call Dana at 555-010-4477</textarea>
<img src="/photos/100107.png" alt="Photo of member 100107"></form>
<a href="/members/100107" onclick="showMember('100107','Dana')">Open</a>
<table><thead><tr><th>Member ID</th><th>Name</th><th>Branch</th></tr></thead>
<tbody><tr><td>100107</td><td>DANA QUILLFEATHER</td><td>Main</td></tr>
</tbody></table>
<table><tr><td>Zip</td><td>02134</td></tr></table>
<p>Phone: 555-010-4477</p><p>Terms &amp; balance $1,250.00</p></body></html>`;

  const masked = maskDom(html, redactor());

  test("a DOM snapshot masks member text, strips risky parts, keeps layout, and labels table cells", () => {
    for (const raw of [
      "100107",
      "Dana",
      "DANA",
      "Quillfeather",
      "QUILLFEATHER",
      "S-99812",
      "555-010-4477",
      "123-45-6789",
      "1,250.00",
      "02134",
    ]) {
      expect(masked, raw).not.toContain(raw);
    }
    expect(masked).not.toMatch(/var m|onload|onclick|<!--|type="hidden"|value=|call /);
    expect(masked).toContain("<script></script>");
    expect(masked).toContain("<textarea");
    expect(masked).toContain('href="/members/{input.member_id}"');
    expect(masked).toContain('action="/members/{input.member_id}/save"');
    expect(masked).toMatch(/placeholder="SSN \[ssn#1\]"/);
    expect(masked).toMatch(/title="Member Name: \[name#\d\]"/);
    expect(masked).toMatch(/<td>\[name#\d\]<\/td>/);
    expect(masked).toContain("<td>Main</td>");
    expect(masked).toMatch(/<td>\[address#\d\]<\/td>/);
    expect(masked).toContain("<!DOCTYPE html>");
    expect(masked).toContain("<th>Branch</th>");
    expect(masked).toContain(">Open</a>");
    expect(masked).toContain("&amp;");
  });

});

describe("accessibility snapshots (section 4 §9.13)", () => {
  test("names and text pass the text rules; field values are dropped", () => {
    const a11y = [
      '- heading "Member 100107"',
      '- textbox "Note": call Dana at 555-010-4477',
      "- text: Member Name: DANA QUILLFEATHER",
      '- button "Search"',
      '  - link "Open 100107":',
      "    - /url: /members/100107",
    ].join("\n");
    expect(maskA11y(a11y, redactor())).toBe(
      [
        '- heading "Member {input.member_id}"',
        '- textbox "Note":',
        "- text: Member Name: [name#1]",
        '- button "Search"',
        '  - link "Open {input.member_id}":',
        "    - /url: /members/{input.member_id}",
      ].join("\n"),
    );
  });
});
