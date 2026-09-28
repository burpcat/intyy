// Proves the canary scanner finds a marker four ways, and the capture helper writes only masked
// files. Design section 4 §14 ("How the canary scans work"), section 3 §7.1 and §7.4; M02 task 10.
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { FileEvidenceStore } from "../../../src/adapters/files/other-stores.js";
import { capture } from "../../../src/core/capture/capture.js";
import { Redactor, redactionRules } from "../../../src/core/safety/redaction/redactor.js";
import { scanForCanaries, type ScanFile } from "../../../src/core/safety/canary/scan.js";
import { snapshotFactory, type FakeSite } from "../../../src/fakes/snapshot-surface/index.js";
import { LEASE, gateConfig, openTestGate, testPolicy } from "../../contract/surface/gate-kit.js";
import { readTree, tempRoot } from "./canary-kit.js";

const MARKER = "CANARY-SECRET-7f9c2b1e";

/** One file holding `text`. */
const file = (path: string, text: string): ScanFile => ({ path, bytes: Buffer.from(text, "utf8") });

describe("the canary scanner (section 4 §14)", () => {
  test("finds the marker raw, and names the file and form, never the marker", () => {
    expect(scanForCanaries([file("a.txt", `x ${MARKER} y`)], [MARKER])).toEqual([
      { path: "a.txt", marker: 0, form: "raw" },
    ]);
  });

  test("finds it base64-encoded at every byte alignment, standard and URL-safe", () => {
    for (const prefix of ["", "a", "ab", "abc"]) {
      const b64 = Buffer.from(`${prefix}${MARKER}!`).toString("base64");
      const url = Buffer.from(`${prefix}${MARKER}?`).toString("base64url");
      expect(
        scanForCanaries([file("b", b64)], [MARKER]).map((h) => h.form),
        prefix,
      ).toEqual(["base64"]);
      expect(
        scanForCanaries([file("u", url)], [MARKER]).map((h) => h.form),
        prefix,
      ).toEqual(["base64"]);
    }
  });

  test("finds it URL-encoded and HTML-escaped", () => {
    const odd = "CANARY <7f9c> & 'q'";
    expect(scanForCanaries([file("u", encodeURIComponent(odd))], [odd]).map((h) => h.form)).toEqual(
      ["url"],
    );
    expect(
      scanForCanaries([file("f", "CANARY+%3C7f9c%3E+%26+'q'")], [odd]).map((h) => h.form),
    ).toEqual(["url"]);
    expect(
      scanForCanaries([file("h", "CANARY &lt;7f9c&gt; &amp; &#39;q&#39;")], [odd]).map(
        (h) => h.form,
      ),
    ).toEqual(["html"]);
    expect(
      scanForCanaries(
        [file("n", Array.from(odd, (c) => `&#${String(c.codePointAt(0))};`).join(""))],
        [odd],
      ).map((h) => h.form),
    ).toEqual(["html"]);
  });

  test("finds it inside binary bytes", () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x00, ...Buffer.from(MARKER), 0xff]);
    expect(scanForCanaries([{ path: "x.png", bytes }], [MARKER])).toHaveLength(1);
  });

  test("clean files give no hits; each marker is reported by its position", () => {
    const files = [file("clean", "nothing to see"), file("hit", "second-marker-99")];
    expect(scanForCanaries(files, [MARKER, "second-marker-99"])).toEqual([
      { path: "hit", marker: 1, form: "raw" },
    ]);
  });
});

describe("the capture helper (section 3 §7.1, §7.4)", () => {
  const ORIGIN = "http://127.0.0.1:9184";
  const policy = testPolicy({ allow: ["/"], deny: [], irreversible: [] });
  const site: FakeSite = {
    origin: ORIGIN,
    screens: {
      "/": {
        elements: [
          { id: "h", role: "heading", roleGroup: "container", text: "Member 100107 QUILLON BRASK" },
          { id: "b", role: "button", roleGroup: "button_like", name: "Search", text: "Search" },
        ],
        dom: `<html><body><h1>Member 100107</h1><script>var n="100107"</script><input value="100107"></body></html>`,
        a11y: `- heading "Member 100107"\n- textbox "Member ID": 100107`,
      },
    },
  };
  const roots: (() => Promise<void>)[] = [];
  afterAll(async () => {
    await Promise.all(roots.map((r) => r()));
  });

  test("writes masked files under screens/, dom/, and a11y/ with the log number", async () => {
    const t = await tempRoot("intyy-capture-");
    roots.push(t.remove);
    const store = new FileEvidenceStore({
      root: join(t.root, "evidence"),
      tmpDir: join(t.root, "tmp"),
    });
    const folder = await store.createRun("keystone", "run_2026-01-15_7kq2m9x4tb");
    if (!folder.ok) throw new Error("no run folder");
    const g = await openTestGate(snapshotFactory(site), gateConfig(ORIGIN, policy), policy);
    const r = new Redactor(redactionRules(policy));
    r.addKnown({
      ref: "input.member_id",
      value: "100107",
      label: "pii",
      type: "text",
      kind: "member",
    });

    const got = await capture(
      g.eyes,
      r,
      folder.value,
      { seq: 19, name: "click_search_ladder" },
      {
        screenshot: true,
        dom: true,
        a11y: true,
      },
    );
    expect(got).toEqual({
      ok: true,
      value: {
        files: [
          "screens/00019_click_search_ladder.png",
          "dom/00019_click_search_ladder.html",
          "a11y/00019_click_search_ladder.yaml",
        ],
        withheld: null,
      },
    });
    const written = await readTree(join(t.root, "evidence"));
    expect(scanForCanaries(written, ["100107"])).toEqual([]);
    const dom = written.find((f) => f.path.endsWith(".html"));
    expect(Buffer.from(dom?.bytes ?? []).toString()).toContain("Member {input.member_id}");
    await g.gate.close();
  });

  test("a screenshot that cannot be masked is withheld, and nothing is written for it", async () => {
    const t = await tempRoot("intyy-capture-");
    roots.push(t.remove);
    const store = new FileEvidenceStore({
      root: join(t.root, "evidence"),
      tmpDir: join(t.root, "tmp"),
    });
    const folder = await store.createRun("keystone", "run_2026-01-15_7kq2m9x4tc");
    if (!folder.ok) throw new Error("no run folder");
    const withDialog: FakeSite = {
      origin: ORIGIN,
      screens: {
        "/": {
          elements: [
            {
              id: "d",
              role: "button",
              roleGroup: "button_like",
              name: "Delete",
              onClick: { dialog: { kind: "confirm", message: "Delete?" } },
            },
          ],
        },
      },
    };
    const g = await openTestGate(snapshotFactory(withDialog), gateConfig(ORIGIN, policy), policy);
    const o = await g.eyes.observe();
    const del = o.ok ? o.value.elements[0]?.ref : undefined;
    if (del === undefined) throw new Error("no button");
    await g.gate.act({
      actor: "llm",
      lease: LEASE,
      action: { type: "click", target: del },
      step: null,
      approval: { by: "op_022" },
    });
    const r = new Redactor(redactionRules(policy));
    const got = await capture(
      g.eyes,
      r,
      folder.value,
      { seq: 3, name: "dialog" },
      {
        screenshot: true,
        dom: false,
        a11y: false,
      },
    );
    expect(got).toEqual({ ok: true, value: { files: [], withheld: "dialog_open" } });
    expect((await readTree(join(t.root, "evidence"))).map((f) => f.path)).not.toContain(
      expect.stringContaining("screens/"),
    );
    await g.gate.close();
  });

  test("a bad name is a bug, not a file", async () => {
    const g = await openTestGate(snapshotFactory(site), gateConfig(ORIGIN, policy), policy);
    const r = new Redactor(redactionRules(policy));
    const noFolder = {} as never;
    await expect(
      capture(
        g.eyes,
        r,
        noFolder,
        { seq: 1, name: "../escape" },
        { screenshot: true, dom: false, a11y: false },
      ),
    ).rejects.toThrow("bad capture name");
    await g.gate.close();
  });
});
