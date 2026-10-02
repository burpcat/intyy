// Proves the staff, policy, and settings commands end to end in a temporary data root:
// check, seal, approve, four eyes, roles, a changed file, edit, effective, and secrets.
// Design section 9 §6.4, §7.5, §7.7, §8.6; section 4 §4, §5, §8.4; M01 test gate.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { commands } from "../../../src/cli/commands/index.js";
import { EXIT } from "../../../src/cli/exit-codes.js";
import { globalExample, settingsExample, tenantExample } from "../../fixtures/design-examples.js";
import { call as rawCall, cleanRoots, tempRoot } from "./helpers.js";

afterAll(cleanRoots);

/** Runs a real command as `staff`. */
function call(
  root: string,
  staff: string | null,
  argv: string[],
  env: Record<string, string> = {},
) {
  return rawCall(argv, {
    cwd: root,
    env: staff === null ? env : { INTYY_STAFF: staff, ...env },
    deps: { commands },
  });
}

/** An example as a revision 1 candidate, without its approval. */
function candidate(
  example: object,
  edit?: (d: Record<string, unknown>) => void,
): Record<string, unknown> {
  const d = structuredClone(example) as Record<string, unknown>;
  delete d.approved;
  d.revision = 1;
  edit?.(d);
  return d;
}

/** Writes a candidate file where the store keeps it. */
function putFile(root: string, path: string, doc: unknown): void {
  const full = join(root, "library", path);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, `${JSON.stringify(doc, null, 2)}\n`);
}

/** A root with global and keystone candidates, like task 13 drafts them. */
function draftedRoot(): string {
  const root = tempRoot();
  putFile(root, "policy/global/1.candidate.json", candidate(globalExample));
  putFile(
    root,
    "policy/tenant/keystone/1.candidate.json",
    candidate(tenantExample, (d) => {
      d.capabilities = { allow: ["kvfcu/sign_in@1"] };
      delete d.apps;
      delete d.evidence;
      delete d.discovery;
      delete d.approvals;
    }),
  );
  putFile(root, "settings/keystone/1.candidate.json", candidate(settingsExample()));
  return root;
}

describe("staff", () => {
  test("whoami prints the staff ID and its roles, refuses no or unknown IDs; check fails a tenant with no approver", async () => {
    const r = await call(tempRoot(), "op_017", ["staff", "whoami"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("op_017\n  *: operator, reviewer\n");
    const json = await call(tempRoot(), "op_022", ["staff", "whoami", "--json"]);
    expect(JSON.parse(json.stdout)).toEqual({
      id: "op_022",
      roles: { keystone: ["approver"], lakeshore: ["approver"], "*": ["operator", "reviewer"] },
    });

    // whoami with no staff ID is a usage error; an unknown ID is refused
    expect((await call(tempRoot(), null, ["staff", "whoami"])).code).toBe(EXIT.usage);
    expect((await call(tempRoot(), "op_999", ["staff", "whoami"])).code).toBe(EXIT.refused);

    // check passes the build plan staff file and fails a tenant with no approver
    const root = tempRoot();
    expect((await call(root, null, ["staff", "check"])).code).toBe(0);
    putFile(root, "staff.json", {
      schema: "intyy.staff/1.0",
      staff: [{ id: "op_017", roles: { keystone: ["operator", "reviewer"] } }],
    });
    const bad = await call(root, null, ["staff", "check"]);
    expect(bad.code).toBe(EXIT.invalid);
    expect(bad.stderr).toContain("tenant keystone has no approver");
  });
});

describe("policy", () => {
  test("check validates the candidates and tenant is checked against global; a loosening candidate fails check and seal with exit 7", async () => {
    const root = draftedRoot();
    const g = await call(root, null, ["policy", "check", "global"]);
    expect(g.code).toBe(0);
    expect(g.stdout).toBe("policy global 1 (candidate) is valid.\n");
    const t = await call(root, null, ["policy", "check", "tenant:keystone"]);
    expect(t.stdout).toBe(
      "policy tenant:keystone 1 (candidate) is valid. Checked against global 1 (candidate).\n",
    );

    // a loosening candidate fails check and seal with exit 7, naming the field
    putFile(
      root,
      "policy/tenant/keystone/1.candidate.json",
      candidate(tenantExample, (d) => {
        d.escalation = { approval_minutes: 500 };
        delete d.evidence;
        delete d.discovery;
      }),
    );
    const r = await call(root, "op_017", ["policy", "check", "tenant:keystone"]);
    expect(r.code).toBe(EXIT.invalid);
    expect(r.stderr).toContain(
      "escalation.approval_minutes: 500 is outside 5 to 120 set by global",
    );
    expect((await call(root, "op_017", ["policy", "seal", "tenant:keystone"])).code).toBe(
      EXIT.invalid,
    );
  });

  test("roles and revisions are checked; seal writes the index; four eyes refuses the sealer; the right approver approves", async () => {
    const root = draftedRoot();
    // effective with no approved global layer exits 7
    expect((await call(root, null, ["policy", "effective"])).code).toBe(EXIT.invalid);

    // sealing needs the reviewer role; an unknown revision is a usage error
    expect((await call(root, "op_031", ["policy", "seal", "global"])).code).toBe(EXIT.refused);
    expect((await call(root, "op_031", ["policy", "approve", "global", "--rev", "9"])).code).toBe(
      EXIT.usage,
    );
    expect((await call(root, "op_031", ["policy", "approve", "global"])).code).toBe(EXIT.usage);
    expect((await call(root, "op_017", ["policy", "check", "bank:x"])).code).toBe(EXIT.usage);

    const sealed = await call(root, "op_017", ["policy", "seal", "global", "--json"]);
    expect(sealed.code).toBe(0);
    expect(JSON.parse(sealed.stdout)).toMatchObject({
      document: "policy global",
      rev: "1",
      sealed_by: "op_017",
    });
    const index = readFileSync(join(root, "library", "policy", "index.jsonl"), "utf8")
      .trim()
      .split("\n");
    expect(index).toHaveLength(1);
    expect(JSON.parse(index[0] ?? "")).toMatchObject({
      event: "sealed",
      id: "global",
      rev: "1",
      by: "op_017",
    });

    // op_017 has no approver role at all; the role check refuses first.
    expect((await call(root, "op_017", ["policy", "approve", "global", "--rev", "1"])).code).toBe(
      EXIT.refused,
    );
    // op_022 approves only at keystone and lakeshore, and the global layer needs `*`.
    const wrongScope = await call(root, "op_022", ["policy", "approve", "global", "--rev", "1"]);
    expect(wrongScope.code).toBe(EXIT.refused);
    expect(wrongScope.stderr).toContain("lacks the approver role for every tenant (*)");
    const ok = await call(root, "op_031", ["policy", "approve", "global", "--rev", "1"]);
    expect(ok.code).toBe(0);
    expect(ok.stdout).toBe("policy global 1 approved by op_031.\n");
    const again = await call(root, "op_031", ["policy", "approve", "global", "--rev", "1"]);
    expect(again.code).toBe(EXIT.refused);
    expect(again.stderr).toContain("already approved");

    // four eyes: an approver who sealed may not approve, exit 6
    // op_022 is reviewer on `*` and approver at keystone, so it may seal the tenant layer.
    expect((await call(root, "op_022", ["policy", "seal", "tenant:keystone"])).code).toBe(0);
    const r = await call(root, "op_022", ["policy", "approve", "tenant:keystone", "--rev", "1"]);
    expect(r.code).toBe(EXIT.refused);
    expect(r.stderr).toContain("four eyes: op_022 sealed policy tenant:keystone 1");
  });

  test("effective merges the approved layers and names the missing app layer; a changed sealed file fails to load with exit 7", async () => {
    const root = draftedRoot();
    await call(root, "op_017", ["policy", "seal", "global"]);
    await call(root, "op_031", ["policy", "approve", "global", "--rev", "1"]);
    await call(root, "op_017", ["policy", "seal", "tenant:keystone"]);
    await call(root, "op_022", ["policy", "approve", "tenant:keystone", "--rev", "1"]);
    await call(root, "op_017", ["settings", "seal"]);
    await call(root, "op_022", ["settings", "approve", "--rev", "1"]);

    const r = await call(root, null, ["policy", "effective", "--json"]);
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout) as {
      layers: unknown;
      missing: unknown;
      app: unknown;
      hash: string;
    };
    expect(out.layers).toEqual({ global: 1, "tenant:keystone": 1 });
    expect(out.app).toBe("kvfcu");
    expect(out.missing).toEqual(["app:kvfcu"]);
    expect(out.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    const again = await call(root, null, ["policy", "effective", "--json"]);
    expect((JSON.parse(again.stdout) as { hash: string }).hash).toBe(out.hash);

    // a changed sealed file fails to load with exit 7
    const path = join(root, "library", "policy", "global", "1.json");
    const doc = JSON.parse(readFileSync(path, "utf8")) as { risk: { safe_words: string[] } };
    doc.risk.safe_words.push("confirm");
    writeFileSync(path, JSON.stringify(doc));
    const changed = await call(root, null, ["policy", "effective"]);
    expect(changed.code).toBe(EXIT.invalid);
    expect(changed.stderr).toContain("changed after sealing");
    expect((await call(root, null, ["policy", "check", "global"])).code).toBe(EXIT.invalid);
  });
});

describe("edit", () => {
  /** A root plus an EDITOR that copies `next` over the file it opens. */
  function withEditor(next: unknown): { root: string; env: Record<string, string> } {
    const root = draftedRoot();
    const script = join(root, "editor.mjs");
    writeFileSync(
      script,
      'import { copyFileSync } from "node:fs"; const [src, dst] = process.argv.slice(2); copyFileSync(src, dst);\n',
    );
    const src = join(root, "next.json");
    writeFileSync(src, typeof next === "string" ? next : JSON.stringify(next));
    // Why the full path: the test's environment has no PATH, so the shell cannot find `node`.
    return { root, env: { EDITOR: `"${process.execPath}" "${script}" "${src}"` } };
  }

  test("a valid edit becomes the candidate; an invalid one is kept for the author; a bad settings edit and a missing staff ID or editor are refused", async () => {
    // a valid edit becomes the candidate
    const next = candidate(globalExample, (d) => (d.reason = "Edited in the test."));
    const valid = withEditor(next);
    const r = await call(valid.root, "op_017", ["policy", "edit", "global"], valid.env);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("policy global candidate 1 saved.\n");
    const saved = JSON.parse(
      readFileSync(join(valid.root, "library", "policy", "global", "1.candidate.json"), "utf8"),
    ) as { reason: string };
    expect(saved.reason).toBe("Edited in the test.");

    // an invalid edit is not saved and is kept for the author
    const invalid = withEditor({ ...candidate(globalExample), paths: { allow: ["/x"] } });
    const bad = await call(invalid.root, "op_017", ["policy", "edit", "global"], invalid.env);
    expect(bad.code).toBe(EXIT.invalid);
    expect(bad.stderr).toContain("The edit is kept at");
    const kept = readFileSync(
      join(invalid.root, "library", "policy", "global", "1.candidate.json"),
      "utf8",
    );
    expect(kept).not.toContain('"/x"');

    // a settings edit that fails its loader checks is refused
    const badSettings = candidate(settingsExample(), (d) => {
      (d.apps as { kvfcu: Record<string, unknown> }).kvfcu.origin = "http://kvfcu.keystone.example";
    });
    const settings = withEditor(badSettings);
    const refused = await call(settings.root, "op_017", ["settings", "edit"], settings.env);
    expect(refused.code).toBe(EXIT.invalid);
    expect(refused.stderr).toContain("only a loopback host may use http");

    // edit needs a staff ID and an editor
    const root = draftedRoot();
    expect((await call(root, null, ["policy", "edit", "global"], { EDITOR: "true" })).code).toBe(
      EXIT.usage,
    );
    expect((await call(root, "op_017", ["policy", "edit", "global"])).code).toBe(EXIT.usage);
  });
});

describe("settings", () => {
  const KEYS = {
    INTYY_KEYSTONE_KVFCU_OPERATOR_USERNAME: "teller-name-value",
    INTYY_KEYSTONE_KVFCU_OPERATOR_PASSWORD: "teller-pass-value",
    INTYY_KEYSTONE_REQUEST_INDEX_KEY_K2: "a".repeat(64),
    INTYY_KEYSTONE_REQUEST_INDEX_KEY_K1: "b".repeat(64),
  };

  test("check --secrets prints names and set or missing, never values; seal and approve follow four eyes: the sealer cannot approve, exit 6", async () => {
    const root = draftedRoot();
    const all = await call(root, null, ["settings", "check", "--secrets"], KEYS);
    expect(all.code).toBe(0);
    expect(all.stdout).toContain(
      "kvfcu.operator_password  INTYY_KEYSTONE_KVFCU_OPERATOR_PASSWORD  set",
    );
    for (const value of Object.values(KEYS)) {
      expect(all.stdout).not.toContain(value);
      expect(all.stderr).not.toContain(value);
    }

    const partial: Record<string, string> = { ...KEYS };
    delete partial.INTYY_KEYSTONE_REQUEST_INDEX_KEY_K1;
    const some = await call(root, null, ["settings", "check", "--secrets", "--json"], partial);
    expect(some.code).toBe(EXIT.usage);
    const out = JSON.parse(some.stdout) as { secrets: { name: string; status: string }[] };
    expect(out.secrets.find((s) => s.name === "request_index_key.k1")?.status).toBe("missing");
    expect(some.stdout).not.toContain("teller-pass-value");

    expect((await call(root, null, ["settings", "check"])).stdout).toBe(
      "settings keystone 1 (candidate) is valid.\n",
    );
    expect((await call(root, "op_022", ["settings", "seal"])).code).toBe(0);
    const self = await call(root, "op_022", ["settings", "approve", "--rev", "1"]);
    expect(self.code).toBe(EXIT.refused);
    expect(self.stderr).toContain("four eyes");
    expect((await call(root, "op_031", ["settings", "approve", "--rev", "1"])).code).toBe(0);
    expect((await call(root, null, ["settings", "check"])).stdout).toBe(
      "settings keystone 1 (approved) is valid.\n",
    );
  });
});
