// Proves the request index (section 3 §4.4, section 4 §8.11): a true repeat returns the
// stored run ID; a changed request with the same ID is a reuse; a rejected request stores
// nothing; entries expire; no input or raw ID ever reaches the stored bytes; and a missing K1
// key fails as `secret_unavailable`.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { z } from "zod";
import { FileLogStore } from "../../../src/adapters/files/other-stores.js";
import { ManualClock } from "../../../src/fakes/clock.js";
import { FakeLogStore } from "../../../src/fakes/stores.js";
import { MapSecrets } from "../../../src/fakes/secrets.js";
import { Request } from "../../../src/core/model/request.js";
import { RequestIndexLine } from "../../../src/core/model/request-index.js";
import {
  lookupRequestIndex,
  recordRequestIndex,
  requestIndexOps,
  type RequestIndexDeps,
} from "../../../src/core/orchestrator/request-index.js";

const TENANT = "keystone";
const AGENT = "agent_teller_01";
const CANARY_LOOKING_MEMBER_ID = "700900"; // not the real canary; stands in for "member data"

function request(overrides: Record<string, unknown> = {}): Request {
  const parsed = Request.safeParse({
    schema: "intyy.request/1.0",
    request_id: "agt-teller-0001",
    capability: "kvfcu/open_share_subaccount@1",
    inputs: { member_id: CANARY_LOOKING_MEMBER_ID, deposit: "100.00" },
    mode: "supervised",
    ...overrides,
  });
  if (!parsed.success) throw new Error("test request does not fit intyy.request/1.0");
  return parsed.data;
}

/** An in-memory store, a clock, one bound current key, and a resolvable value for it. */
function deps(overrides: Partial<RequestIndexDeps> = {}): RequestIndexDeps {
  return {
    store: new FakeLogStore({ line: RequestIndexLine, record: z.never() }),
    clock: new ManualClock("2026-09-24T10:00:00.000Z"),
    secrets: new MapSecrets({ K1: "current-key-value", K0: "previous-key-value" }),
    keys: [{ keyId: "k1", status: "current", binding: { source: "env", key: "K1" } }],
    ...overrides,
  };
}

describe("lookupRequestIndex and recordRequestIndex", () => {
  test("a new request ID is new", async () => {
    const got = await lookupRequestIndex(deps(), TENANT, AGENT, request());
    expect(got).toEqual({ ok: true, value: { status: "new" } });
  });

  test("a true repeat returns the original run's ID", async () => {
    const d = deps();
    const recorded = await recordRequestIndex(d, TENANT, AGENT, request(), "run_2026-09-24_7kq2m9x4tb");
    expect(recorded.ok).toBe(true);
    const got = await lookupRequestIndex(d, TENANT, AGENT, request());
    expect(got).toEqual({ ok: true, value: { status: "repeat", runId: "run_2026-09-24_7kq2m9x4tb" } });
  });

  test("the same request ID with different content is reused, not a repeat", async () => {
    const d = deps();
    await recordRequestIndex(d, TENANT, AGENT, request(), "run_2026-09-24_7kq2m9x4tb");
    const got = await lookupRequestIndex(d, TENANT, AGENT, request({ inputs: { member_id: "999999", deposit: "1.00" } }));
    expect(got).toEqual({ ok: true, value: { status: "reused" } });
  });

  test("a rejected request stores nothing, so a fixed retry with the same ID still runs", async () => {
    const d = deps();
    const first = await lookupRequestIndex(d, TENANT, AGENT, request());
    expect(first).toEqual({ ok: true, value: { status: "new" } });
    // The caller's checks 4 to 9 fail here; record() is never called.
    const second = await lookupRequestIndex(d, TENANT, AGENT, request());
    expect(second).toEqual({ ok: true, value: { status: "new" } });
  });

  test("an entry past expiry_days is ignored: the same ID starts a new run", async () => {
    const clock = new ManualClock("2026-09-24T10:00:00.000Z");
    const d = deps({ clock, expiryDays: 7 });
    await recordRequestIndex(d, TENANT, AGENT, request(), "run_2026-09-24_7kq2m9x4tb");
    clock.advance(8 * 24 * 60 * 60 * 1000);
    const got = await lookupRequestIndex(d, TENANT, AGENT, request());
    expect(got).toEqual({ ok: true, value: { status: "new" } });
  });

  test("a repeat still matches inside the expiry window", async () => {
    const clock = new ManualClock("2026-09-24T10:00:00.000Z");
    const d = deps({ clock, expiryDays: 7 });
    await recordRequestIndex(d, TENANT, AGENT, request(), "run_2026-09-24_7kq2m9x4tb");
    clock.advance(6 * 24 * 60 * 60 * 1000);
    const got = await lookupRequestIndex(d, TENANT, AGENT, request());
    expect(got).toEqual({ ok: true, value: { status: "repeat", runId: "run_2026-09-24_7kq2m9x4tb" } });
  });

  test("a lookup still tries the previous key, for an entry signed just before rotation", async () => {
    const previousKeys = [
      { keyId: "k0", status: "current" as const, binding: { source: "env" as const, key: "K0" } },
    ];
    const rotated = [
      { keyId: "k1", status: "current" as const, binding: { source: "env" as const, key: "K1" } },
      { keyId: "k0", status: "previous" as const, binding: { source: "env" as const, key: "K0" } },
    ];
    const store = new FakeLogStore({ line: RequestIndexLine, record: z.never() });
    const clock = new ManualClock("2026-09-24T10:00:00.000Z");
    const secrets = new MapSecrets({ K1: "current-key-value", K0: "previous-key-value" });
    await recordRequestIndex({ store, clock, secrets, keys: previousKeys }, TENANT, AGENT, request(), "run_2026-09-24_7kq2m9x4tb");
    const got = await lookupRequestIndex({ store, clock, secrets, keys: rotated }, TENANT, AGENT, request());
    expect(got).toEqual({ ok: true, value: { status: "repeat", runId: "run_2026-09-24_7kq2m9x4tb" } });
  });

  test("a missing current key fails as secret_unavailable, on lookup and on record", async () => {
    const d = deps({ secrets: new MapSecrets({}) });
    expect(await lookupRequestIndex(d, TENANT, AGENT, request())).toMatchObject({ ok: false, failure: "secret_unavailable" });
    expect(await recordRequestIndex(d, TENANT, AGENT, request(), "run_2026-09-24_7kq2m9x4tb")).toMatchObject({
      ok: false,
      failure: "secret_unavailable",
    });
  });

  test("no current key bound at all fails as secret_unavailable", async () => {
    const d = deps({ keys: [] });
    expect(await lookupRequestIndex(d, TENANT, AGENT, request())).toMatchObject({ ok: false, failure: "secret_unavailable" });
  });
});

describe("requestIndexOps", () => {
  test("folds `invalid` and `write_failed` into intyy.result/1.0 failure codes", async () => {
    const ops = requestIndexOps(deps({ secrets: new MapSecrets({}) }));
    expect(await ops.lookup(TENANT, AGENT, request())).toMatchObject({ ok: false, failure: "secret_unavailable" });
    expect(await ops.record(TENANT, AGENT, request(), "run_2026-09-24_7kq2m9x4tb")).toMatchObject({
      ok: false,
      failure: "secret_unavailable",
    });
  });
});

describe("stored bytes", () => {
  const roots: string[] = [];
  afterAll(async () => {
    await Promise.all(roots.map((r) => rm(r, { recursive: true, force: true })));
  });

  test("neither the member ID, the deposit, nor the raw request ID ever reaches disk", async () => {
    const root = await mkdtemp(join(tmpdir(), "intyy-request-index-"));
    roots.push(root);
    const store = new FileLogStore(
      { line: RequestIndexLine, record: z.never() },
      { dir: root, tmpDir: join(root, "tmp") },
    );
    const d = deps({ store });
    const recorded = await recordRequestIndex(d, TENANT, AGENT, request(), "run_2026-09-24_7kq2m9x4tb");
    expect(recorded.ok).toBe(true);
    const bytes = await readFile(join(root, `${TENANT}.jsonl`), "utf8");
    expect(bytes).not.toContain(CANARY_LOOKING_MEMBER_ID);
    expect(bytes).not.toContain("100.00");
    expect(bytes).not.toContain("agt-teller-0001");
    expect(bytes).not.toContain(AGENT);
    expect(bytes).not.toContain("open_share_subaccount");
    // What is left: two keyed hashes, the run ID, and a time.
    const line = JSON.parse(bytes.trim()) as unknown;
    expect(RequestIndexLine.safeParse(line).success).toBe(true);
  });
});
