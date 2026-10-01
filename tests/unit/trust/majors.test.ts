// Proves the major record's rules (design section 8 §11.9): the retire day per context is the later
// of `retires_on` and 90 days after the successor's first approval here, and with no approval there
// is no day; the verdict is nothing, a warning, or a rejection that names the successor; and
// `majorStatus` reads the newest approved record and the tenant's own approved successor lines.
// A candidate or sealed record has no force. In-memory stores, made-up values. M11 task 4.
import { describe, expect, test } from "vitest";
import { majorKind } from "../../../src/core/model/kinds.js";
import { checkMajor, majorId, type Major } from "../../../src/core/model/major.js";
import { HistoryLine } from "../../../src/core/model/score-history.js";
import { ScoreRecord, type ScoreKey } from "../../../src/core/model/score.js";
import { keyPath } from "../../../src/core/trust/keys.js";
import { majorStatus, majorVerdict, retireDate, type MajorStatus } from "../../../src/core/trust/majors.js";
import { SteppingClock } from "../../../src/fakes/clock.js";
import { FakeScoreStore } from "../../../src/fakes/score-store.js";
import { FakeDocumentStore } from "../../../src/fakes/stores.js";
import { approved, batch } from "./kit.js";

const NAME = "open_share_subaccount";
const ID = `kvfcu/${NAME}@1`;
/** `approved(2)` in the kit is written at 2026-01-15T09:02Z, so 90 days later is 2026-04-15. */
const FIRST = "2026-01-15T09:02:00.000Z";

function record(over: Partial<Major> = {}): Major {
  return {
    schema: "intyy.major/1.0",
    app: "kvfcu",
    capability: NAME,
    major: 1,
    revision: 1,
    deprecated_on: "2026-01-10",
    successor: 2,
    retires_on: "2026-06-01",
    by: "op_031",
    reason: "Version 2 replaces it.",
    ...over,
  };
}

function successorKey(over: Partial<ScoreKey> = {}): ScoreKey {
  return { capability: `kvfcu/${NAME}@2.0.0`, tenant: "keystone", app_version: "8.4", patch_revision: null, ...over };
}

function stores() {
  const majors = new FakeDocumentStore<Major>(majorKind, new SteppingClock());
  const scores = new FakeScoreStore<HistoryLine, ScoreRecord>({ line: HistoryLine, record: ScoreRecord });
  return { majors, scores, deps: { majors, scores } };
}

/** Puts one revision in the store, sealed by op_017; approved by op_031 unless `approve` is false. */
async function put(majors: FakeDocumentStore<Major>, doc: Major, how: "approve" | "seal" | "candidate" = "approve"): Promise<void> {
  const id = majorId(doc);
  expect((await majors.putCandidate(id, doc)).ok).toBe(true);
  if (how === "candidate") return;
  expect((await majors.seal(id, "op_017")).ok).toBe(true);
  if (how === "approve") expect((await majors.approve(id, String(doc.revision), "op_031")).ok).toBe(true);
}

async function history(scores: FakeScoreStore<HistoryLine, ScoreRecord>, key: ScoreKey, lines: HistoryLine[]): Promise<void> {
  for (const line of lines) expect((await scores.append(keyPath(key), line)).ok).toBe(true);
}

const status = (d: ReturnType<typeof stores>["deps"], tenant = "keystone", appVersion: string | undefined = "8.4") =>
  majorStatus(d, tenant, appVersion, "kvfcu", NAME, 1);

describe("retireDate", () => {
  test("retires_on wins when it is later than approval + 90 days", () => {
    expect(retireDate({ retires_on: "2026-06-01" }, FIRST)).toBe("2026-06-01");
  });

  test("the successor's first approval + 90 days wins when it is later", () => {
    expect(retireDate({ retires_on: "2026-02-01" }, FIRST)).toBe("2026-04-15");
  });

  test("with no approval there is no date", () => {
    expect(retireDate({ retires_on: "2026-06-01" }, null)).toBeNull();
  });
});

describe("majorVerdict", () => {
  const st = (retiresOn: string | null): MajorStatus => ({ name: ID, successor: 2, retiresOn });

  test("none: no status, or no retire date here", () => {
    expect(majorVerdict(null, "2026-07-01")).toEqual({ kind: "none" });
    expect(majorVerdict(st(null), "2099-01-01")).toEqual({ kind: "none" });
  });

  test("warn before the day, and the message names the date and @2", () => {
    const v = majorVerdict(st("2026-06-01"), "2026-05-31");
    expect(v.kind).toBe("warn");
    if (v.kind === "warn") {
      expect(v.message).toContain("2026-06-01");
      expect(v.message).toContain("@2");
    }
  });

  test("retired after the day, and the message names the successor", () => {
    const v = majorVerdict(st("2026-06-01"), "2026-06-02");
    expect(v.kind).toBe("retired");
    if (v.kind === "retired") expect(v.message).toContain("kvfcu/open_share_subaccount@2");
  });
});

describe("majorStatus", () => {
  test("no record: null", async () => {
    expect(await status(stores().deps)).toBeNull();
  });

  test("a sealed or candidate record has no force", async () => {
    const s = stores();
    await put(s.majors, record(), "seal");
    expect(await status(s.deps)).toBeNull();
    const c = stores();
    await put(c.majors, record(), "candidate");
    expect(await status(c.deps)).toBeNull();
  });

  test("an approved record with no successor approval here: no retire date", async () => {
    const s = stores();
    await put(s.majors, record());
    expect(await status(s.deps)).toEqual({ name: ID, successor: 2, retiresOn: null });
    // A draft successor (a batch, no approval) is not "approved here".
    await history(s.scores, successorKey(), [batch(1, "batch_a")]);
    expect((await status(s.deps))?.retiresOn).toBeNull();
  });

  test("sealed, approved, and the successor approved: the retire day follows the rule", async () => {
    const s = stores();
    await put(s.majors, record({ retires_on: "2026-02-01" }));
    await history(s.scores, successorKey(), [batch(1, "batch_a"), approved(2)]);
    expect(await status(s.deps)).toEqual({ name: ID, successor: 2, retiresOn: "2026-04-15" });
  });

  test("the earliest approval among the tenant's successor keys counts", async () => {
    const s = stores();
    await put(s.majors, record({ retires_on: "2026-02-01" }));
    const later = { ...approved(2), at: "2026-02-10T09:00:00.000Z" };
    await history(s.scores, successorKey({ capability: `kvfcu/${NAME}@2.1.0` }), [batch(1, "batch_b"), later]);
    await history(s.scores, successorKey(), [batch(1, "batch_a"), approved(2)]);
    expect((await status(s.deps))?.retiresOn).toBe("2026-04-15");
  });

  test("another tenant's approval and another app version's approval do not count", async () => {
    const s = stores();
    await put(s.majors, record());
    await history(s.scores, successorKey({ tenant: "lakeshore" }), [batch(1, "batch_a"), approved(2)]);
    await history(s.scores, successorKey({ app_version: "9.9" }), [batch(1, "batch_a"), approved(2)]);
    expect((await status(s.deps))?.retiresOn).toBeNull();
    expect((await status(s.deps, "lakeshore"))?.retiresOn).not.toBeNull();
    expect((await status(s.deps, "keystone", "9.9"))?.retiresOn).not.toBeNull();
  });

  test("an approval on the old major's own keys is not the successor's", async () => {
    const s = stores();
    await put(s.majors, record());
    await history(s.scores, successorKey({ capability: `kvfcu/${NAME}@1.0.0` }), [batch(1, "batch_a"), approved(2)]);
    expect((await status(s.deps))?.retiresOn).toBeNull();
  });

  test("the newest approved revision is in force; a newer sealed one is not", async () => {
    const s = stores();
    await put(s.majors, record({ retires_on: "2026-02-01" }));
    await history(s.scores, successorKey(), [batch(1, "batch_a"), approved(2)]);
    await put(s.majors, record({ revision: 2, retires_on: "2026-08-01" }), "seal");
    expect((await status(s.deps))?.retiresOn).toBe("2026-04-15");
    expect((await s.majors.approve(ID, "2", "op_031")).ok).toBe(true);
    expect((await status(s.deps))?.retiresOn).toBe("2026-08-01");
  });
});

describe("checkMajor", () => {
  test("a successor that is not later, or a retire day before the deprecation day, is refused", () => {
    expect(checkMajor(record())).toEqual([]);
    expect(checkMajor(record({ successor: 1 }))).toHaveLength(1);
    expect(checkMajor(record({ retires_on: "2026-01-09" }))).toHaveLength(1);
  });
});
