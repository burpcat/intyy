// Proves the `trust` approval family end to end (design section 9 §9.4 the approval family, §9.3
// the screen's hash; section 8 §10.1 roles, §10.2 four eyes, §10.4 rules to approve, §10.5 what
// approval does and `--expect-record`, §10.6 reject, §10.8 restore, §10.9 retire and reinstate):
// the happy path; each refusal alone with exit 6 (record_changed, role, four_eyes, gate_failed,
// stale by engine and by handler set, link_not_approved, needs_ack, no_full_batch,
// not_latest_batch, report_missing, report_changed, not_approval_grade, illegal_move); usage errors
// exit 1; quick, regression, and drill batch lines never earn an approval; the first-approval hash;
// approval retires only the same tenant, app version, capability, and major; and reject, restore,
// reinstate, demote, retire, list, show, history; and a report with timeouts installs the values the
// batch ran with and makes its proposals the record's candidates (section 8 §9.6; M10 task 11).
// Temporary data roots only. M10 task 5.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { readVersion } from "../../../src/cli/program.js";
import { EXIT } from "../../../src/cli/exit-codes.js";
import { BatchReport } from "../../../src/core/model/batch-report.js";
import { hashJson } from "../../../src/core/model/canonical.js";
import type { HistoryLine } from "../../../src/core/model/score-history.js";
import type { ScoreKey, ScoreRecord } from "../../../src/core/model/score.js";
import { sealHash } from "../../../src/core/model/sealing.js";
import { keyPath } from "../../../src/core/trust/keys.js";
import { draftRecord, recordHash } from "../../../src/core/trust/rebuild.js";
import { OPEN_SUB } from "../replay/executor-harness.js";
import { approved, batch, degraded, h, KEY as BASE_KEY, retired, SCORES } from "../trust/kit.js";
import { cleanRoots, STAFF } from "./helpers.js";
import { realWiringOf, replayCall, replayRoot, type ReplayEnv } from "./replay-harness.js";

afterAll(cleanRoots);

const LONG = { timeout: 120_000 };

/** `replayRoot`'s settings give kvfcu app version 8.4; open_sub 1.0.0 is sealed by op_017. */
const KEY: ScoreKey = { ...BASE_KEY, capability: "kvfcu/open_sub@1.0.0", app_version: "8.4" };
const SIGN_IN_KEY: ScoreKey = { ...KEY, capability: "kvfcu/sign_in@1.0.0" };
const TEXT = "kvfcu/open_sub@1.0.0";
const SIGN_IN_TEXT = "kvfcu/sign_in@1.0.0";

type BatchLine = Extract<HistoryLine, { event: "batch" }>;

/** One batch of a fixture: its history line and its `report.json` (`null`: no file). */
type Batch = {
  id: string;
  minute: number;
  over?: Partial<BatchLine>;
  report?: Record<string, unknown> | null;
};

type Setup = {
  /** Default: one passing full batch, `batch_a`. */
  batches?: Batch[];
  /** History lines written after the batches. */
  lines?: HistoryLine[];
  /** False: no approved `sign_in`, so the session link fails. */
  signIn?: boolean;
  /** False: no fragile step in the batch's scores, so no `--ack` is needed. */
  fragile?: boolean;
  /** What the batches ran under; default: this engine and the handler set a live run freezes now. */
  engine?: string;
  handlerSet?: string;
};

type Fx = { env: ReplayEnv; handlers: string };

const trust = (env: ReplayEnv, staff: string, argv: string[], stdin = "") =>
  replayCall(env, ["trust", ...argv], { env: { INTYY_STAFF: staff }, stdin });

async function seed(env: ReplayEnv, key: ScoreKey, lines: HistoryLine[]): Promise<void> {
  for (const l of lines) {
    const r = await realWiringOf(env).scores.append(keyPath(key), l);
    if (!r.ok) throw new Error(`test setup: append failed: ${r.detail ?? r.failure}`);
  }
}

/** A full-batch report whose gate passed, with one fragile step. `over` replaces any field. */
function makeReport(id: string, over: Record<string, unknown> = {}): BatchReport {
  return BatchReport.parse({
    schema: "intyy.batch_report/1.0",
    batch_id: id,
    tenant: "keystone",
    app: "kvfcu",
    capability: "kvfcu/open_sub@1",
    ended_at: "2026-01-15T09:00:00.000Z",
    kind: "full",
    cases: [
      {
        case_id: "baseline_1",
        run_id: "run_1",
        class: "valid",
        result: { status: "success", detail: null },
        truth: {},
        verdict: "pass",
      },
    ],
    gate: { passed: true, rules: { complete: true, no_wrong: true, baseline: true, matrix: true, extra: true, no_void: true } },
    outcome_score: 0.97,
    verdicts: SCORES.verdicts,
    margin: { lowest: 0.24, step: "open_member", targets: { open_member: { step: "open_member", lowest: 0.24, median: 0.52, score_low: 0.91 } } },
    fragile: ["open_member"],
    coverage_gaps: [],
    stability: null,
    ...over,
  });
}

function writeReport(env: ReplayEnv, report: BatchReport): void {
  const dir = join(env.root, "state", "evidence", "keystone", "batches", report.batch_id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "report.json"), JSON.stringify(report));
}

/** What a live run would freeze now, from the review screen's own JSON. */
async function handlersNow(env: ReplayEnv): Promise<string> {
  const r = await trust(env, "op_017", ["review", TEXT, "--json"]);
  const now = (JSON.parse(r.stdout) as { fresh: { handlers: { now: string | null } } }).fresh.handlers.now;
  if (now === null) throw new Error("test setup: no handler set");
  return now;
}

/** A root with sign_in approved and the open_sub batches and lines of `s`. */
async function fixture(s: Setup = {}): Promise<Fx> {
  const env = await replayRoot();
  if (s.signIn !== false) await seed(env, SIGN_IN_KEY, [batch(1, "batch_si"), approved(2, "op_022", "batch_si")]);
  const handlers = await handlersNow(env);
  const scores = s.fragile === false ? { ...SCORES, fragile: [] } : SCORES;
  for (const b of s.batches ?? [{ id: "batch_a", minute: 1 }]) {
    const report = b.report === null ? null : makeReport(b.id, b.report);
    if (report !== null) writeReport(env, report);
    await seed(env, KEY, [
      batch(b.minute, b.id, {
        under: { engine: s.engine ?? readVersion(), handler_set: s.handlerSet ?? handlers, jev: null, session: null, check: null },
        report_hash: report === null ? h(`none-${b.id}`) : hashJson(report),
        ...(b.over?.kind === undefined || b.over.kind === "full" ? { scores } : {}),
        ...b.over,
      }),
    ]);
  }
  await seed(env, KEY, s.lines ?? []);
  return { env, handlers };
}

async function reviewHash(env: ReplayEnv, text = TEXT): Promise<string> {
  const r = await trust(env, "op_022", ["review", text, "--json"]);
  return (JSON.parse(r.stdout) as { record: string }).record;
}

/** `trust approve` with the current record hash, unless `hash` says otherwise. */
async function approve(
  fx: Fx,
  o: { who?: string; batch?: string; ack?: string[]; hash?: string; stdin?: string } = {},
) {
  const hash = o.hash ?? (await reviewHash(fx.env));
  const ack = (o.ack ?? ["open_member"]).flatMap((a) => ["--ack", a]);
  return trust(fx.env, o.who ?? "op_022", ["approve", TEXT, "--batch", o.batch ?? "batch_a", ...ack, "--expect-record", hash], o.stdin);
}

/** The refusal codes a call printed, in order: lines like `  stale: detail`. */
function codes(stderr: string): string[] {
  return [...stderr.matchAll(/^ {2}([a-z_]+): /gm)].map((m) => m[1] ?? "");
}

const historyOf = async (env: ReplayEnv, key: ScoreKey) => {
  const r = await realWiringOf(env).scores.history(keyPath(key));
  if (!r.ok) throw new Error("test setup: no history");
  return r.value;
};

/** The record now, as `trust show` gives it (a seeded history has no record.json until a command writes one). */
const recordOf = async (env: ReplayEnv, key: ScoreKey): Promise<ScoreRecord> => {
  const r = await trust(env, "op_031", ["show", `${key.capability}${key.patch_revision === null ? "" : `+p${String(key.patch_revision)}`}`, "--json"]);
  return (JSON.parse(r.stdout) as { record: ScoreRecord }).record;
};

describe("trust approve: the happy path", () => {
  test("approves on the quoted hash: approved, timeouts, and the acknowledgement on the record", LONG, async () => {
    const fx = await fixture();
    const hash = await reviewHash(fx.env);
    const r = await trust(fx.env, "op_022", ["approve", TEXT, "--batch", "batch_a", "--ack", "open_member", "--expect-record", hash], "Read the margin.");
    expect(r.stderr).toBe("");
    expect(r.code).toBe(EXIT.ok);
    expect(r.stdout).toContain(`approved ${TEXT} on batch_a by op_022`);

    const events = (await historyOf(fx.env, KEY)).map((l) => l.event);
    expect(events).toEqual(["batch", "approved", "timeouts"]);
    const rec = await recordOf(fx.env, KEY);
    expect(rec.state).toBe("approved");
    expect(rec.approval).toMatchObject({ by: "op_022", batch: "batch_a", acknowledged: ["open_member"], note: "Read the margin." });
    expect(rec.timeouts.approved_from).toBe("batch_a");
  });

  test("a report with timeouts: approval installs what the batch ran with, and its proposals become the candidates (section 8 §9.6)", LONG, async () => {
    const timeouts = { ran_with: { click_search: 9000 }, ran_with_from: null, proposed: { click_search: 10000, click_submit: 15000 }, not_proposed: {} };
    const fx = await fixture({ batches: [{ id: "batch_a", minute: 1, report: { timeouts } }] });
    const r = await approve(fx);
    expect(r.stderr).toBe("");
    expect(r.code).toBe(EXIT.ok);

    const line = (await historyOf(fx.env, KEY)).find((l) => l.event === "timeouts");
    expect(line).toMatchObject({ event: "timeouts", batch: "batch_a", values: { click_search: 9000 }, candidate: { click_search: 10000, click_submit: 15000 } });
    const rec = await recordOf(fx.env, KEY);
    expect(rec.timeouts).toEqual({
      approved: { click_search: 9000 },
      approved_from: "batch_a",
      candidate: { click_search: 10000, click_submit: 15000 },
      candidate_from: "batch_a",
    });
  });

  test("an approver on every tenant (*) may approve too", LONG, async () => {
    const fx = await fixture();
    const r = await approve(fx, { who: "op_031" });
    expect(r.code).toBe(EXIT.ok);
    expect((await recordOf(fx.env, KEY)).approval?.by).toBe("op_031");
  });
});

/** Makes `op_017` an approver for keystone as well, so only four eyes can stop it (section 8 §10.2). */
function makeSealerAnApprover(env: ReplayEnv): void {
  const staff = {
    ...STAFF,
    staff: STAFF.staff.map((s) => (s.id === "op_017" ? { ...s, roles: { ...s.roles, keystone: ["approver"] } } : s)),
  };
  writeFileSync(join(env.root, "library", "staff.json"), JSON.stringify(staff));
}

const PASSED_RULES = { complete: true, no_wrong: true, baseline: true, matrix: true, extra: true, no_void: true };

describe("trust approve: each refusal alone, exit 6", () => {
  /** One case: the fixture, the call, and the only codes the refusal may print. */
  const CASES: {
    name: string;
    setup: Setup;
    call?: Parameters<typeof approve>[1];
    codes: string[];
  }[] = [
    { name: "record_changed: a wrong hash", setup: {}, call: { hash: h("not the record") }, codes: ["record_changed"] },
    {
      name: "gate_failed: the line and the report both say the gate failed",
      setup: {
        batches: [{ id: "batch_a", minute: 1, over: { gate: "failed" }, report: { gate: { passed: false, rules: { ...PASSED_RULES, matrix: false } } } }],
      },
      codes: ["gate_failed"],
    },
    { name: "stale: a different engine", setup: { engine: "0.0.1-other" }, codes: ["stale"] },
    { name: "stale: a different handler set", setup: { handlerSet: h("other handlers") }, codes: ["stale"] },
    { name: "link_not_approved: sign_in has no approved key", setup: { signIn: false }, codes: ["link_not_approved"] },
    { name: "needs_ack: the fragile step is not acknowledged", setup: {}, call: { ack: [] }, codes: ["needs_ack"] },
    {
      name: "not_latest_batch: an older full batch",
      setup: { batches: [{ id: "batch_a", minute: 1 }, { id: "batch_b", minute: 2 }] },
      codes: ["not_latest_batch"],
    },
    { name: "report_missing: no report.json", setup: { batches: [{ id: "batch_a", minute: 1, report: null }] }, codes: ["report_missing"] },
    {
      name: "report_changed: the report no longer matches its line",
      setup: { batches: [{ id: "batch_a", minute: 1, over: { report_hash: h("another report") } }] },
      codes: ["report_changed"],
    },
    { name: "not_approval_grade: a quick report", setup: { batches: [{ id: "batch_a", minute: 1, report: { kind: "quick" } }] }, codes: ["not_approval_grade"] },
    { name: "not_approval_grade: a drill report", setup: { batches: [{ id: "batch_a", minute: 1, report: { drill: true } }] }, codes: ["not_approval_grade"] },
    { name: "not_approval_grade: a models-off report", setup: { batches: [{ id: "batch_a", minute: 1, report: { models_off: true } }] }, codes: ["not_approval_grade"] },
    { name: "illegal_move: a degraded key is restored, not approved", setup: { lines: [approved(2), degraded(3)] }, codes: ["illegal_move"] },
    { name: "illegal_move: a retired key is reinstated first", setup: { lines: [approved(2), retired(3)] }, codes: ["illegal_move"] },
  ];

  test.each(CASES)("$name", LONG, async ({ setup, call, codes: expected }) => {
    const fx = await fixture(setup);
    const before = (await historyOf(fx.env, KEY)).length;
    const r = await approve(fx, call);
    expect(r.code).toBe(EXIT.refused);
    expect(codes(r.stderr)).toEqual(expected);
    expect(await historyOf(fx.env, KEY)).toHaveLength(before);
  });

  test("four_eyes: the approver sealed the artifact", LONG, async () => {
    const fx = await fixture();
    makeSealerAnApprover(fx.env);
    const r = await approve(fx, { who: "op_017" });
    expect(r.code).toBe(EXIT.refused);
    expect(codes(r.stderr)).toEqual(["four_eyes"]);
    expect(r.stderr).toContain("op_017 sealed this artifact");
    expect(await historyOf(fx.env, KEY)).toHaveLength(1);
  });

  test("role: a staff ID with no approver role is refused before anything else", LONG, async () => {
    const fx = await fixture();
    const r = await approve(fx, { who: "op_017" });
    expect(r.code).toBe(EXIT.refused);
    expect(r.stderr).toContain("op_017 lacks the approver role for tenant keystone");
    expect(await historyOf(fx.env, KEY)).toHaveLength(1);
  });

  test.each([
    ["quick", { kind: "quick" as const }, { kind: "quick" }],
    ["regression", { kind: "regression" as const }, { kind: "full" }],
    ["drill", { drill: true as const }, { drill: true }],
  ])("a %s batch line never becomes the full batch: no_full_batch", LONG, async (_name, over, report) => {
    const fx = await fixture({ batches: [{ id: "batch_a", minute: 1, over, report }] });
    const r = await approve(fx, { ack: [] });
    expect(r.code).toBe(EXIT.refused);
    expect(codes(r.stderr)).toEqual(["no_full_batch"]);
  });
});

describe("trust approve: usage errors, exit 1", () => {
  test("a missing --batch, a missing --expect-record, and an unknown --ack", LONG, async () => {
    const fx = await fixture();
    const hash = await reviewHash(fx.env);
    const noBatch = await trust(fx.env, "op_022", ["approve", TEXT, "--ack", "open_member", "--expect-record", hash]);
    expect(noBatch.code).toBe(EXIT.usage);
    expect(noBatch.stderr).toContain("--batch is required");
    const noHash = await trust(fx.env, "op_022", ["approve", TEXT, "--batch", "batch_a", "--ack", "open_member"]);
    expect(noHash.code).toBe(EXIT.usage);
    expect(noHash.stderr).toContain("--expect-record is required");
    const badAck = await approve(fx, { ack: ["open_member", "no_such_step"] });
    expect(badAck.code).toBe(EXIT.usage);
    expect(badAck.stderr).toContain("no_such_step");
    expect(await historyOf(fx.env, KEY)).toHaveLength(1);
  });
});

describe("the record hash", () => {
  test("a first approval on a key with no files quotes the hash of the synthetic draft", LONG, async () => {
    const env = await replayRoot();
    const draft = draftRecord(KEY, { artifact: sealHash(OPEN_SUB), patch: null });
    expect(await reviewHash(env)).toBe(recordHash(draft));
  });

  test("the review screen ends with the same hash the JSON form carries, and show agrees", LONG, async () => {
    const fx = await fixture({ lines: [approved(2)] });
    const screen = await trust(fx.env, "op_022", ["review", TEXT]);
    const last = screen.stdout.trimEnd().split("\n").at(-1);
    expect(last).toBe(`RECORD ${await reviewHash(fx.env)}`);
    const shown = await trust(fx.env, "op_031", ["show", TEXT]);
    expect(shown.stdout.trimEnd().split("\n").at(-1)).toBe(last);
  });

  test("the hash moves with the record: a new line after the review refuses the old hash", LONG, async () => {
    const fx = await fixture();
    const stale = await reviewHash(fx.env);
    await seed(fx.env, KEY, [batch(9, "batch_late", { report_hash: h("late") })]);
    expect(await reviewHash(fx.env)).not.toBe(stale);
    const r = await approve(fx, { hash: stale });
    expect(codes(r.stderr)).toEqual(["record_changed"]);
  });
});

describe("approval retires the prior approved key of the same context", () => {
  const OTHER: HistoryLine[] = [batch(1, "batch_o"), approved(2, "op_022", "batch_o")];

  test("same tenant, app version, capability, and major: retired by system; every other key is untouched", LONG, async () => {
    const fx = await fixture();
    const prior: ScoreKey = { ...KEY, capability: "kvfcu/open_sub@1.0.1" };
    const otherMajor: ScoreKey = { ...KEY, capability: "kvfcu/open_sub@2.0.0" };
    const otherTenant: ScoreKey = { ...prior, tenant: "lakeshore" };
    const otherApp: ScoreKey = { ...prior, app_version: "8.3" };
    for (const k of [prior, otherMajor, otherTenant, otherApp]) await seed(fx.env, k, OTHER);

    const r = await approve(fx);
    expect(r.code).toBe(EXIT.ok);
    expect(r.stdout).toContain(`retired ${prior.capability}`);

    const last = (await historyOf(fx.env, prior)).at(-1);
    expect(last).toMatchObject({ event: "retired", by: "system", newer_key: TEXT });
    for (const k of [otherMajor, otherTenant, otherApp, SIGN_IN_KEY]) {
      expect((await historyOf(fx.env, k)).at(-1)?.event).toBe("approved");
    }
  });

  test("re-approving an approved key on a newer batch retires nothing", LONG, async () => {
    const fx = await fixture({
      batches: [{ id: "batch_a", minute: 1 }, { id: "batch_b", minute: 3 }],
      lines: [approved(2, "op_022", "batch_a")],
    });
    const r = await approve(fx, { batch: "batch_b" });
    expect(r.code).toBe(EXIT.ok);
    expect(r.stdout).not.toContain("retired");
    const events = (await historyOf(fx.env, KEY)).map((l) => l.event);
    expect(events).toEqual(["batch", "batch", "approved", "approved", "timeouts"]);
    expect(await recordOf(fx.env, KEY)).toMatchObject({ state: "approved", approval: { batch: "batch_b" } });
  });
});

describe("trust reject", () => {
  test("records a rejection with the note and leaves the state as it was", LONG, async () => {
    const fx = await fixture();
    const r = await trust(fx.env, "op_022", ["reject", TEXT, "--batch", "batch_a"], "Margins too thin.");
    expect(r.code).toBe(EXIT.ok);
    const last = (await historyOf(fx.env, KEY)).at(-1);
    expect(last).toMatchObject({ event: "rejected", by: "op_022", batch: "batch_a", note: "Margins too thin." });
    expect((await recordOf(fx.env, KEY)).state).toBe("draft");
  });

  test("needs the approver role (6), a batch (1), and a report for that batch (1)", LONG, async () => {
    const fx = await fixture();
    expect((await trust(fx.env, "op_017", ["reject", TEXT, "--batch", "batch_a"])).code).toBe(EXIT.refused);
    expect((await trust(fx.env, "op_022", ["reject", TEXT])).code).toBe(EXIT.usage);
    expect((await trust(fx.env, "op_022", ["reject", TEXT, "--batch", "batch_nope"])).code).toBe(EXIT.usage);
    expect(await historyOf(fx.env, KEY)).toHaveLength(1);
  });
});

describe("trust restore", () => {
  const DEGRADED: Setup = {
    batches: [{ id: "batch_a", minute: 1 }, { id: "batch_b", minute: 5 }],
    lines: [approved(2, "op_022", "batch_a"), degraded(3)],
  };
  const restore = async (fx: Fx, o: { who?: string; batch?: string; hash?: string } = {}) =>
    trust(fx.env, o.who ?? "op_022", ["restore", TEXT, "--batch", o.batch ?? "batch_b", "--expect-record", o.hash ?? (await reviewHash(fx.env))], "Fixed.");

  test("a new full batch newer than the demotion restores the key", LONG, async () => {
    const fx = await fixture(DEGRADED);
    const r = await restore(fx);
    expect(r.stderr).toBe("");
    expect(r.code).toBe(EXIT.ok);
    expect((await historyOf(fx.env, KEY)).at(-1)).toMatchObject({ event: "restored", by: "op_022", batch: "batch_b" });
    expect((await recordOf(fx.env, KEY)).state).toBe("approved");
  });

  test("not_new_batch: the latest batch is older than the demotion", LONG, async () => {
    const fx = await fixture({ lines: [approved(2, "op_022", "batch_a"), degraded(3)] });
    const r = await restore(fx, { batch: "batch_a" });
    expect(r.code).toBe(EXIT.refused);
    expect(codes(r.stderr)).toEqual(["not_new_batch"]);
  });

  test("a wrong hash is record_changed; a non-approver is refused; --after-exclusion exits 1", LONG, async () => {
    const fx = await fixture(DEGRADED);
    const wrong = await restore(fx, { hash: h("old") });
    expect(codes(wrong.stderr)).toEqual(["record_changed"]);
    expect((await restore(fx, { who: "op_017" })).code).toBe(EXIT.refused);
    const ex = await trust(fx.env, "op_022", ["restore", TEXT, "--after-exclusion"]);
    expect(ex.code).toBe(EXIT.usage);
    expect((await trust(fx.env, "op_022", ["restore", TEXT, "--batch", "batch_b"])).code).toBe(EXIT.usage);
    expect((await recordOf(fx.env, KEY)).state).toBe("degraded");
  });
});

describe("trust reinstate, demote, retire", () => {
  test("reinstate sends a retired key to draft; approver only; a reason is required", LONG, async () => {
    const fx = await fixture({ lines: [approved(2), retired(3)] });
    expect((await trust(fx.env, "op_017", ["reinstate", TEXT], "Needed.")).code).toBe(EXIT.refused);
    expect((await trust(fx.env, "op_022", ["reinstate", TEXT])).code).toBe(EXIT.usage);
    const r = await trust(fx.env, "op_022", ["reinstate", TEXT], "Needed again.");
    expect(r.code).toBe(EXIT.ok);
    expect((await historyOf(fx.env, KEY)).at(-1)).toMatchObject({ event: "reinstated", by: "op_022", reason: "Needed again." });
    expect(await recordOf(fx.env, KEY)).toMatchObject({ state: "draft", approval: null });
  });

  test("reinstate on a key that is not retired is illegal_move (6)", LONG, async () => {
    const fx = await fixture({ lines: [approved(2)] });
    expect((await trust(fx.env, "op_022", ["reinstate", TEXT], "Why.")).code).toBe(EXIT.refused);
  });

  test.each(["op_017", "op_022"])("demote by %s takes an approved key to degraded with the reason", LONG, async (who) => {
    const fx = await fixture({ lines: [approved(2)] });
    const r = await trust(fx.env, who, ["demote", TEXT], "Screens changed.");
    expect(r.code).toBe(EXIT.ok);
    expect((await historyOf(fx.env, KEY)).at(-1)).toMatchObject({ event: "degraded", by: who, rule: "human", reason: "Screens changed." });
    expect((await recordOf(fx.env, KEY)).state).toBe("degraded");
  });

  test("demote on a draft is illegal_move (6); no reason is 1; a stranger is 6", LONG, async () => {
    const draft = await fixture();
    expect((await trust(draft.env, "op_017", ["demote", TEXT], "Why.")).code).toBe(EXIT.refused);
    const fx = await fixture({ lines: [approved(2)] });
    expect((await trust(fx.env, "op_017", ["demote", TEXT])).code).toBe(EXIT.usage);
    expect((await trust(fx.env, "op_999", ["demote", TEXT], "Why.")).code).toBe(EXIT.refused);
    expect((await recordOf(fx.env, KEY)).state).toBe("approved");
  });

  test.each([
    ["draft", []],
    ["approved", [approved(2)]],
    ["degraded", [approved(2), degraded(3)]],
  ] as [string, HistoryLine[]][])("retire takes a %s key out, by an operator or an approver", LONG, async (_state, lines) => {
    const fx = await fixture({ lines });
    expect((await trust(fx.env, "op_017", ["retire", TEXT])).code).toBe(EXIT.usage);
    const r = await trust(fx.env, "op_017", ["retire", TEXT], "Replaced by hand.");
    expect(r.code).toBe(EXIT.ok);
    expect((await historyOf(fx.env, KEY)).at(-1)).toMatchObject({ event: "retired", by: "op_017", reason: "Replaced by hand.", newer_key: null });
    expect((await recordOf(fx.env, KEY)).state).toBe("retired");
  });

  test("retire on a retired key is illegal_move (6)", LONG, async () => {
    const fx = await fixture({ lines: [approved(2), retired(3)] });
    expect((await trust(fx.env, "op_022", ["retire", TEXT], "Again.")).code).toBe(EXIT.refused);
  });
});

describe("trust list, show, history", () => {
  test("list shows each key with its state; --state filters; a bad state is 1", LONG, async () => {
    const fx = await fixture({ lines: [approved(2)] });
    const all = await trust(fx.env, "op_031", ["list"]);
    expect(all.stdout).toContain(`approved  ${TEXT}`);
    expect(all.stdout).toContain(`approved  ${SIGN_IN_TEXT}`);
    const rows = (key: string, state: string) =>
      trust(fx.env, "op_031", ["list", "--state", state, "--json"]).then((r) => (JSON.parse(r.stdout) as { key: string }[]).map((x) => x.key).filter((k) => k === key));
    expect(await rows(TEXT, "approved")).toEqual([TEXT]);
    expect(await rows(TEXT, "degraded")).toEqual([]);
    expect((await trust(fx.env, "op_031", ["list", "--state", "degraded"])).stdout).toContain("No keys.");
    expect((await trust(fx.env, "op_031", ["list", "--state", "bogus"])).code).toBe(EXIT.usage);
  });

  test("show prints the record and its hash; history prints the lines oldest first", LONG, async () => {
    const fx = await fixture({ lines: [approved(2)] });
    const shown = await trust(fx.env, "op_031", ["show", TEXT, "--json"]);
    const body = JSON.parse(shown.stdout) as { record: ScoreRecord; hash: string };
    expect(body.record.state).toBe("approved");
    expect(body.hash).toBe(recordHash(body.record));
    const hist = await trust(fx.env, "op_031", ["history", TEXT, "--json"]);
    expect((JSON.parse(hist.stdout) as { event: string }[]).map((l) => l.event)).toEqual(["batch", "approved"]);
    expect((await trust(fx.env, "op_031", ["history", TEXT])).stdout).toContain("approved");
  });
});
