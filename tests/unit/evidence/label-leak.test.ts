// Proves publish re-checks accessibility snapshots with the label rule: a run holding a snapshot
// whose labelled cell is still raw is refused with `unmasked_label`, naming the file and line and
// never the value, and writes nothing; the same snapshot masked publishes; without `redaction`
// the check does not run. Design section 4 §9.7, section 9 §6.6; the M05 leak in docs/decisions.md.
// The source is one real certify batch (tests/unit/evidence/kit.ts). Values are made up. Seed
// member 100240 is the canary and never appears.
import { describe, expect, test } from "vitest";
import { publishEvidence, type PublishInput } from "../../../src/core/evidence/publish.js";
import { maskA11y } from "../../../src/core/safety/redaction/snapshots.js";
import { LEAK_RULES, NAME, leakRedactor, legacyA11y } from "../safety/label-leak-kit.js";
import { certifyFixture, runPath, TENANT, type Fixture } from "./kit.js";

const raw = [`- row "Name ${NAME}":`, '  - cell "Name"', `  - cell "${NAME}"`, ""].join("\n");
const clean = ['- row "Name [name#1]":', '  - cell "Name"', '  - cell "[name#1]"', ""].join("\n");

/** One publish of the case run, with the redaction rules unless `extra` changes them. */
function publish(f: Fixture, extra: Partial<PublishInput> = {}) {
  return publishEvidence(
    {
      tenant: TENANT,
      targets: [{ kind: "run", id: f.caseRunId }],
      by: "op_017",
      markers: [],
      redaction: LEAK_RULES,
      ...extra,
    },
    { source: f.source, library: f.library, dest: f.dest, clock: f.clock },
  );
}

describe("G: publish and the label rule (§9.7)", () => {
  test("a planted raw labelled cell gives unmasked_label with path and line, no value, no write", async () => {
    const f = await certifyFixture();
    const path = runPath(f.caseRunId, "a11y/00001_x.yaml");
    f.source.seed(path, raw);
    const got = await publish(f);
    expect(got).toMatchObject({ ok: false, failure: "unmasked_label" });
    if (got.ok) return;
    expect(got.detail).toContain(path);
    expect(got.detail).toContain("line 3");
    expect(got.detail).not.toContain("Marlowquist");
    expect(got.detail).not.toContain(NAME);
    expect(f.dest.paths()).toEqual([]);
  });

  test("a fixture's a11y.yaml is checked too", async () => {
    const f = await certifyFixture();
    f.source.seed(runPath(f.caseRunId, "fixture/a11y.yaml"), raw);
    const got = await publish(f);
    expect(got).toMatchObject({ ok: false, failure: "unmasked_label" });
    expect(f.dest.paths()).toEqual([]);
  });

  test("a file that is not a snapshot is not checked", async () => {
    const f = await certifyFixture();
    f.source.seed(runPath(f.caseRunId, "notes.yaml"), raw);
    expect(await publish(f)).toMatchObject({ ok: true });
  });

  test("the same snapshot, masked, publishes", async () => {
    const f = await certifyFixture();
    f.source.seed(runPath(f.caseRunId, "a11y/00001_x.yaml"), clean);
    const got = await publish(f);
    expect(got).toMatchObject({ ok: true });
    expect(f.dest.paths()).toContain(`${TENANT}/runs/${f.caseRunId}/a11y/00001_x.yaml`);
  });

  test("the output of maskA11y on a legacy page publishes", async () => {
    const f = await certifyFixture();
    f.source.seed(runPath(f.caseRunId, "a11y/00002_legacy.yaml"), maskA11y(legacyA11y(), leakRedactor()));
    expect(await publish(f)).toMatchObject({ ok: true });
  });

  test("without redaction rules the check does not run", async () => {
    const f = await certifyFixture();
    f.source.seed(runPath(f.caseRunId, "a11y/00001_x.yaml"), raw);
    const got = await publishEvidence(
      { tenant: TENANT, targets: [{ kind: "run", id: f.caseRunId }], by: "op_017", markers: [] },
      { source: f.source, library: f.library, dest: f.dest, clock: f.clock },
    );
    expect(got).toMatchObject({ ok: true });
  });
});
