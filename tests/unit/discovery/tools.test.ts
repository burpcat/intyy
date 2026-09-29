// Proves the tool call checks: stale IDs, mask tokens, unknown outputs, value rules, formats,
// tags, and the `done` rules. Design section 6 §9, §10.1 step 4, §10.3, §12, §18 ("Tool call checks").
import { describe, expect, test } from "vitest";
import { formatDate, formatMoney } from "../../../src/core/discovery/formats.js";
import { buildScreen } from "../../../src/core/discovery/observation.js";
import {
  checkCall,
  toolDefinitions,
  type CallContext,
  type Progress,
} from "../../../src/core/discovery/tools.js";
import { RunSpec } from "../../../src/core/model/runspec.js";
import { el, redactor, ref, screen } from "./kit.js";

/** A commits spec with one input, one date input, and one output. */
const SPEC = RunSpec.parse({
  schema: "intyy.runspec/1.0",
  kind: "discovery",
  caller: { tenant: "keystone", agent_id: "op_017" },
  app: "kvfcu",
  capability: "open_share_subaccount",
  goal: "Open a share sub-account for {input.member_id} on {input.open_date}.",
  inputs: [
    {
      name: "member_id",
      type: "string",
      description: "Member",
      sensitivity: "pii",
      example: "100107",
    },
    {
      name: "open_date",
      type: "date",
      description: "Open date",
      sensitivity: "none",
      example: "2026-01-02",
    },
    {
      name: "deposit",
      type: "money",
      description: "Deposit",
      sensitivity: "financial",
      example: "1250.00",
    },
  ],
  outputs: [{ name: "account_number", type: "string", description: "New account" }],
  expected_effect: "commits",
  correlation: "notes",
  session: "kvfcu/sign_in@1",
  entry: "/home",
  model: "claude-sonnet-5",
  prompt: "discovery@1.0",
});

const NONE: Progress = { commits: 0, read: new Set(), readAfterCommit: new Set() };

/** A context on a screen with a field (e1), a button (e2), and a text cell (e3). */
function ctx(extra: Partial<CallContext> = {}): CallContext {
  const view = buildScreen(
    screen([
      el("f", {
        role: "textbox",
        roleGroup: "text_entry",
        clues: { path: "i", label: "Member" },
        field: { kind: "text", value: "" },
      }),
      el("b", { role: "button", roleGroup: "button_like", clues: { path: "b", name: "Search" } }),
      el("c", { role: "cell", clues: { path: "td", text: "SH12345678" } }),
    ]),
    redactor(),
  );
  return {
    spec: SPEC,
    view,
    turn: 5,
    inputs: new Map([
      ["member_id", { value: "100107", type: "string", label: "pii" }],
      ["open_date", { value: "2026-01-02", type: "date", label: "none" }],
      ["deposit", { value: "1250.00", type: "money", label: "financial" }],
    ]),
    runId: "run_2026-09-28_7kq2m9x4tb",
    formats: {
      date: ["YYYY-MM-DD", "MM/DD/YYYY", "DD-MMM-YYYY"],
      money: ["0.00", "#,##0.00", "0"],
    },
    progress: NONE,
    ...extra,
  };
}

const why = { reason: "Find the member.", expected: "Results show.", tag: "flow_step" };

/** The bad-call text, or null when the call passed. */
function badText(c: CallContext, name: string, input: unknown): string | null {
  const r = checkCall(c, name, input);
  return r.ok ? null : r.detail;
}

describe("tool list (section 6 §9.4)", () => {
  test("done is offered in positive runs and report_outcome in negative runs", () => {
    const pos = toolDefinitions("discovery").map((t) => t.name);
    const neg = toolDefinitions("negative_discovery").map((t) => t.name);
    expect(pos).toContain("done");
    expect(pos).not.toContain("report_outcome");
    expect(neg).toContain("report_outcome");
    expect(neg).not.toContain("done");
    expect(badText(ctx(), "report_outcome", { summary: "x", proof: ["e1"] })).toBe(
      "there is no tool named report_outcome.",
    );
  });

  test("each definition carries a JSON Schema object", () => {
    for (const t of toolDefinitions("discovery")) {
      expect(t.input_schema).toMatchObject({ type: "object" });
    }
  });
});

describe("screen tools", () => {
  test("a stale or unknown element ID is a bad call", () => {
    expect(badText(ctx(), "click", { element: "e9", ...why })).toBe(
      "unknown element e9. Use an ID from this turn's list.",
    );
  });

  test("a click maps to the live ref and keeps its tag facts", () => {
    const r = checkCall(ctx(), "click", { element: "e2", ...why });
    expect(r).toEqual({
      ok: true,
      value: {
        tool: "click",
        element: "e2",
        action: { type: "click", target: ref("b") },
        meta: { reason: "Find the member.", expected: "Results show.", tag: "flow_step" },
      },
    });
  });

  test("missing reason, expected, or tag is a bad call", () => {
    expect(badText(ctx(), "click", { element: "e2", reason: "x", expected: "y" })).toMatch(
      /^click tag:/,
    );
  });

  test("a correction must name an earlier turn; corrects needs the correction tag", () => {
    expect(badText(ctx(), "click", { element: "e2", ...why, tag: "correction" })).toBe(
      "a correction must name the turn it corrects in corrects.",
    );
    expect(badText(ctx(), "click", { element: "e2", ...why, corrects: 2 })).toBe(
      "corrects goes only with tag correction.",
    );
    expect(badText(ctx(), "click", { element: "e2", ...why, tag: "correction", corrects: 5 })).toBe(
      "corrects must name an earlier turn than 5.",
    );
  });

  test("select, set_checked, and press carry their own value, for the recorder (docs/decisions.md, M04)", () => {
    const picked = checkCall(ctx(), "select", { element: "e1", option: "Savings", ...why });
    expect(picked.ok && picked.value.tool === "select" ? picked.value.option : null).toBe(
      "Savings",
    );
    const checked = checkCall(ctx(), "set_checked", { element: "e1", checked: true, ...why });
    expect(checked.ok && checked.value.tool === "set_checked" ? checked.value.checked : null).toBe(
      true,
    );
    const pressed = checkCall(ctx(), "press", { key: "Enter", ...why });
    expect(pressed.ok && pressed.value.tool === "press" ? pressed.value.key : null).toBe("Enter");
  });
});

describe("type values (section 6 §9.2)", () => {
  test("an input reference types its raw value, with its label", () => {
    const r = checkCall(ctx(), "type", { element: "e1", value: "{input.member_id}", ...why });
    expect(r.ok && r.value.tool === "type" ? r.value.action : null).toEqual({
      type: "type",
      target: ref("f"),
      value: { kind: "input", ref: "input.member_id", text: "100107", label: "pii" },
    });
  });

  test("an unknown input is a bad call", () => {
    expect(badText(ctx(), "type", { element: "e1", value: "{input.nickname}", ...why })).toBe(
      "{input.nickname} is not an input of this task.",
    );
  });

  test("mask tokens pass to the gate as text; a masked select option is a bad call", () => {
    const r = checkCall(ctx(), "type", { element: "e1", value: "[name#1]", ...why });
    expect(r.ok && r.value.tool === "type" ? r.value.action : null).toMatchObject({
      value: { kind: "text", text: "[name#1]" },
    });
    expect(badText(ctx(), "select", { element: "e1", option: "[name#2]", ...why })).toBe(
      "pick an option by its words; a mask token is not a value.",
    );
  });

  test("{system.run_id} types the run ID when correlation is notes", () => {
    const r = checkCall(ctx(), "type", { element: "e1", value: "{system.run_id}", ...why });
    expect(r.ok && r.value.tool === "type" ? r.value.action : null).toMatchObject({
      value: { kind: "text", text: "run_2026-09-28_7kq2m9x4tb" },
    });
    const none = ctx({ spec: { ...SPEC, correlation: "none" } });
    expect(badText(none, "type", { element: "e1", value: "{system.run_id}", ...why })).toBe(
      "this task has no correlation note.",
    );
  });

  test("a format applies to date and money inputs only, from the policy list", () => {
    const r = checkCall(ctx(), "type", {
      element: "e1",
      value: "{input.open_date}",
      format: "MM/DD/YYYY",
      ...why,
    });
    expect(r.ok && r.value.tool === "type" ? r.value.action : null).toMatchObject({
      value: { kind: "input", text: "01/02/2026" },
    });
    expect(
      badText(ctx(), "type", {
        element: "e1",
        value: "{input.open_date}",
        format: "YYYY/MM",
        ...why,
      }),
    ).toBe("format YYYY/MM is not one of: YYYY-MM-DD, MM/DD/YYYY, DD-MMM-YYYY.");
    expect(
      badText(ctx(), "type", { element: "e1", value: "{input.member_id}", format: "0.00", ...why }),
    ).toBe("a string value takes no format.");
    expect(
      badText(ctx(), "type", { element: "e1", value: "{input.deposit}", format: "0", ...why }),
    ).toBe(null);
  });
});

describe("read (section 6 §9.3)", () => {
  test("an unknown output is a bad call", () => {
    expect(
      badText(ctx(), "read", { element: "e3", output: "balance", source: "text", ...why }),
    ).toBe("balance is not an output of this task.");
  });

  test("a listed output passes; a bad pattern does not", () => {
    expect(
      badText(ctx(), "read", { element: "e3", output: "account_number", source: "text", ...why }),
    ).toBe(null);
    expect(
      badText(ctx(), "read", {
        element: "e3",
        output: "account_number",
        source: "text",
        pattern: "(",
        ...why,
      }),
    ).toBe("pattern is not a valid regular expression.");
  });
});

describe("done (section 6 §10.3)", () => {
  const proof = { summary: "Opened.", proof: ["e3"] };

  test("proof must name elements on this screen", () => {
    expect(badText(ctx(), "done", { summary: "x", proof: ["e7"] })).toBe(
      "proof e7 is not on this screen.",
    );
  });

  test("commits: exactly one approved change, and every output read after it", () => {
    expect(badText(ctx(), "done", proof)).toBe(
      "done rejected: the one approved change has not happened.",
    );
    const before = ctx({
      progress: { commits: 1, read: new Set(["account_number"]), readAfterCommit: new Set() },
    });
    expect(badText(before, "done", proof)).toBe(
      "done rejected: read account_number after the change first.",
    );
    const after = ctx({
      progress: {
        commits: 1,
        read: new Set(["account_number"]),
        readAfterCommit: new Set(["account_number"]),
      },
    });
    expect(badText(after, "done", proof)).toBe(null);
  });

  test("read_only: every output read", () => {
    const ro = { ...SPEC, expected_effect: "read_only" as const };
    expect(badText(ctx({ spec: ro }), "done", proof)).toBe(
      "done rejected: read account_number first.",
    );
    const read = ctx({ spec: ro, progress: { ...NONE, read: new Set(["account_number"]) } });
    expect(badText(read, "done", proof)).toBe(null);
  });
});

describe("control tools", () => {
  test("wait takes 1 to 10 seconds", () => {
    expect(badText(ctx(), "wait", { reason: "loading", seconds: 3 })).toBe(null);
    expect(badText(ctx(), "wait", { reason: "loading", seconds: 30 })).toMatch(/^wait seconds:/);
  });
});

describe("display formats (section 6 §7.4)", () => {
  test("dates and money render in each listed format", () => {
    expect(formatDate("2026-01-02", "DD-MMM-YYYY")).toBe("02-Jan-2026");
    expect(formatDate("2026-01-02", "MM/DD/YY")).toBe("01/02/26");
    expect(formatMoney("1250.00", "#,##0.00")).toBe("1,250.00");
    expect(formatMoney("1250.50", "0")).toBe(null);
    expect(formatMoney("1250.00", "0")).toBe("1250");
  });
});
