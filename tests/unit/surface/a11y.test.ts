// Proves the accessibility tree builder follows docs/formats/a11y-snapshot.md: nesting, line
// kinds, flags, escaping, and no values. Section 3 §7.6, section 4 §2.6; M02.
import { expect, test } from "vitest";
import { a11yTree } from "../../../src/core/surface/a11y.js";
import type { ElementRef, SurfaceElement } from "../../../src/ports/surface.js";

const ref = (id: string) => id as unknown as ElementRef;

/** One element with defaults. */
function el(id: string, extra: Partial<SurfaceElement> = {}): SurfaceElement {
  return {
    ref: ref(id),
    role: "button",
    roleGroup: "button_like",
    clues: { path: id },
    enabled: true,
    box: null,
    ...extra,
  };
}

test("the a11y text puts children under parents, types each line, and escapes names", () => {
  // children sit two spaces under their parent, in list order.
  {
    const tree = a11yTree([
      el("dlg", { role: "dialog", clues: { path: "d", name: "Confirm" } }),
      el("row", { role: "row", parent: ref("dlg"), clues: { path: "r", name: "Row 1" } }),
      el("ok", { parent: ref("row"), clues: { path: "o", name: "OK" } }),
      el("cancel", { parent: ref("dlg"), clues: { path: "c", name: "Cancel" } }),
    ]);
    expect(tree).toBe(
      ['- dialog "Confirm":', '  - row "Row 1":', '    - button "OK"', '  - button "Cancel"'].join(
        "\n",
      ),
    );
  }

  // a parent missing from the list makes a top element.
  {
    expect(a11yTree([el("x", { parent: ref("gone"), clues: { path: "x", name: "Go" } })])).toBe(
      '- button "Go"',
    );
  }

  // line kinds: text, generic, link url, flags, label as name.
  {
    const tree = a11yTree([
      el("t", { role: "generic", roleGroup: "container", clues: { path: "t", text: "Hello" } }),
      el("g", { role: "generic", roleGroup: "container", clues: { path: "g", text: "Outer" } }),
      el("gi", { parent: ref("g"), clues: { path: "gi", name: "In" } }),
      el("l", {
        role: "link",
        roleGroup: "navigation",
        href: "http://127.0.0.1:1/a",
        clues: { path: "l", name: "A" },
      }),
      el("c", {
        role: "checkbox",
        roleGroup: "check",
        field: { kind: "check", checked: true },
        clues: { path: "c", label: "Joint" },
      }),
      el("d", { enabled: false, clues: { path: "d", name: "Save" } }),
    ]);
    expect(tree).toBe(
      [
        "- text: Hello",
        "- generic:",
        '  - button "In"',
        '- link "A":',
        "  - /url: http://127.0.0.1:1/a",
        '- checkbox "Joint" [checked]',
        '- button "Save" [disabled]',
      ].join("\n"),
    );
  }

  // names are escaped, and field values never appear.
  {
    const tree = a11yTree([
      el("q", { clues: { path: "q", name: 'Say "hi" \\ now' } }),
      el("f", {
        role: "textbox",
        roleGroup: "text_entry",
        field: { kind: "text", value: "100107" },
        clues: { path: "f", label: "Member ID" },
      }),
      el("p", {
        role: "textbox",
        roleGroup: "text_entry",
        field: { kind: "password", filled: true },
        clues: { path: "p", label: "Password" },
      }),
    ]);
    expect(tree).toBe(
      ['- button "Say \\"hi\\" \\\\ now"', '- textbox "Member ID"', '- textbox "Password"'].join(
        "\n",
      ),
    );
  }
});
