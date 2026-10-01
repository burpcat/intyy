// Proves discovery logs each successful `read` as an `action` line (tool `read`, with output,
// source, pattern, and the control's fingerprint) before its `extract` line, and that the raw
// value read never lands in events.jsonl or a crop. Also proves `run.json` records the spec name
// the caller gives, and defaults to `<app>/<capability>`.
// Design section 6 §14.7, §14.8, §13.1 (fingerprint); section 4 §9.6 (a read value is masked);
// docs/decisions.md, M05.
import { afterEach, describe, expect, test } from "vitest";
import { RunSpec } from "../../../src/core/model/runspec.js";
import type { FakeSite } from "../../../src/fakes/snapshot-surface/index.js";
import { ORIGIN, SIGN_IN, SIGN_IN_STEPS, run, type Ran } from "./run-kit.js";

const done: Ran[] = [];
afterEach(async () => {
  for (const r of done.splice(0)) await r.remove();
});

/** A value no mask rule would catch by shape, so only the known-value rule can hide it. */
const RAW = "Kestrel-Maple-Orchard";

/** The value in a plain cell, and in a button-like control, the one kind a crop may be kept for. */
const cell = {
  id: "acct",
  role: "cell",
  roleGroup: "container" as const,
  text: RAW,
  box: { x: 20, y: 20, width: 160, height: 24 },
};
const button = {
  id: "acct",
  role: "button",
  roleGroup: "button_like" as const,
  name: RAW,
  box: { x: 20, y: 20, width: 160, height: 24 },
};
const siteWith = (element: typeof cell | typeof button): FakeSite => ({
  origin: ORIGIN,
  screens: { "/": { title: "Account", elements: [element] } },
});
const SITE_WITH_VALUE = siteWith(cell);

const SPEC = RunSpec.parse({
  ...SIGN_IN,
  capability: "find_member",
  goal: "Read the account name.",
  outputs: [{ name: "account_name", type: "string", description: "The account name" }],
});

const why = { reason: "Read it.", expected: "The name is read.", tag: "flow_step" };
const steps = [
  { name: "read", input: { element: "e1", output: "account_name", source: "text", ...why } },
  { name: "done", input: { summary: "Read.", proof: ["e1"] } },
];

async function go(opts: Parameters<typeof run>[0]): Promise<Ran> {
  const r = await run(opts);
  done.push(r);
  return r;
}

const textOf = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

describe("a successful read in discovery", () => {
  test("logs a read action line with a fingerprint, before the extract line", async () => {
    const r = await go({ spec: SPEC, steps, site: SITE_WITH_VALUE });
    expect(r.result.status).toBe("success");
    const action = r.events.findIndex(
      (e) => e.event === "action" && (e.data as { type: string }).type === "read",
    );
    const extract = r.events.findIndex((e) => e.event === "extract");
    expect(action).toBeGreaterThanOrEqual(0);
    expect(action).toBeLessThan(extract);
    const data = (r.events[action] as { data: Record<string, unknown> }).data;
    expect(data).toMatchObject({
      type: "read",
      output: "account_name",
      source: "text",
      pattern: null,
      dispatched: false,
      result: "ok",
      fingerprint: { role: "cell" },
    });
    expect(data.fingerprint).not.toBeNull();
  });

  test.each([
    ["a cell", cell],
    ["a button-like control", button],
  ])("the raw value never appears in events.jsonl or in a crop, reading %s", async (_name, element) => {
    const r = await go({ spec: SPEC, steps, site: siteWith(element) });
    expect(r.result.status).toBe("success");
    const events = r.files.find((f) => f.path === "events.jsonl");
    expect(events).toBeDefined();
    expect(textOf(events?.bytes ?? new Uint8Array())).not.toContain(RAW);
    const action = r.events.find(
      (e) => e.event === "action" && (e.data as { type: string }).type === "read",
    ) as { data: { fingerprint: { text: string | null; name: string | null; crop: string | null } } };
    for (const clue of [action.data.fingerprint.text, action.data.fingerprint.name]) {
      expect(clue === null || clue === "{output.account_name}").toBe(true);
    }
    // Any crop the run kept holds no raw value. A control the crop rules skip keeps none.
    for (const c of r.files.filter((f) => f.path.startsWith("crops/"))) {
      expect(textOf(c.bytes)).not.toContain(RAW);
    }
    const kept = action.data.fingerprint.crop;
    expect(kept === null || r.files.some((f) => f.path === kept)).toBe(true);
  });
});

describe("the spec name in run.json", () => {
  const runJsonOf = (r: Ran): { spec?: string } => {
    const f = r.files.find((x) => x.path === "run.json");
    return JSON.parse(textOf(f?.bytes ?? new Uint8Array())) as { spec?: string };
  };

  test("defaults to <app>/<capability>", async () => {
    const r = await go({ steps: SIGN_IN_STEPS });
    expect(runJsonOf(r).spec).toBe("kvfcu/sign_in");
  });

  test("is the name the caller gives, variant suffix and all", async () => {
    const r = await go({ steps: SIGN_IN_STEPS, specName: "kvfcu/sign_in.missing" });
    expect(runJsonOf(r).spec).toBe("kvfcu/sign_in.missing");
  });
});
