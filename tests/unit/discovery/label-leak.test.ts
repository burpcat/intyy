// Proves the label rule holds for a legacy table all the way through a discovery run: the element
// list sent to the model, the saved accessibility snapshots, the model request files, and the
// event log hold no raw name, date of birth, or address. Design section 4 §9.7, section 6 §8.2;
// the M05 leak in docs/decisions.md. Values are made up. Seed member 100240 is the canary and
// never appears.
import { afterEach, describe, expect, test } from "vitest";
import { buildScreen } from "../../../src/core/discovery/observation.js";
import type { ScriptedPlanner } from "../../../src/fakes/scripted-planner.js";
import type { FakeElement, FakeSite } from "../../../src/fakes/snapshot-surface/index.js";
import { ADDRESS, DOB, MEMBER, NAME, RAW, SSN, leakRedactor, legacyA11y } from "../safety/label-leak-kit.js";
import { el, ref, screen } from "./kit.js";
import { ORIGIN, run, type Ran } from "./run-kit.js";

// Why short: a name is cut at 80 characters (section 6 §8.2).
const FLAT = `Name ${NAME} Date of Birth ${DOB} Address ${ADDRESS}`;

describe("D: the element list builder, labels from context.left (§9.7)", () => {
  const table = el("t", { role: "table", clues: { path: "table", name: FLAT } });
  const rows = [
    ["Name", NAME],
    ["Date of Birth", DOB],
    ["Address", ADDRESS],
  ] as const;
  const elements = [
    table,
    ...rows.flatMap(([label, value], i) => [
      el(`r${String(i)}`, { parent: ref("t"), role: "row", clues: { path: "tr", name: `${label} ${value}` } }),
      el(`l${String(i)}`, { parent: ref(`r${String(i)}`), role: "cell", clues: { path: "td", text: label } }),
      el(`v${String(i)}`, {
        parent: ref(`r${String(i)}`),
        role: "cell",
        clues: { path: "td", text: value },
        context: { left: label },
      }),
    ]),
  ];
  // Why a title with the name: it is built after the list, so the run has learned the name.
  const view = buildScreen(screen(elements, { title: `Member ${NAME}` }), leakRedactor());

  test("the element list builder holds no raw value, joins names from the same tokens, and keeps label cells readable", () => {
    {
      // the list, the title, and the row and table names hold no raw value
      const all = `${view.list}\n${view.title}\n${view.location}`;
      for (const raw of RAW) expect(all).not.toContain(raw);
    }
    {
      // the joined names read the same tokens as the cells
      expect(view.list).toContain('table "Name [name#1] Date of Birth [dob#1] Address [address#1]"');
      expect(view.list).toContain('row "Name [name#1]"');
      expect(view.list).toContain('cell "[address#1]"');
      expect(view.title).toContain("[name#1]");
    }
    {
      // the label cells stay readable
      expect(view.list).toContain('cell "Name"');
      expect(view.list).toContain('cell "Date of Birth"');
      expect(view.list).toContain('cell "Address"');
    }
  });
});

describe("E: a discovery run over a legacy page (§9.7, §9.13)", () => {
  const done: Ran[] = [];
  afterEach(async () => {
    for (const r of done.splice(0)) await r.remove();
  });

  /** The legacy page: the element tree the model sees, and the raw snapshot the surface saves. */
  const box = (y: number) => ({ x: 16, y, width: 300, height: 24 });
  const cells = (i: number, label: string, value: string): FakeElement[] => [
    { id: `r${String(i)}`, parent: "t", role: "row", roleGroup: "container", name: `${label} ${value}`, box: box(60 + i * 60) },
    { id: `l${String(i)}`, parent: `r${String(i)}`, role: "cell", roleGroup: "container", text: label, box: box(64 + i * 60) },
    {
      id: `v${String(i)}`,
      parent: `r${String(i)}`,
      role: "cell",
      roleGroup: "container",
      text: value,
      context: { left: label },
      box: box(88 + i * 60),
    },
  ];
  const site: FakeSite = {
    origin: ORIGIN,
    screens: {
      "/": {
        title: `Member ${NAME}`,
        a11y: legacyA11y(),
        elements: [
          { id: "t", role: "table", roleGroup: "container", name: FLAT, box: box(20) },
          ...cells(0, "Name", NAME),
          ...cells(1, "Date of Birth", DOB),
          ...cells(2, "Address", ADDRESS),
        ],
      },
    },
  };

  test("no raw value reaches a11y/*, llm/*, or events.jsonl", async () => {
    const r = await run({
      site,
      steps: [{ name: "done", input: { summary: "Read the page.", proof: ["e1"] } }],
    });
    done.push(r);
    const files = r.files.filter((f) => !f.path.endsWith(".png"));
    const paths = files.map((f) => f.path);
    expect(paths.some((p) => p.startsWith("a11y/"))).toBe(true);
    expect(paths.some((p) => /^llm\/.*_planner_request\.json$/.test(p))).toBe(true);
    expect(paths).toContain("events.jsonl");
    for (const f of files) {
      const text = new TextDecoder().decode(f.bytes);
      for (const raw of [...RAW, SSN, MEMBER]) {
        expect(text.includes(raw), `${f.path} holds a raw value`).toBe(false);
      }
    }
  });

  test("the saved snapshot reads the tokens, and the model was shown the page", async () => {
    const r = await run({
      site,
      steps: [{ name: "done", input: { summary: "Read the page.", proof: ["e1"] } }],
    });
    done.push(r);
    const snap = r.files.find((f) => f.path.startsWith("a11y/"));
    const text = new TextDecoder().decode(snap?.bytes);
    expect(text).toContain('- cell "[name#1]"');
    expect(text).toContain("- text: [address#1]");
    const seen = (r.planner as ScriptedPlanner).seen;
    expect(seen[0]?.message).toContain("[name#1]");
    expect(seen[0]?.message).toContain('cell "Name"');
  });
});
