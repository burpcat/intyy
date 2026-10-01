// Proves the view jev and the reviewer get holds no canary value: a ladder run on a screen that
// shows the canary member as text, a table cell, and a link. A scan of every stored llm/ file and
// every other run file finds none, in any of four forms. A planted control proves the scan reads
// llm/. jev's request has no element IDs and no screenshot; the reviewer's has IDs, and a
// screenshot only when `send_screenshots` is on. Each request is stored before its reply.
// Design section 4 §7.9, §10.8, §14; section 5 §10.2, §11.1; section 9 §5.3. M09 task 7.
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, test } from "vitest";
import { Config } from "../../../src/core/model/config.js";
import { runReplay } from "../../../src/core/replay/executor.js";
import { scanForCanaries, type ScanFile } from "../../../src/core/safety/canary/scan.js";
import { FakeOperator } from "../../../src/fakes/operator.js";
import type { FakeElement, FakeSite } from "../../../src/fakes/snapshot-surface/index.js";
import { TableClassifier } from "../../../src/fakes/table-classifier.js";
import { TableReviewer } from "../../../src/fakes/table-reviewer.js";
import type { ReviewerInput } from "../../../src/ports/models.js";
import {
  ORIGIN,
  TENANT,
  authorizationFor,
  buildHarness,
  replayInputOf,
  requestOf,
} from "./executor-harness.js";

// Why from config: the canary never appears as a literal in tests (CLAUDE.md).
const CANARY = Config.parse(JSON.parse(readFileSync("intyy.json", "utf8"))).canary_members[0] ?? "";
const AUTH = authorizationFor("kvfcu/open_sub@1");

const LOGIN: FakeElement = { id: "login_button", role: "button", roleGroup: "button_like", name: "Login", text: "Login", onClick: { go: "/home" } };
const BOX: FakeElement = { id: "member_id_box", role: "textbox", roleGroup: "text_entry", label: "Member ID", field: { kind: "text", value: "" } };
const SEARCH: FakeElement = { id: "search_button", role: "button", roleGroup: "button_like", name: "Search", text: "Search", onClick: { go: "/result" } };
const CONFIRM: FakeElement = { id: "confirm_button", role: "button", roleGroup: "button_like", name: "Confirm", text: "Confirm", onClick: { go: "/done" } };
const DONE: FakeElement = { id: "account_number_display", role: "generic", roleGroup: "container", label: "Account number", text: "SH1234567" };

/** The first `/home` load shows a notice, the canary three ways, and a Close button, but no
 * Member ID box, so `type_member_id` is stuck. Close reloads `/home`, and the box is there. */
function site(): FakeSite {
  let visits = 0;
  const notice: FakeElement[] = [
    { id: "notice", role: "generic", roleGroup: "container", text: `Branch review pending for member ${CANARY}` },
    { id: "t", role: "table", roleGroup: "container", name: "Recent" },
    { id: "c", parent: "t", role: "cell", roleGroup: "container", text: CANARY, context: { column: "Member ID" } },
    { id: "l", role: "link", roleGroup: "navigation", name: `Open ${CANARY}`, href: `/members/${CANARY}` },
    { id: "close", role: "button", roleGroup: "button_like", name: "Close", text: "Close", onClick: { go: "/home" } },
  ];
  return {
    origin: ORIGIN,
    screens: {
      "/": { elements: [LOGIN] },
      get "/home"() {
        visits += 1;
        return { elements: visits === 1 ? notice : [BOX, SEARCH] };
      },
      "/result": { elements: [CONFIRM] },
      "/done": { elements: [DONE] },
    },
  };
}

type Harness = Awaited<ReturnType<typeof buildHarness>>;

/** Every file of a finished run: events.jsonl, run.json, and each file run.json lists. */
async function runFiles(h: Harness, runId: string): Promise<ScanFile[]> {
  const folder = await h.deps.evidence.openRun(TENANT, runId);
  const json = await h.deps.evidence.readRunJson(TENANT, runId);
  if (!folder.ok || !json.ok) throw new Error("run missing");
  const listed = (json.value as { files: { path: string }[] }).files.map((f) => f.path);
  const out: ScanFile[] = [{ path: "run.json", bytes: new TextEncoder().encode(JSON.stringify(json.value)) }];
  for (const path of new Set(["events.jsonl", ...listed])) {
    const got = await folder.value.readFile(path);
    if (got.ok) out.push({ path, bytes: got.value });
  }
  return out;
}

const text = (f: ScanFile | undefined): string => new TextDecoder().decode(f?.bytes);

/** One ladder run: jev says needs_review, the reviewer clicks Close, the run recovers. */
async function ladderRun(sendScreenshots: boolean) {
  // Probe: the ID the reviewer sees for Close.
  const probe = new TableReviewer({ fixStep: [{ when: {}, reply: { answer: { give_up: true, reason: "no" } } }] });
  const op = new FakeOperator([{ staff: "op_017", decision: "approved" }, { staff: "op_017", decision: "end_run" }]);
  const ph = await buildHarness(site(), { models: { reviewer: probe }, operator: () => op });
  await runReplay(replayInputOf(ph, requestOf({ authorization: AUTH, inputs: { member_id: CANARY } })), ph.deps);
  const seen = probe.seen[0]?.input as ReviewerInput | undefined;
  const closeId = seen?.screen.elements.find((e) => e.name === "Close")?.id ?? "";
  expect(closeId).toMatch(/^e\d+$/);

  const jev = new TableClassifier({
    trouble: [{ when: {}, reply: { answer: { bucket: "needs_review", handler: null, outcome: null, confidence: 0.5 } } }],
  });
  const reviewer = new TableReviewer({
    fixStep: [{ when: {}, reply: { answer: { action: { type: "click", element: closeId }, reason: "A notice covers the page.", expected: "The box shows." } } }],
  });
  const h = await buildHarness(site(), { models: { classifier: jev, reviewer } });
  const base = replayInputOf(h, requestOf({ authorization: AUTH, inputs: { member_id: CANARY } }));
  const input = { ...base, policy: { ...h.policy, effective: { ...h.policy.effective, llm: { ...h.policy.effective.llm, send_screenshots: sendScreenshots } } } };
  const { runId, result } = await runReplay(input, h.deps);
  return { h, runId, result, files: await runFiles(h, runId), jev, reviewer };
}

let on: Awaited<ReturnType<typeof ladderRun>>;
let off: Awaited<ReturnType<typeof ladderRun>>;
beforeAll(async () => {
  on = await ladderRun(true);
  off = await ladderRun(false);
});

const llmOf = (r: { files: ScanFile[] }) => r.files.filter((f) => f.path.startsWith("llm/"));

describe("the run drove both rungs, with the canary on screen", () => {
  test("jev said needs_review, the reviewer's click recovered, and four llm/ files exist", () => {
    expect(CANARY).toMatch(/^\d+$/);
    expect(on.result.status).toBe("success");
    expect(on.jev.seen).toHaveLength(1);
    expect(on.reviewer.seen).toHaveLength(1);
    expect(llmOf(on).map((f) => f.path)).toEqual([
      expect.stringMatching(/_jev_request\.json$/),
      expect.stringMatching(/_jev_reply\.json$/),
      expect.stringMatching(/_reviewer_request\.json$/),
      expect.stringMatching(/_reviewer_reply\.json$/),
    ]);
  });

  test("the screen's text did reach the requests, as masked references", () => {
    const jevReq = text(llmOf(on)[0]);
    expect(jevReq).toContain("Branch review pending");
    expect(jevReq).toContain("{input.member_id}");
  });
});

describe("no canary in any stored file (section 4 §10, §14)", () => {
  test("every llm/ file and every other run file is clean in all four forms", () => {
    for (const r of [on, off]) expect(scanForCanaries(r.files, [CANARY])).toEqual([]);
  });

  test("a planted control under llm/ is found, so a clean scan means clean", () => {
    const planted = [...on.files, { path: "llm/99999_planted.json", bytes: new TextEncoder().encode(`{"x":"${CANARY}"}`) }];
    expect(scanForCanaries(planted, [CANARY])).toEqual([{ path: "llm/99999_planted.json", marker: 0, form: "raw" }]);
    expect(scanForCanaries(on.files, [CANARY])).toEqual([]);
  });

  test("the planted control is also found in the other three forms", () => {
    const forms = [
      Buffer.from(CANARY).toString("base64"),
      encodeURIComponent(CANARY),
      CANARY.split("").map((c) => `&#${String(c.codePointAt(0))};`).join(""),
    ];
    for (const form of forms) {
      const planted = [{ path: "llm/99999_planted.json", bytes: new TextEncoder().encode(form) }];
      expect(scanForCanaries(planted, [CANARY])).toHaveLength(1);
    }
  });
});

describe("what each model sees (section 4 §10.8)", () => {
  test("jev's request has no element id and no screenshot", () => {
    for (const r of [on, off]) {
      const raw = text(llmOf(r)[0]);
      const req = JSON.parse(raw) as { screen: { elements: Record<string, unknown>[] } };
      expect(req.screen.elements.length).toBeGreaterThan(0);
      for (const e of req.screen.elements) expect(Object.keys(e)).not.toContain("id");
      expect(raw).not.toContain('"screenshot"');
    }
  });

  test("the reviewer's request has an id on every element, and a screenshot when send_screenshots is on", () => {
    const req = JSON.parse(text(llmOf(on)[2])) as { screen: { elements: { id?: unknown }[] }; screenshot: string | null };
    expect(req.screen.elements.length).toBeGreaterThan(0);
    for (const e of req.screen.elements) expect(e.id).toMatch(/^e\d+$/);
    expect(typeof req.screenshot).toBe("string");
    expect(req.screenshot?.length).toBeGreaterThan(0);
  });

  test("send_screenshots off: the reviewer's screenshot is null, and ids stay", () => {
    const req = JSON.parse(text(llmOf(off)[2])) as { screen: { elements: { id?: unknown }[] }; screenshot: string | null };
    expect(req.screenshot).toBeNull();
    for (const e of req.screen.elements) expect(e.id).toMatch(/^e\d+$/);
  });
});

describe("request before reply (section 9 §5.3)", () => {
  test("each request is stored before its reply, and holds what the model was sent", () => {
    const names = llmOf(on).map((f) => f.path);
    for (const who of ["jev", "reviewer"]) {
      const req = names.findIndex((p) => p.endsWith(`_${who}_request.json`));
      const rep = names.findIndex((p) => p.endsWith(`_${who}_reply.json`));
      expect(req).toBeGreaterThanOrEqual(0);
      expect(req).toBeLessThan(rep);
    }
    expect(text(llmOf(on)[0])).toBe(JSON.stringify(on.jev.seen[0]?.input));
    expect(text(llmOf(on)[2])).toBe(JSON.stringify(on.reviewer.seen[0]?.input));
  });
});
