# Accessibility snapshot format

> **Status:** built in M02. **Code:** `src/core/surface/a11y.ts` (`a11yTree`), masked by `maskA11y` in `src/core/safety/redaction/snapshots.ts`.
> **Follows:** section 3 §7.6 (accessibility snapshots), section 4 §2.6 and §9.13, and `docs/decisions.md` (M02).
> **Read by:** M07 draft handlers and their `fire` fixtures (section 3 §7.5, "Why capture more at rung 2").

## 1. What it is

- **Accessibility snapshot:** a text file that lists what a screen reader would announce. It shows each control's role and name, nested by containment.
- **File:** `a11y/NNNNN_<step>_<moment>.yaml` in the run folder. Example: `a11y/00019_click_search_ladder.yaml`.
- **It uses Playwright's YAML line form.** It is built by intyy, not by Playwright.

## 2. Why intyy builds it

- **Playwright's `ariaSnapshot` prints field values.** A live M02 test showed it print a typed password.
- **intyy never reads a secret-filled field's value** (section 4 §2.6). So the file comes from the eyes' own element list. That list never holds such a value.
- **The fake and the Playwright adapter share one builder.** Both backends print the same tree for the same page. The surface contract suite checks it.

## 3. Line kinds

Every line is one element. It starts with `- `.

| Line | Used for | Example |
|---|---|---|
| `- role "name"` | An element with a name, and no children | `- button "Search"` |
| `- role "name":` | The same, with children below it | `- form "Member search":` |
| `- role` | An element with no name | `- canvas` |
| `- text: words` | A text-only element with no children | `- text: Welcome back` |
| `- generic:` | A text-only element that holds children | `- generic:` |
| `- /url: address` | The child line of a plain link. It holds the link's address | `- /url: http://127.0.0.1:8080/home` |

- **Role:** the element's ARIA role, such as `button`, `textbox`, `link`, `row`, `iframe`, `alertdialog`.
- **Name:** the accessible name, else the visible label. It is in double quotes. A `"` inside is written `\"`, and a `\` is written `\\`.
- **Flags** follow the name, in brackets: `[checked]` for a ticked checkbox or radio, `[disabled]` for a control that cannot be used. Example: `- checkbox "Joint" [checked]`.

## 4. Nesting

- **Each element sits under its parent, two spaces deeper.**
- **Parent:** the nearest enclosing element in the same observation. The eyes report it as `SurfaceElement.parent`.
- **Frames:** a frame's top elements sit under the frame's `iframe` element.
- **Native dialogs:** while a browser `alert` or `confirm` box is open, only its elements appear. The OK and Cancel buttons sit under the `alertdialog` line (section 7 §9.1).
- **Pop-ups:** the snapshot shows the active window only, the newest one (section 7 §9.2).
- **Order:** siblings keep the element list's order, which is document order.
- **Missing parent:** an element whose parent is not in the list becomes a top line.

## 5. What never appears

- **Field values.** A text box shows its role and name, never what it holds. A dropdown shows no chosen option.
- **Secret-filled fields' values.** They are never read into intyy, so they cannot appear.
- **Hidden elements.** Elements with no size, or hidden by style, are not listed.
- **Frames from another host.** Their content stays unread (section 4 §2.7). Their `iframe` line stays.

## 6. Masking before the write

The raw file is masked before it is written (section 4 §9.13). `maskA11y` does this, line by line.

- **Names and text pass the text rules.** Example: `- text: Member Name: DANA QUILLFEATHER` becomes `- text: Member Name: [name#1]`.
- **Link addresses pass the text rules, like page paths.** Example: `- /url: /members/100107` becomes `- /url: /members/{input.member_id}`.
- **Anything after the name on a `textbox`, `searchbox`, `combobox`, `spinbutton`, or `slider` line is dropped.** This is a second lock: the builder writes no values there anyway.

## 7. Example

A search form, a link, a frame, and a ticked checkbox, before masking:

```yaml
- form "Member ID Password Search":
  - textbox "Member ID"
  - textbox "Password"
  - button "Search"
- link "Members":
  - /url: http://127.0.0.1:8080/members
- iframe "help":
  - button "Help"
- checkbox "Joint" [checked]
```

The same page while a confirm box is open:

```yaml
- alertdialog "Delete member?":
  - button "OK"
  - button "Cancel"
```

## 8. For M07: matching a trouble screen

- **A draft handler may test structure.** Example: "an `alertdialog` holds a `button "OK"`" means an OK line two spaces under an `alertdialog` line.
- **Match masked files only.** Handlers and fixtures read what the run wrote, after `maskA11y`.
- **Do not match on indent width alone across versions.** Parse lines into a tree: depth is leading spaces divided by two.

## 9. Known limits

- **The name is a short form.** It follows the common ARIA name sources, not the full name algorithm.
- **Label elements are not listed.** A field's visible label becomes the field's name instead.
- **Only text-bearing or interactive elements are listed.** A plain wrapper `<div>` with no text of its own does not appear, so its children move up to the nearest listed parent.
