// The secret canary: a scripted run on the snapshot fake types a marked fake secret, logs every
// gate line, captures every screen, and writes run.json. Then a scan of every written file finds
// the marker in none of them, in any of four forms.
// Design section 4 §14 ("Secret canary", "How the canary scans work"); M02 task 11.
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";
import { FileEvidenceStore } from "../../../src/adapters/files/other-stores.js";
import { capture } from "../../../src/core/capture/capture.js";
import { scanForCanaries } from "../../../src/core/safety/canary/scan.js";
import type { GateAction, GateLine } from "../../../src/core/safety/gate/gate.js";
import { Redactor, redactionRules } from "../../../src/core/safety/redaction/redactor.js";
import { MapSecrets } from "../../../src/fakes/secrets.js";
import { snapshotFactory, type FakeSite } from "../../../src/fakes/snapshot-surface/index.js";
import type { Eyes } from "../../../src/ports/surface.js";
import {
  DISCOVERY,
  LEASE,
  gateConfig,
  openTestGate,
  testPolicy,
  testSecrets,
} from "../../contract/surface/gate-kit.js";
import { readTree, tempRoot } from "./canary-kit.js";

/** The marker. A fake secret value that appears nowhere else. */
const MARKER = "CANARY-SECRET-7f9c2b1e";

const ORIGIN = "http://127.0.0.1:9185";
const RUN = "run_2026-01-15_c4n4ry7x2q";

const policy = testPolicy(
  { allow: ["/", "/login", "/home"], deny: [], irreversible: [] },
  {
    operator_username: { kind: "username", paths: ["/login"] },
    operator_password: { kind: "password", paths: ["/login"] },
  },
);

const site: FakeSite = {
  origin: ORIGIN,
  screens: {
    "/": {
      elements: [
        { id: "go", role: "link", roleGroup: "navigation", name: "Sign in", href: "/login" },
      ],
    },
    "/login": {
      elements: [
        {
          id: "user",
          role: "textbox",
          roleGroup: "text_entry",
          label: "Username",
          field: { kind: "text", value: "" },
          form: { id: "login", submits: false },
        },
        {
          id: "pass",
          role: "textbox",
          roleGroup: "text_entry",
          label: "Password",
          field: { kind: "password", value: "" },
          form: { id: "login", submits: false },
        },
        {
          id: "submit",
          role: "button",
          roleGroup: "button_like",
          name: "Sign in",
          form: { id: "login", submits: true },
          onClick: { go: "/home" },
        },
      ],
    },
    "/home": { elements: [{ id: "h", role: "heading", roleGroup: "container", text: "Welcome" }] },
  },
};

const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => {
  await Promise.all(cleanups.map((c) => c()));
});

/** The ref of the element with this name or label. */
async function refOf(eyes: Eyes, name: string) {
  const o = await eyes.observe();
  const el = o.ok
    ? o.value.elements.find((e) => e.clues.name === name || e.clues.label === name)
    : undefined;
  if (el === undefined) throw new Error(`no element ${name}`);
  return el.ref;
}

test("the secret canary never reaches any file", async () => {
  const t = await tempRoot("intyy-canary-");
  cleanups.push(t.remove);
  const evidence = join(t.root, "evidence");
  const store = new FileEvidenceStore({ root: evidence, tmpDir: join(t.root, "tmp") });
  const created = await store.createRun("keystone", RUN);
  if (!created.ok) throw new Error("no run folder");
  const folder = created.value;

  const secrets = {
    ...testSecrets(policy),
    port: new MapSecrets({
      INTYY_TEST_OPERATOR_USERNAME: "teller-test",
      INTYY_TEST_OPERATOR_PASSWORD: MARKER,
    }),
  };
  const g = await openTestGate(
    snapshotFactory(site),
    gateConfig(ORIGIN, policy),
    policy,
    DISCOVERY,
    secrets,
  );
  const r = new Redactor(redactionRules(policy));
  let seq = 0;
  let written = 0;

  /** Writes the gate lines the gate has logged since the last call, masked. */
  const flush = async (): Promise<void> => {
    for (const line of g.lines.slice(written)) {
      seq += 1;
      const w = await folder.appendEvent(r.value<GateLine & { seq: number }>({ ...line, seq }));
      if (!w.ok) throw new Error("event write failed");
    }
    written = g.lines.length;
  };
  /** Proposes one action as the discovery LLM, then logs and captures the screen. */
  const step = async (name: string, action: GateAction): Promise<string> => {
    const res = await g.gate.act({ actor: "llm", lease: LEASE, action, step: name });
    await flush();
    const c = await capture(
      g.eyes,
      r,
      folder,
      { seq, name },
      { screenshot: true, dom: true, a11y: true },
    );
    if (!c.ok) throw new Error("capture failed");
    return res.ok ? `${res.value.decision} ${res.value.rule}` : res.failure;
  };

  // The scripted run: log in, with two refused attempts along the way.
  expect(await step("open_login", { type: "click", target: await refOf(g.eyes, "Sign in") })).toBe(
    "allowed risk.allowed",
  );
  const user = await refOf(g.eyes, "Username");
  expect(
    await step("type_username", {
      type: "type",
      target: user,
      value: { kind: "secret", name: "operator_username" },
    }),
  ).toBe("allowed risk.allowed");
  expect(
    await step("type_password_joined", {
      type: "type",
      target: await refOf(g.eyes, "Password"),
      value: { kind: "text", text: `pw={secret.operator_password}` },
    }),
  ).toBe("blocked secret.whole_value");
  expect(
    await step("type_password_wrong_field", {
      type: "type",
      target: await refOf(g.eyes, "Username"),
      value: { kind: "secret", name: "operator_password" },
    }),
  ).toBe("blocked secret.field_kind");
  expect(
    await step("type_password", {
      type: "type",
      target: await refOf(g.eyes, "Password"),
      value: { kind: "secret", name: "operator_password" },
    }),
  ).toBe("allowed risk.allowed");
  expect(
    await step("submit_login", {
      type: "press",
      key: "Enter",
      target: await refOf(g.eyes, "Password"),
    }),
  ).toBe("allowed risk.allowed");
  const run = await folder.writeRunJson(r.value({ run_id: RUN, status: "success", steps: seq }));
  if (!run.ok) throw new Error("run.json write failed");
  await g.gate.close();

  const files = await readTree(evidence);
  // Why: prove the scan read what the run wrote, so an empty result means clean, not missed.
  expect(files.map((f) => f.path)).toEqual(
    expect.arrayContaining([
      `keystone/runs/${RUN}/events.jsonl`,
      `keystone/runs/${RUN}/run.json`,
      `keystone/runs/${RUN}/screens/00005_type_password.png`,
      `keystone/runs/${RUN}/dom/00005_type_password.html`,
      `keystone/runs/${RUN}/a11y/00005_type_password.yaml`,
    ]),
  );
  expect(files.length).toBeGreaterThanOrEqual(20);
  expect(scanForCanaries(files, [MARKER])).toEqual([]);
  // A control: the scan does find the marker when it is present.
  expect(
    scanForCanaries(
      [...files, { path: "planted", bytes: Buffer.from(btoa(`x${MARKER}`)) }],
      [MARKER],
    ),
  ).toEqual([{ path: "planted", marker: 0, form: "base64" }]);
});
