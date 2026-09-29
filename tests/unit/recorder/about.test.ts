// Proves about.ts (section 6 §14.14): `about`, and provenance's runs, actions, and decisions.
import { describe, expect, test } from "vitest";
import { RunSpec } from "../../../src/core/model/runspec.js";
import {
  buildAbout,
  buildProvenanceActions,
  buildProvenanceDecisions,
  buildProvenanceRun,
} from "../../../src/core/recorder/about.js";
import type { TaggedAction } from "../../../src/core/recorder/tags.js";

const SPEC = RunSpec.parse({
  schema: "intyy.runspec/1.0",
  kind: "discovery",
  caller: { tenant: "keystone", agent_id: "op_017" },
  app: "kvfcu",
  capability: "open_share_subaccount",
  goal: "Open a share sub-account for {input.member_id}.",
  inputs: [
    { name: "member_id", type: "string", description: "the member's ID", sensitivity: "pii", example: "100107" },
  ],
  outputs: [],
  expected_effect: "commits",
  session: null,
  entry: "/home",
  model: "claude-sonnet-5",
  prompt: "discovery@1.0",
});

describe("buildAbout", () => {
  test("titles from the capability; the goal's references become input descriptions", () => {
    const about = buildAbout(SPEC);
    expect(about.title).toBe("Open share subaccount");
    expect(about.summary).toBe("Open a share sub-account for the member's ID.");
    expect(about.when_to_use).toBe("");
    expect(about.limits).toBe("");
  });
});

describe("buildProvenanceRun", () => {
  test("carries the spec's goal, and the recorder version", () => {
    expect(buildProvenanceRun(SPEC, "run_2026-09-24_7kq2m9x4tb", "discovery", "0.1.0")).toEqual({
      run_id: "run_2026-09-24_7kq2m9x4tb",
      kind: "discovery",
      goal: SPEC.goal,
      model: "claude-sonnet-5",
      recorder_version: "0.1.0",
    });
  });
});

describe("buildProvenanceActions and buildProvenanceDecisions", () => {
  test("a human tag decision names decided_by; recovery decisions fold onto edit", () => {
    const a = {
      runId: "run_2026-09-24_7kq2m9x4tb",
      seq: 5,
      humanTag: "incidental",
      tag: "flow_step",
    } as unknown as TaggedAction;
    const decisions = [
      { schema: "intyy.candidate_decision/1.0" as const, what: "tag" as const, subject: "run_2026-09-24_7kq2m9x4tb#5", value: "incidental", by: "op_017", at: "2026-09-24T14:00:00Z" },
      { schema: "intyy.candidate_decision/1.0" as const, what: "recovery" as const, subject: "recovery.reconciliation.check.capability", value: "kvfcu/find_account@1", by: "op_017", at: "2026-09-24T14:05:00Z" },
    ];
    const actions = buildProvenanceActions([a], decisions, () => "handler_draft:kyc_reminder");
    expect(actions).toEqual([
      {
        run_id: "run_2026-09-24_7kq2m9x4tb",
        seq: 5,
        llm_tag: "flow_step",
        human_tag: "incidental",
        decided_by: "op_017",
        became: "handler_draft:kyc_reminder",
      },
    ]);
    expect(buildProvenanceDecisions(decisions)).toEqual([
      {
        what: "edit",
        subject: "recovery.reconciliation.check.capability",
        value: "kvfcu/find_account@1",
        by: "op_017",
        at: "2026-09-24T14:05:00Z",
      },
    ]);
  });
});
