// Proves draft handlers from takeovers: a saved takeover log always gives the same draft (golden);
// the class rules of section 5 §12.4 (clicks only and not irreversible: recoverable; typed text,
// an irreversible or unclassed action, or a navigation: needs_human); which takeovers draft
// nothing, and why (section 5 §12.1, section 7 §16.5); the writer keeps an existing draft; the
// CLI lists and shows drafts; and no raw typed value reaches a draft or its fixture files.
// Design section 5 §12, section 7 §16.5, section 9 §8.5; docs/decisions.md, M07. M07 task 6.
//
// To update the golden file after a deliberate change, run, then read the diff against the design:
//   UPDATE_GOLDEN=1 npx vitest run tests/unit/handoff/drafts.test.ts
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, test } from "vitest";
import { buildTakeoverDrafts, draftTakeovers, type TakeoverDraftContext } from "../../../src/core/handoff/drafts.js";
import { commands } from "../../../src/cli/commands/index.js";
import { EXIT } from "../../../src/cli/exit-codes.js";
import { wire } from "../../../src/cli/wiring.js";
import { canonicalJson } from "../../../src/core/model/canonical.js";
import { Config } from "../../../src/core/model/config.js";
import { HandlerDraft } from "../../../src/core/model/handler-draft.js";
import { FakeDraftStore, FakeEvidenceStore } from "../../../src/fakes/stores.js";
import { masked } from "../../contract/test-kinds.js";
import { call, cleanRoots, tempRoot } from "../cli/helpers.js";

afterAll(cleanRoots);

const LOGS = fileURLToPath(new URL("../../fixtures/logs/", import.meta.url));
const GOLDEN = fileURLToPath(new URL("../../fixtures/golden/takeover_popup.drafts.json", import.meta.url));
const RUN_ID = "run_2026-09-24_k3pdr4ft01";
const TENANT = "keystone";
const TROUBLE = "a11y/00007_click_search_ladder.yaml";
const SCREEN = "screens/00007_click_search_ladder.png";
const PNG = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);

type Line = Record<string, unknown>;

const A11Y_POPUP = readFileSync(`${LOGS}takeover_popup.a11y.yaml`, "utf8");
const POPUP_LOG = readFileSync(`${LOGS}takeover_popup.jsonl`, "utf8")
  .split("\n")
  .filter((l) => l.trim() !== "")
  .map((l) => JSON.parse(l) as Line);

const ctxOf = (a11y: ReadonlyMap<string, string> = new Map([[TROUBLE, A11Y_POPUP]])): TakeoverDraftContext => ({
  runId: RUN_ID,
  app: "kvfcu",
  tenant: TENANT,
  appVersion: "8.4",
  a11y,
});

// ---- Builders for variant logs ---------------------------------------------------------------

type Risk = "idempotent" | "reversible" | "irreversible";
/** One human action: the `action` line's data, and the class on the gate line before it (`null`: no gate line). */
type Act = { risk: Risk | null; data: Record<string, unknown> };

const DISMISS = { role: "button", name: "Dismiss", label: null, text: "Dismiss", region: { x: 0.45, y: 0.55, w: 0.1, h: 0.05 }, path: "dialog > button[1]", field_kind: null };
const BOX = { role: "textbox", name: null, label: null, text: null, region: null, path: "form > input[1]", field_kind: "text" };

const data = (type: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  type,
  staff_id: "op_017",
  value: null,
  option: null,
  checked: null,
  key: null,
  result: "ok",
  dispatched: true,
  transport: null,
  fingerprint: null,
  ...extra,
});
const click = (risk: Risk | null = "idempotent"): Act => ({ risk, data: data("click", { fingerprint: DISMISS }) });
const typed = (value: string, risk: Risk | null = "idempotent"): Act => ({ risk, data: data("type", { value, fingerprint: BOX }) });
const tab: Act = { risk: "idempotent", data: data("press", { key: "Tab" }) };

type Shape = {
  reason?: string;
  decision?: string | null;
  acts?: Act[];
  /** Leave out the `ladder` line that names the trouble screen. */
  noLadder?: boolean;
};

/** A takeover log in the shape of the fixture, with the actions, reason, and decision varied. */
function logOf(s: Shape): Line[] {
  const base = { run_id: RUN_ID, step: "click_search" };
  let seq = 6;
  const out: Line[] = [];
  const push = (by: string, event: string, d: Record<string, unknown>): void => {
    seq += 1;
    out.push({ ...base, seq, at: "2026-09-24T10:00:00.000Z", by, event, data: d });
  };
  if (s.noLadder !== true) push("engine", "ladder", { rung: 1, verdict: "climb", files: [TROUBLE, SCREEN] });
  push("engine", "escalation", { kind: "takeover", reason: s.reason ?? "stuck", state: "open" });
  for (const a of s.acts ?? [click()]) {
    if (a.risk !== null) push("gate", "gate", { actor: "human", action: a.data["type"], decision: "observed", risk: a.risk });
    push("human", "action", a.data);
  }
  const decision = s.decision === undefined ? "handed_back" : s.decision;
  push("human", "escalation", { kind: "takeover", reason: s.reason ?? "stuck", state: "resolved", ...(decision === null ? {} : { decision }), staff_id: "op_017" });
  return out;
}

const draftsOf = (lines: Line[], ctx = ctxOf()) => buildTakeoverDrafts(lines, ctx);
const oneDraft = (lines: Line[], ctx = ctxOf()): HandlerDraft => {
  const got = draftsOf(lines, ctx);
  const first = got.drafts[0];
  if (first === undefined) throw new Error(`no draft; skipped: ${JSON.stringify(got.skipped)}`);
  return first.draft;
};

// ---- Golden ----------------------------------------------------------------------------------

describe("golden (section 5 §12, spec: a saved takeover log always gives the same draft handler)", () => {
  test("the saved log gives the golden drafts, twice over", () => {
    const first = draftsOf(POPUP_LOG);
    const second = draftsOf(POPUP_LOG);
    expect(second).toEqual(first);

    const actual = canonicalJson({ drafts: first.drafts, skipped: first.skipped });
    if (process.env.UPDATE_GOLDEN === "1") writeFileSync(GOLDEN, `${JSON.stringify(JSON.parse(actual), null, 2)}\n`);
    const golden = canonicalJson(JSON.parse(readFileSync(GOLDEN, "utf8")) as unknown);
    expect(actual).toBe(golden);
  });

  test("the draft is the readable shape section 5 §12.2 names", () => {
    const d = oneDraft(POPUP_LOG);
    expect(HandlerDraft.safeParse(d).success).toBe(true);
    expect(d).toMatchObject({
      schema: "intyy.handler_draft/1.0",
      id: "click_search_t8",
      app: "kvfcu",
      suggested_scope: "tenant",
      source: { kind: "takeover", run_id: RUN_ID, tenant: TENANT, app_version: "8.4" },
      fixtures: { fire: "click_search_t8_fire", no_fire: [] },
    });
    // The takeover line, then each human action line, by `seq`.
    expect(d.source.seq).toEqual([8, 12, 14]);
    expect(d.handler.class).toBe("recoverable");
  });
});

// ---- Class rules (section 5 §12.4) -------------------------------------------------------------

describe("the draft's class (section 5 §12.4)", () => {
  test("only a click the gate classed idempotent: recoverable, response risk is the gate's class", () => {
    const d = oneDraft(logOf({ acts: [click("idempotent")] }));
    expect(d.handler.class).toBe("recoverable");
    if (d.handler.class !== "recoverable") throw new Error("expected recoverable");
    expect(d.handler.response).toEqual([{ type: "click", target: "dismiss_button", risk: "idempotent" }]);
    expect(d.risk_hints).toEqual([{ subject: `${RUN_ID}#10`, class: "idempotent", source: "gate" }]);
    // The detector is the dialog's name plus the acted control.
    expect(d.conditions.map((c) => c.check)).toContain("all_of");
    expect(JSON.stringify(d.conditions)).toContain("Session notice");
  });

  test("a click classed reversible is still recoverable, and the response keeps that class", () => {
    const d = oneDraft(logOf({ acts: [click("reversible")] }));
    expect(d.handler.class).toBe("recoverable");
    if (d.handler.class !== "recoverable") throw new Error("expected recoverable");
    expect(d.handler.response[0]).toMatchObject({ risk: "reversible" });
  });

  test("a click then Tab: recoverable, both replayable", () => {
    const d = oneDraft(logOf({ acts: [click(), tab] }));
    expect(d.handler.class).toBe("recoverable");
    if (d.handler.class !== "recoverable") throw new Error("expected recoverable");
    expect(d.handler.response.map((a) => a.type)).toEqual(["click", "press"]);
  });

  test.each([
    ["[human_text]", "typed text"],
    ["[secret]", "a typed secret"],
    ["{input.member_id}", "a known input"],
  ])("typing %s (%s): needs_human", (value) => {
    const d = oneDraft(logOf({ acts: [click(), typed(value)] }));
    expect(d.handler.class).toBe("needs_human");
  });

  test("an action the gate classed irreversible: needs_human", () => {
    expect(oneDraft(logOf({ acts: [click("irreversible")] })).handler.class).toBe("needs_human");
  });

  test("an action with no gate line before it counts as irreversible: needs_human", () => {
    const d = oneDraft(logOf({ acts: [click(null)] }));
    expect(d.handler.class).toBe("needs_human");
    expect(d.risk_hints[0]).toMatchObject({ class: "irreversible" });
  });

  test("a navigation: needs_human", () => {
    const nav: Act = { risk: "idempotent", data: data("navigate", { value: "/somewhere" }) };
    expect(oneDraft(logOf({ acts: [click(), nav] })).handler.class).toBe("needs_human");
  });

  test("more than five actions: needs_human", () => {
    expect(oneDraft(logOf({ acts: Array.from({ length: 6 }, () => click()) })).handler.class).toBe("needs_human");
    expect(oneDraft(logOf({ acts: Array.from({ length: 5 }, () => click()) })).handler.class).toBe("recoverable");
  });

  test("a needs_human draft carries an operator note that names the step", () => {
    const d = oneDraft(logOf({ acts: [typed("[human_text]")] }));
    if (d.handler.class !== "needs_human") throw new Error("expected needs_human");
    expect(d.handler.operator_note).toContain("click_search");
  });

  test("a heading with a mask token is not plain UI text: the detector leaves it out", () => {
    const a11y = '- heading "Hello [name#1]"\n- button "Dismiss"\n';
    const d = oneDraft(logOf({ acts: [click()] }), ctxOf(new Map([[TROUBLE, a11y]])));
    expect(JSON.stringify(d.conditions)).not.toContain("[name#1]");
    expect(JSON.stringify(d.conditions)).not.toContain("all_of");
  });
});

// ---- No draft --------------------------------------------------------------------------------

describe("takeovers that draft nothing, and why (section 5 §12.1, section 7 §16.5)", () => {
  const skipped = (lines: Line[], ctx = ctxOf()) => {
    const got = draftsOf(lines, ctx);
    expect(got.drafts).toEqual([]);
    return got.skipped.map((s) => s.reason);
  };

  test("a takeover caused by a needs_human handler", () => {
    expect(skipped(logOf({ reason: "needs_human_handler" }))).toEqual(["needs_human_handler"]);
  });

  test("a takeover caused by human input: no unknown state to detect", () => {
    expect(skipped(logOf({ reason: "unexpected_human_input" }))).toEqual(["not_unknown_state"]);
  });

  test("a takeover the human ended: the human judged it hopeless", () => {
    expect(skipped(logOf({ decision: "end_run" }))).toEqual(["ended_run"]);
  });

  test("a takeover that ended in set_outcome: it suggests an outcome, not a handler", () => {
    expect(skipped(logOf({ decision: "set_outcome" }))).toEqual(["set_outcome"]);
  });

  test("a takeover nobody resolved", () => {
    expect(skipped(logOf({ decision: null }))).toEqual(["no_decision_to_hand_back"]);
  });

  test("a handback with no human action", () => {
    expect(skipped(logOf({ acts: [] }))).toEqual(["no_actions"]);
  });

  test("no saved trouble screen: the log names none, or the file is missing", () => {
    expect(skipped(logOf({ noLadder: true }))).toEqual(["no_trouble_screen"]);
    expect(skipped(logOf({}), ctxOf(new Map()))).toEqual(["no_trouble_screen"]);
  });

  test("a screen with no plain landmark and no acted control gives no detector", () => {
    const a11y = "- text: Member Name: [name#1]\n- button \"OK\"\n";
    expect(skipped(logOf({ acts: [tab] }), ctxOf(new Map([[TROUBLE, a11y]])))).toEqual(["no_detector"]);
  });

  test("each skip names the step and the takeover's log line", () => {
    const got = draftsOf(logOf({ decision: "end_run" }));
    expect(got.skipped[0]).toMatchObject({ step: "click_search", reason: "ended_run" });
    expect(typeof got.skipped[0]?.seq).toBe("number");
  });
});

// ---- The writer --------------------------------------------------------------------------------

/** A run in a fake evidence store: the popup log and its saved screen files. */
async function seededRun(): Promise<FakeEvidenceStore> {
  const evidence = new FakeEvidenceStore();
  const created = await evidence.createRun(TENANT, RUN_ID);
  if (!created.ok) throw new Error("createRun failed");
  for (const l of POPUP_LOG) await created.value.appendEvent(masked(l));
  await created.value.writeFile(TROUBLE, masked(A11Y_POPUP));
  await created.value.writeFile(SCREEN, masked(PNG));
  return evidence;
}

const RUN = { tenant: TENANT, runId: RUN_ID, app: "kvfcu", appVersion: "8.4" };

describe("draftTakeovers writes the draft and its fire fixture", () => {
  test("writes draft.json's draft and the fixture files; a second call keeps the first", async () => {
    const evidence = await seededRun();
    const drafts = new FakeDraftStore(HandlerDraft);

    const first = await draftTakeovers({ evidence, drafts }, RUN);
    expect(first).toMatchObject({ written: ["click_search_t8"], existing: [], failed: [] });
    expect((await drafts.get("kvfcu", "click_search_t8")).ok).toBe(true);
    const files = drafts.filesOf("kvfcu", "click_search_t8");
    expect(Object.keys(files ?? {}).sort()).toEqual(["click_search_t8_fire/a11y.yaml", "click_search_t8_fire/screen.png"]);
    expect(files?.["click_search_t8_fire/a11y.yaml"]).toBe(A11Y_POPUP);
    expect(files?.["click_search_t8_fire/screen.png"]).toEqual(PNG);

    const second = await draftTakeovers({ evidence, drafts }, RUN);
    expect(second).toMatchObject({ written: [], existing: ["click_search_t8"], failed: [] });
    expect(await drafts.list()).toEqual([{ app: "kvfcu", id: "click_search_t8" }]);
  });

  test("the written draft is what buildTakeoverDrafts gives", async () => {
    const evidence = await seededRun();
    const drafts = new FakeDraftStore(HandlerDraft);
    await draftTakeovers({ evidence, drafts }, RUN);
    const got = await drafts.get("kvfcu", "click_search_t8");
    if (!got.ok) throw new Error("no draft written");
    expect(got.value).toEqual(oneDraft(POPUP_LOG));
  });

  test("a run with no qualifying takeover writes nothing", async () => {
    const evidence = new FakeEvidenceStore();
    const created = await evidence.createRun(TENANT, RUN_ID);
    if (!created.ok) throw new Error("createRun failed");
    for (const l of logOf({ decision: "end_run" })) await created.value.appendEvent(masked(l));
    await created.value.writeFile(TROUBLE, masked(A11Y_POPUP));
    const drafts = new FakeDraftStore(HandlerDraft);
    const got = await draftTakeovers({ evidence, drafts }, RUN);
    expect(got.written).toEqual([]);
    expect(got.skipped.map((s) => s.reason)).toEqual(["ended_run"]);
    expect(await drafts.list()).toEqual([]);
  });
});

// ---- Safety ------------------------------------------------------------------------------------

describe("no raw typed value reaches a draft (section 4 §8.10)", () => {
  // Made-up and distinctive: it must appear nowhere in the draft or its fixture files, even if an
  // earlier step let it into an action line.
  const RAW = "ZEBRA-4471-quokka";

  test("the draft and its fixture files never hold a typed value", async () => {
    const evidence = new FakeEvidenceStore();
    const created = await evidence.createRun(TENANT, RUN_ID);
    if (!created.ok) throw new Error("createRun failed");
    for (const l of logOf({ acts: [click(), typed(RAW)] })) await created.value.appendEvent(masked(l));
    await created.value.writeFile(TROUBLE, masked(A11Y_POPUP));
    await created.value.writeFile(SCREEN, masked(PNG));
    const drafts = new FakeDraftStore(HandlerDraft);

    const got = await draftTakeovers({ evidence, drafts }, RUN);
    expect(got.written).toHaveLength(1);
    const id = got.written[0] ?? "";
    const draft = await drafts.get("kvfcu", id);
    if (!draft.ok) throw new Error("no draft written");
    // Typed text always means needs_human, and never reaches a response action.
    expect(draft.value.handler.class).toBe("needs_human");
    const everything = [JSON.stringify(draft.value), ...Object.values(drafts.filesOf("kvfcu", id) ?? {}).map((f) => Buffer.from(f).toString("latin1"))];
    for (const text of everything) expect(text).not.toContain(RAW);
  });
});

// ---- CLI ---------------------------------------------------------------------------------------

/** A temp root with two drafts seeded straight into the real, file-backed draft store. */
async function seededRoot(): Promise<string> {
  const root = tempRoot();
  const wiring = wire(root, Config.parse(JSON.parse(readFileSync(join(root, "intyy.json"), "utf8"))), {});
  const draft = oneDraft(POPUP_LOG);
  const needsHuman = oneDraft(logOf({ acts: [typed("[human_text]")] }));
  for (const d of [draft, { ...needsHuman, id: "click_search_t99", fixtures: { fire: "click_search_t99_fire", no_fire: [] } }]) {
    const put = await wiring.drafts.put("kvfcu", d.id, d, {});
    if (!put.ok) throw new Error(`seed failed: ${put.failure}`);
  }
  return root;
}

const cli = (root: string, argv: string[]) => call(argv, { cwd: root, env: { INTYY_STAFF: "op_017" }, deps: { commands } });

describe("pack draft list | show (section 9 §8.5)", () => {
  test("list prints every draft with its source and class", async () => {
    const root = await seededRoot();
    const got = await cli(root, ["pack", "draft", "list"]);
    expect(got.code).toBe(EXIT.ok);
    expect(got.stdout).toContain("kvfcu/click_search_t8");
    expect(got.stdout).toContain("kvfcu/click_search_t99");
    expect(got.stdout).toMatch(/click_search_t8 +takeover +recoverable/);
    expect(got.stdout).toMatch(/click_search_t99 +takeover +needs_human/);
  });

  test("list --app narrows to one app", async () => {
    const root = await seededRoot();
    const none = await cli(root, ["pack", "draft", "list", "--app", "otherapp"]);
    expect(none.code).toBe(EXIT.ok);
    expect(none.stdout).toContain("no draft handlers");
  });

  test("show prints the class, source run, detector, and each response action's class", async () => {
    const root = await seededRoot();
    const got = await cli(root, ["pack", "draft", "show", "click_search_t8"]);
    expect(got.code).toBe(EXIT.ok);
    expect(got.stdout).toContain("recoverable");
    expect(got.stdout).toContain(RUN_ID);
    expect(got.stdout).toContain("response 1: click dismiss_button (idempotent)");
    expect(got.stdout).toContain("fire fixture: click_search_t8_fire");
  });

  test("show of an unknown draft exits usage", async () => {
    const root = await seededRoot();
    const got = await cli(root, ["pack", "draft", "show", "no_such_draft"]);
    expect(got.code).toBe(EXIT.usage);
    expect(got.stderr).toContain("no_such_draft");
  });
});
