// Proves the M01 schemas accept the design's examples and refuse what the loader checks forbid.
// Design section 9 §6.1, §6.4, §7.7, §12.1; section 4 §4.4, §4.7, §4.8, §5.3, §5.4.
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { Config } from "../../../src/core/model/config.js";
import { policyKind, settingsKind } from "../../../src/core/model/kinds.js";
import { LockFile } from "../../../src/core/model/lock.js";
import { parsePolicy, type Policy } from "../../../src/core/model/policy.js";
import type { DocumentStore } from "../../../src/ports/stores.js";
import { Settings } from "../../../src/core/model/settings.js";
import { hasRole, StaffFile, staffProblems } from "../../../src/core/model/staff.js";
import { IndexLine } from "../../../src/core/model/store-index.js";
import { FakeDocumentStore } from "../../../src/fakes/stores.js";
import { ManualClock } from "../../../src/fakes/clock.js";
import {
  appExample,
  globalExample,
  settingsExample,
  tenantExample,
} from "../../fixtures/design-examples.js";

/** Sets one field on the settings example's kvfcu app. */
function withApp(field: string, value: unknown): Record<string, unknown> {
  const s = settingsExample();
  const apps = s.apps as { kvfcu: Record<string, unknown> };
  apps.kvfcu[field] = value;
  return s;
}

describe("intyy.config/1.0", () => {
  test("the config schema parses the repo file and rejects an unknown field", () => {
    // the repo's intyy.json parses
    {
      const raw: unknown = JSON.parse(readFileSync("intyy.json", "utf8"));
      expect(Config.safeParse(raw).success).toBe(true);
    }
    // an unknown field fails
    {
      const raw = JSON.parse(readFileSync("intyy.json", "utf8")) as Record<string, unknown>;
      expect(Config.safeParse({ ...raw, extra: 1 }).success).toBe(false);
    }
  });
});

describe("intyy.staff/1.0", () => {
  const staff = StaffFile.parse({
    schema: "intyy.staff/1.0",
    staff: [
      { id: "op_017", roles: { "*": ["operator", "reviewer"] } },
      {
        id: "op_022",
        roles: { keystone: ["approver"], lakeshore: ["approver"], "*": ["operator", "reviewer"] },
      },
      { id: "op_031", roles: { "*": ["approver"] } },
    ],
  });

  test("the staff schema checks roles per tenant, approvers, and duplicates", () => {
    // roles per tenant; `*` covers every tenant; shared scope needs `*`
    expect(hasRole(staff, "op_017", "keystone", "reviewer")).toBe(true);
    expect(hasRole(staff, "op_022", "keystone", "approver")).toBe(true);
    expect(hasRole(staff, "op_022", "*", "approver")).toBe(false);
    expect(hasRole(staff, "op_031", "*", "approver")).toBe(true);
    expect(hasRole(staff, "op_017", "keystone", "approver")).toBe(false);
    expect(hasRole(staff, "op_999", "keystone", "operator")).toBe(false);
    // every tenant has an approver
    {
      expect(staffProblems(staff, ["keystone"])).toEqual([]);
      const noApprover = StaffFile.parse({
        schema: "intyy.staff/1.0",
        staff: [{ id: "op_017", roles: { keystone: ["operator", "reviewer"] } }],
      });
      expect(staffProblems(noApprover)).toEqual(["tenant keystone has no approver"]);
    }
    // a duplicate staff ID and an unknown role fail
    {
      const dup = {
        schema: "intyy.staff/1.0",
        staff: [
          { id: "op_017", roles: { "*": ["operator"] } },
          { id: "op_017", roles: { "*": ["approver"] } },
        ],
      };
      expect(StaffFile.safeParse(dup).success).toBe(false);
      const role = {
        schema: "intyy.staff/1.0",
        staff: [{ id: "op_017", roles: { "*": ["admin"] } }],
      };
      expect(StaffFile.safeParse(role).success).toBe(false);
    }
  });
});

describe("intyy.policy/1.0", () => {
  test("the policy schema parses the examples and rejects each bad shape", async () => {
    // the three section 4 §4.7 examples parse
    expect(parsePolicy(globalExample).success).toBe(true);
    expect(parsePolicy(appExample).success).toBe(true);
    expect(parsePolicy(tenantExample).success).toBe(true);
    // a block at a level that forbids it fails (section 4 §4.4)
    expect(parsePolicy({ ...globalExample, paths: { allow: ["/login"] } }).success).toBe(false);
    expect(parsePolicy({ ...globalExample, secrets: {} }).success).toBe(false);
    expect(parsePolicy({ ...appExample, escalation: { approval_minutes: 30 } }).success).toBe(
      false,
    );
    expect(parsePolicy({ ...appExample, capabilities: { allow: ["kvfcu/*@1"] } }).success).toBe(
      false,
    );
    expect(parsePolicy({ ...tenantExample, paths: { allow: ["/login"] } }).success).toBe(false);
    // global correlation stays off
    expect(parsePolicy({ ...globalExample, correlation: { notes: true } }).success).toBe(false);
    // an unknown field or schema fails
    expect(parsePolicy({ ...tenantExample, surprise: true }).success).toBe(false);
    expect(parsePolicy({ ...tenantExample, schema: "intyy.policy/2.0" }).success).toBe(false);
    expect(parsePolicy({ ...tenantExample, scope: { level: "bank" } }).success).toBe(false);
    // words are lower case, one to three words
    {
      const risk = (words: string[]) => ({ ...globalExample, risk: { irreversible_words: words } });
      expect(
        parsePolicy(risk(["close account", "mother's maiden name", "a/c no", "e-mail"])).success,
      ).toBe(true);
      expect(parsePolicy(risk(["Confirm"])).success).toBe(false);
      expect(parsePolicy(risk(["one two three four"])).success).toBe(false);
      expect(parsePolicy(risk([""])).success).toBe(false);
    }
    // path patterns start with /; secrets need a kind and a path
    expect(parsePolicy({ ...appExample, paths: { allow: ["login"] } }).success).toBe(false);
    expect(
      parsePolicy({ ...appExample, secrets: { pin: { kind: "password", paths: [] } } }).success,
    ).toBe(false);
    expect(
      parsePolicy({ ...appExample, secrets: { pin: { kind: "pin", paths: ["/login"] } } }).success,
    ).toBe(false);
    // a bound needs min <= default <= max
    {
      const bad = {
        ...globalExample,
        escalation: { approval_minutes: { min: 5, max: 120, default: 200 } },
      };
      expect(parsePolicy(bad).success).toBe(false);
    }
    // a format pattern must parse (section 4 §9.8)
    {
      const withFormat = (format: string) => ({
        ...globalExample,
        redaction: { formats: [{ format, kind: "member" }] },
      });
      expect(parsePolicy(withFormat('"A"9999')).success).toBe(true);
      expect(parsePolicy(withFormat('"A9999')).success).toBe(false);
      expect(parsePolicy(withFormat('""9999')).success).toBe(false);
    }
    // a path pattern must parse (section 4 §6.3)
    {
      const withAllow = (allow: string[]) => ({
        ...appExample,
        paths: { allow },
      });
      expect(parsePolicy(withAllow(["/members/*"])).success).toBe(true);
      expect(parsePolicy(withAllow(["/members/../admin"])).success).toBe(false);
    }
    // errors name the field of the level the file declares
    {
      const result = parsePolicy({ ...tenantExample, capabilities: { allow: ["not a pattern"] } });
      expect(result.success).toBe(false);
      expect(result.error?.issues[0]?.path).toEqual(["capabilities", "allow", 0]);
    }
    // the store refuses a layer filed under another layer's ID
    {
      const store: DocumentStore<Policy> = new FakeDocumentStore(policyKind, new ManualClock());
      const candidate: Record<string, unknown> = { ...tenantExample };
      delete candidate.approved;
      const parsed = parsePolicy(candidate);
      if (!parsed.success) throw new Error("example did not parse");
      expect(await store.putCandidate("tenant/lakeshore", parsed.data, "op_017")).toMatchObject({
        ok: false,
        failure: "invalid",
        detail: "the file names tenant/keystone, but it is stored as tenant/lakeshore",
      });
      expect((await store.putCandidate("tenant/keystone", parsed.data, "op_017")).ok).toBe(true);
    }
  });
});

describe("intyy.settings/1.0", () => {
  test("the settings schema accepts the example and rejects each bad field", () => {
    // the section 4 §5.3 example parses, with locale and time zone
    expect(Settings.safeParse(settingsExample()).success).toBe(true);
    // origin uses https, except a loopback host
    expect(Settings.safeParse(withApp("origin", "https://kvfcu.keystone.example")).success).toBe(
      true,
    );
    expect(Settings.safeParse(withApp("origin", "http://localhost:8080")).success).toBe(true);
    expect(Settings.safeParse(withApp("origin", "http://kvfcu.keystone.example")).success).toBe(
      false,
    );
    // origin holds no path, user name, or password
    expect(Settings.safeParse(withApp("origin", "http://127.0.0.1:8080/login")).success).toBe(
      false,
    );
    expect(Settings.safeParse(withApp("origin", "http://127.0.0.1:8080/")).success).toBe(false);
    expect(
      Settings.safeParse(withApp("origin", "https://teller:pw@kvfcu.keystone.example")).success,
    ).toBe(false);
    // an IP address origin is allowed only for loopback (section 4 §6.2)
    expect(Settings.safeParse(withApp("origin", "https://10.0.0.7")).success).toBe(false);
    expect(Settings.safeParse(withApp("origin", "https://[2001:db8::1]")).success).toBe(false);
    expect(Settings.safeParse(withApp("origin", "http://[::1]:8080")).success).toBe(true);
    // environment is test or production
    expect(Settings.safeParse(withApp("environment", "staging")).success).toBe(false);
    // locale and time zone must be real
    expect(Settings.safeParse(withApp("locale", "english")).success).toBe(false);
    expect(Settings.safeParse(withApp("time_zone", "Mars/Olympus_Mons")).success).toBe(false);
    // only the env source is built; a value-looking field fails
    {
      const vault = { operator_password: { source: "vault", path: "kv/keystone/teller" } };
      expect(Settings.safeParse(withApp("secrets", vault)).success).toBe(false);
      const value = { operator_password: { source: "env", key: "hunter2" } };
      expect(Settings.safeParse(withApp("secrets", value)).success).toBe(false);
      const inline = { operator_password: { source: "env", key: "INTYY_X", value: "hunter2" } };
      expect(Settings.safeParse(withApp("secrets", inline)).success).toBe(false);
    }
    // reserved tenant IDs fail (updates file §12)
    for (const tenant of ["artifacts", "trust", "tests"]) {
      expect(Settings.safeParse({ ...settingsExample(), tenant }).success).toBe(false);
    }
    // exactly one request index key is current
    {
      const s = settingsExample();
      const keys = (s.system_secrets as { request_index_keys: { status: string }[] })
        .request_index_keys;
      for (const k of keys) k.status = "current";
      expect(Settings.safeParse(s).success).toBe(false);
    }
    // the settings kind names the tenant as its store ID
    {
      const parsed = Settings.parse(settingsExample());
      expect(settingsKind.idOf?.(parsed)).toBe("keystone");
      expect(settingsKind.revOf(parsed)).toBe("2");
    }
  });
});

describe("intyy.index/1.0 and intyy.lock/1.0", () => {
  test("the index line and lock file parse", () => {
    // the section 9 §6.4 index line parses
    {
      const line = {
        event: "sealed",
        kind: "artifact",
        id: "kvfcu/open_share_subaccount",
        rev: "1.0.0",
        path: "kvfcu/open_share_subaccount/1.0.0/artifact.json",
        hash: `sha256:${"9c1e".repeat(16)}`,
        by: "op_017",
        at: "2026-09-26T08:00:00Z",
      };
      expect(IndexLine.safeParse(line).success).toBe(true);
      expect(IndexLine.safeParse({ ...line, hash: "sha256:9c1e…" }).success).toBe(false);
    }
    // a lock file holds owner, process, host, command, staff, and start time
    {
      const lock = {
        schema: "intyy.lock/1.0",
        owner: "run_2026-09-24_7kq2m9x4tb",
        pid: 4242,
        host: "teller-mac",
        command: "replay",
        staff: "op_017",
        started_at: "2026-09-24T10:15:19.530Z",
      };
      expect(LockFile.safeParse(lock).success).toBe(true);
      expect(LockFile.safeParse({ ...lock, pid: 0 }).success).toBe(false);
    }
  });
});
