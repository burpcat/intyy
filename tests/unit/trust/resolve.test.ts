// Proves the resolver's key choice (design section 8 §11.2 candidates, §11.3 unattended, §11.4
// supervised, §4 states): `pickKey` unattended takes the one approved key, not the newest, and
// says why when there is none (`not_approved`, `degraded`); supervised takes the first rule that
// finds a key (approved, then the newest whose latest full batch passed the gate, then the newest
// without a `wrong` verdict), skips retired keys, and is `blocked` when every version lied about
// data; other tenants, other app versions, and patch keys never count. `contextState` ranks a
// context's keys for `capability list`, and `loadRecords` leaves out a key with no readable
// record (it counts as a draft). No files. M10 task 6.
import { describe, expect, test } from "vitest";
import { Artifact as ArtifactSchema, type Artifact } from "../../../src/core/model/artifact.js";
import { HistoryLine } from "../../../src/core/model/score-history.js";
import { ScoreRecord, type ScoreKey } from "../../../src/core/model/score.js";
import { keyPath } from "../../../src/core/trust/keys.js";
import { rebuild } from "../../../src/core/trust/rebuild.js";
import { contextState, loadRecords, pickKey, type PickResult, type Scope } from "../../../src/core/trust/resolve.js";
import { FakeScoreStore } from "../../../src/fakes/score-store.js";
import { artifactExample } from "../../fixtures/design-examples.js";
import { approved, batch, degraded, HASHES, retired, SCORES } from "./kit.js";

const NAME = "kvfcu/open_share_subaccount";

/** The design's example artifact at `version`. */
function artifactAt(version: string): Artifact {
  const a = ArtifactSchema.parse(artifactExample());
  return { ...a, identity: { ...a.identity, version } };
}

const key = (version: string, over: Partial<ScoreKey> = {}): ScoreKey => ({
  capability: `${NAME}@${version}`,
  tenant: "keystone",
  app_version: "8.4",
  patch_revision: null,
  ...over,
});

/** The record of `version` that the lines give. */
function rec(version: string, lines: HistoryLine[], over: Partial<ScoreKey> = {}): ScoreRecord {
  const r = rebuild(key(version, over), HASHES, lines);
  if (!r.ok) throw new Error("test setup: rebuild failed");
  return r.value;
}

const WRONG = { ...SCORES, verdicts: { ...SCORES.verdicts, wrong: 1 } };
/** Batch lines: a full batch that passed, one that failed with no wrong verdict, one that failed with a wrong verdict. */
const PASSED = batch(1, "batch_p");
const FAILED = batch(1, "batch_f", { gate: "failed" });
const LIED = batch(1, "batch_w", { gate: "failed", scores: WRONG });

const scope = (records: ScoreRecord[], major = 1): Scope => ({ tenant: "keystone", appVersion: "8.4", name: NAME, major, records });
const FITTING = [artifactAt("1.0.0"), artifactAt("1.1.0")];

/** The version `pickKey` chose, or its non-key result. */
const chose = (r: PickResult): string => (r.kind === "key" ? (r.artifact.identity.version ?? "?") : r.kind === "none" ? `none:${r.reason}` : "blocked");

describe("pickKey, unattended: the one approved key", () => {
  test("pickKey in unattended mode takes only the one approved key", () => {
    // takes the approved version, not the newest sealed one
    {
      const records = [rec("1.0.0", [PASSED, approved(2)])];
      const r = pickKey("unattended", scope(records), FITTING);
      expect(chose(r)).toBe("1.0.0");
      expect(r.kind === "key" ? r.record?.state : null).toBe("approved");
    }
    // no record at all: none, not_approved
    expect(chose(pickKey("unattended", scope([]), FITTING))).toBe("none:not_approved");
    // the approved key is degraded: none, degraded
    {
      const records = [rec("1.0.0", [PASSED, approved(2), degraded(3)])];
      expect(chose(pickKey("unattended", scope(records), FITTING))).toBe("none:degraded");
    }
    // the key was retired with no successor: none, not_approved
    {
      const records = [rec("1.0.0", [PASSED, approved(2), retired(3)])];
      expect(chose(pickKey("unattended", scope(records), FITTING))).toBe("none:not_approved");
    }
    // only a draft with a passing batch: none, not_approved (a batch alone is not approval)
    {
      const records = [rec("1.0.0", [PASSED])];
      expect(chose(pickKey("unattended", scope(records), FITTING))).toBe("none:not_approved");
    }
    // the degraded key is older than a newer one that was approved and retired: not_approved
    {
      const records = [
        rec("1.0.0", [PASSED, approved(2), degraded(3)]),
        rec("1.1.0", [PASSED, approved(5), retired(6)]),
      ];
      expect(chose(pickKey("unattended", scope(records), FITTING))).toBe("none:not_approved");
    }
    // an approved key of another tenant, another app version, or a patch does not count
    {
      const records = [
        rec("1.0.0", [PASSED, approved(2)], { tenant: "lakeshore" }),
        rec("1.0.0", [PASSED, approved(2)], { app_version: "8.3" }),
        rec("1.0.0", [PASSED, approved(2)], { patch_revision: 2 }),
      ];
      expect(chose(pickKey("unattended", scope(records), FITTING))).toBe("none:not_approved");
    }
    // another major's approved key does not count
    {
      const records = [rec("2.0.0", [PASSED, approved(2)])];
      expect(chose(pickKey("unattended", scope(records), FITTING))).toBe("none:not_approved");
    }
  });
});

describe("pickKey, supervised: the first rule that finds a key", () => {
  test("pickKey in supervised mode follows its rules in order and never gives none", () => {
    // 1. the approved key beats a newer certified one
    {
      const records = [rec("1.0.0", [PASSED, approved(2)]), rec("1.1.0", [PASSED])];
      expect(chose(pickKey("supervised", scope(records), FITTING))).toBe("1.0.0");
    }
    // 2. the newest certified key beats a newer one with no batch
    {
      const records = [rec("1.0.0", [PASSED])];
      expect(chose(pickKey("supervised", scope(records), FITTING))).toBe("1.0.0");
      const both = [rec("1.0.0", [PASSED]), rec("1.1.0", [PASSED])];
      expect(chose(pickKey("supervised", scope(both), FITTING))).toBe("1.1.0");
    }
    // 3. the newest sealed key without a wrong verdict
    {
      expect(chose(pickKey("supervised", scope([]), FITTING))).toBe("1.1.0");
      const records = [rec("1.0.0", [FAILED]), rec("1.1.0", [LIED])];
      expect(chose(pickKey("supervised", scope(records), FITTING))).toBe("1.0.0");
    }
    // 3. a degraded key is still a candidate; its failures were honest
    {
      const records = [rec("1.0.0", [FAILED, approved(2), degraded(3)])];
      expect(chose(pickKey("supervised", scope(records), [artifactAt("1.0.0")]))).toBe("1.0.0");
    }
    // every version had a wrong verdict: blocked
    {
      const records = [rec("1.0.0", [LIED]), rec("1.1.0", [LIED])];
      expect(chose(pickKey("supervised", scope(records), FITTING))).toBe("blocked");
    }
    // a retired key is never a candidate
    {
      const records = [rec("1.1.0", [PASSED, approved(2), retired(3)])];
      expect(chose(pickKey("supervised", scope(records), FITTING))).toBe("1.0.0");
      expect(chose(pickKey("supervised", scope(records), [artifactAt("1.1.0")]))).toBe("blocked");
    }
    // a supervised request never gets `none`: no record still picks the newest fitting version
    expect(pickKey("supervised", scope([]), FITTING).kind).toBe("key");
  });
});

describe("contextState", () => {
  const state = (records: ScoreRecord[]) => contextState(records, "keystone", "8.4", NAME, 1);

  test("contextState ranks approved over degraded, retired, and draft, and counts only its own context", () => {
    // approved outranks degraded, retired, and draft
    {
      const d = rec("1.0.0", [PASSED, approved(2), degraded(3)]);
      const r = rec("1.1.0", [PASSED, approved(2), retired(3)]);
      const a = rec("1.2.0", [PASSED, approved(2)]);
      expect(state([r, d, a])).toBe("approved");
      expect(state([r, d])).toBe("degraded");
      expect(state([r])).toBe("retired");
      expect(state([rec("1.0.0", [PASSED])])).toBe("draft");
      expect(state([])).toBe("draft");
    }
    // another tenant, app version, or major does not count; an unknown app version means any
    {
      const a = rec("1.0.0", [PASSED, approved(2)]);
      expect(contextState([a], "lakeshore", "8.4", NAME, 1)).toBe("draft");
      expect(contextState([a], "keystone", "9.0", NAME, 1)).toBe("draft");
      expect(contextState([a], "keystone", "8.4", NAME, 2)).toBe("draft");
      expect(contextState([a], "keystone", undefined, NAME, 1)).toBe("approved");
    }
  });
});

describe("loadRecords", () => {
  test("reads the tenant's records; a key with history but no record file counts as a draft", async () => {
    const store = new FakeScoreStore({ line: HistoryLine, record: ScoreRecord });
    const good = rec("1.0.0", [PASSED, approved(2)]);
    await store.putRecord(keyPath(good.key), good);
    await store.append(keyPath(key("1.1.0")), PASSED);
    const other = rec("1.0.0", [PASSED, approved(2)], { tenant: "lakeshore" });
    await store.putRecord(keyPath(other.key), other);

    const got = await loadRecords(store, "keystone");
    expect(got).toEqual([good]);
    expect(chose(pickKey("unattended", scope(got), [artifactAt("1.1.0")]))).toBe("none:not_approved");
  });
});
