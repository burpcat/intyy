// Proves a deprecated major reaches the caller through `runReplay` (design section 8 §11.9 table,
// section 3 §4.8 check 4, §5.9): past the retire day the result is `rejected` with
// `capability_not_found` and reason `major_retired` (nothing ran); before it, with the successor
// approved here, a successful result carries the `major_version_deprecated` warning; a sealed-only
// record, or a successor not approved here, gives the caller nothing. Fake site, fake clock,
// in-memory stores. M11 task 4.
import { describe, expect, test } from "vitest";
import { majorKind } from "../../../src/core/model/kinds.js";
import { majorId, type Major } from "../../../src/core/model/major.js";
import { HistoryLine, type HistoryLine as HistoryLineT } from "../../../src/core/model/score-history.js";
import { ScoreRecord, type ScoreKey } from "../../../src/core/model/score.js";
import type { Result } from "../../../src/core/model/result.js";
import { runReplay } from "../../../src/core/replay/executor.js";
import { keyPath } from "../../../src/core/trust/keys.js";
import { SteppingClock } from "../../../src/fakes/clock.js";
import { FakeScoreStore } from "../../../src/fakes/score-store.js";
import { FakeDocumentStore } from "../../../src/fakes/stores.js";
import { approved, batch } from "../trust/kit.js";
import { TENANT, authorizationFor, buildHarness, fixtureSite, replayInputOf, requestOf } from "./executor-harness.js";

const SUCCESSOR: ScoreKey = { capability: "kvfcu/open_sub@2.0.0", tenant: TENANT, app_version: "8.4", patch_revision: null };
const AUTH = authorizationFor("kvfcu/open_sub@1");

function major(over: Partial<Major> = {}): Major {
  return {
    schema: "intyy.major/1.0",
    app: "kvfcu",
    capability: "open_sub",
    major: 1,
    revision: 1,
    deprecated_on: "2025-08-01",
    successor: 2,
    retires_on: "2026-06-01",
    by: "op_031",
    reason: "Version 2 replaces it.",
    ...over,
  };
}

/**
 * One run of `kvfcu/open_sub@1` on 2026-01-15, with the record sealed as `how` and the successor's lines
 * given. `lines` null: the successor has no history here.
 */
async function runWith(doc: Major, how: "approve" | "seal", lines: HistoryLineT[] | null): Promise<Result> {
  const majors = new FakeDocumentStore<Major>(majorKind, new SteppingClock());
  const id = majorId(doc);
  await majors.putCandidate(id, doc);
  await majors.seal(id, "op_017");
  if (how === "approve") expect((await majors.approve(id, "1", "op_031")).ok).toBe(true);
  const scores = new FakeScoreStore<HistoryLineT, ScoreRecord>({ line: HistoryLine, record: ScoreRecord });
  for (const line of lines ?? []) await scores.append(keyPath(SUCCESSOR), line);
  const h = await buildHarness(fixtureSite(), { majors, scores });
  const { result } = await runReplay(replayInputOf(h, requestOf({ authorization: AUTH })), h.deps);
  return result;
}

/** The successor's approval written long ago, so 90 days after it has passed: 2025-09-01 gives 2025-11-30. */
const OLD_APPROVAL: HistoryLineT[] = [batch(1, "batch_a"), { ...approved(2), at: "2025-09-01T09:00:00.000Z" }];
/** The successor's approval written on the run's own day: 90 days after it is 2026-04-15. */
const NEW_APPROVAL: HistoryLineT[] = [batch(1, "batch_a"), approved(2)];

describe("a deprecated major through runReplay", () => {
  test("past the retire day: rejected, capability_not_found, reason major_retired, naming the successor", async () => {
    const result = await runWith(major({ retires_on: "2025-10-01" }), "approve", OLD_APPROVAL);
    expect(result.status).toBe("rejected");
    if (result.status !== "rejected") return;
    expect(result.rejection.errors[0]).toMatchObject({ code: "capability_not_found", reason: "major_retired" });
    expect(result.rejection.errors[0]?.message).toContain("kvfcu/open_sub@2");
  });

  test("before the day, successor approved here: the run succeeds and carries the deprecation warning", async () => {
    const result = await runWith(major(), "approve", NEW_APPROVAL);
    expect(result.status).toBe("success");
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatchObject({ code: "major_version_deprecated" });
    expect(result.warnings[0]?.message).toContain("2026-06-01");
  });

  test("the successor is not approved here: the run succeeds with no warning", async () => {
    for (const lines of [null, [batch(1, "batch_a")]]) {
      const result = await runWith(major({ retires_on: "2025-10-01" }), "approve", lines);
      expect(result.status).toBe("success");
      expect(result.warnings).toEqual([]);
    }
  });

  test("a sealed-only record has no effect, even past its day", async () => {
    const result = await runWith(major({ retires_on: "2025-10-01" }), "seal", OLD_APPROVAL);
    expect(result.status).toBe("success");
    expect(result.warnings).toEqual([]);
  });
});
