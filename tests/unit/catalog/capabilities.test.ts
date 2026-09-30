// Proves `resolveMajor`'s app-version filter (M05, section 3 §4.8 checks 4 and 5): with no
// `appVersion` it keeps `capability describe`'s old behavior; with one, it is the resolver
// `runPrechecks` needs, picking the newest sealed version of the major that fits, skipping a
// newer one that does not.
import { describe, expect, test } from "vitest";
import { resolveMajor } from "../../../src/core/catalog/capabilities.js";
import type { Artifact } from "../../../src/core/model/artifact.js";
import { Artifact as ArtifactSchema } from "../../../src/core/model/artifact.js";
import { ManualClock } from "../../../src/fakes/clock.js";
import { FakeCandidateStore } from "../../../src/fakes/stores.js";
import { CandidateDecision } from "../../../src/core/model/candidate-decision.js";
import { CandidateIssues } from "../../../src/core/model/candidate-issues.js";
import { CandidateRuns } from "../../../src/core/model/candidate-runs.js";
import { artifactExample } from "../../fixtures/design-examples.js";

const APP = "kvfcu";
const CAPABILITY = "open_share_subaccount";

/** `artifactExample()`, at `version`, fitting `appVersions`. */
function artifactAt(version: string, appVersions: string[]): Artifact {
  const raw = artifactExample();
  const identity = raw.identity as Record<string, unknown>;
  const runsOn = raw.runs_on as Record<string, unknown>;
  identity.version = version;
  runsOn.app_versions = appVersions;
  const parsed = ArtifactSchema.safeParse(raw);
  if (!parsed.success) throw new Error("artifactExample no longer parses");
  return parsed.data;
}

function store() {
  return new FakeCandidateStore(
    {
      files: { "runs.json": CandidateRuns, "candidate.json": ArtifactSchema, "issues.json": CandidateIssues },
      decision: CandidateDecision,
    },
    new ManualClock(),
  );
}

const DOC_ID = `${APP}/${CAPABILITY}/cand_2026-09-24_7kq2m9x4tb`;

describe("resolveMajor", () => {
  test("with no appVersion, the newest sealed version of the major wins (capability describe)", async () => {
    const candidates = store();
    await candidates.seal(DOC_ID, "1.0.0", "op_017", artifactAt("1.0.0", ["8.*"]), {});
    await candidates.seal(DOC_ID, "1.1.0", "op_017", artifactAt("1.1.0", ["9.*"]), {});
    const found = await resolveMajor(candidates, APP, CAPABILITY, 1);
    expect(found).toMatchObject({ ok: true, value: { identity: { version: "1.1.0" } } });
  });

  test("with an appVersion, the newest version that fits wins, skipping a newer one that does not", async () => {
    const candidates = store();
    await candidates.seal(DOC_ID, "1.0.0", "op_017", artifactAt("1.0.0", ["8.*"]), {});
    await candidates.seal(DOC_ID, "1.1.0", "op_017", artifactAt("1.1.0", ["9.*"]), {});
    const found = await resolveMajor(candidates, APP, CAPABILITY, 1, "8.4");
    expect(found).toMatchObject({ ok: true, value: { identity: { version: "1.0.0" } } });
  });

  test("no sealed version of the major at all is not_found", async () => {
    const found = await resolveMajor(store(), APP, CAPABILITY, 1, "8.4");
    expect(found).toMatchObject({ ok: false, failure: "not_found" });
  });

  test("a sealed major with no version fitting this app version is not_found", async () => {
    const candidates = store();
    await candidates.seal(DOC_ID, "1.0.0", "op_017", artifactAt("1.0.0", ["8.*"]), {});
    const found = await resolveMajor(candidates, APP, CAPABILITY, 1, "9.0");
    expect(found).toMatchObject({ ok: false, failure: "not_found" });
  });

  test("a different major is ignored", async () => {
    const candidates = store();
    await candidates.seal(DOC_ID, "2.0.0", "op_017", artifactAt("2.0.0", ["8.*"]), {});
    const found = await resolveMajor(candidates, APP, CAPABILITY, 1, "8.4");
    expect(found).toMatchObject({ ok: false, failure: "not_found" });
  });
});
