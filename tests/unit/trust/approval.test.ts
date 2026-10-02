// Proves the pure approval rules and the approval screen (design section 8 §10.2 four eyes, §10.3
// what the approver sees, §10.4 rules to approve; section 9 §9.3 the screen's three blocks and the
// closing record hash): `approvalBlocks` blocks an approver who sealed the artifact (and an
// artifact with no sealer, which fails safe), lets another approver through, and does not apply the
// sealer rule to a restore; `renderReview(buildReview(facts))` gives the same text from the same
// facts, short and full, for a clean key, a blocked key, and a key with a fragile step, matching
// a golden file written out by hand and reviewed against the example screen; the last line is
// `RECORD <hash>`. No files, no clock. M10 task 5.
//
// To update the golden file after a deliberate screen change, run:
//   UPDATE_GOLDEN=1 npx vitest run tests/unit/trust/approval.test.ts
// and read the diff against section 9 §9.3 before committing it.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { BatchReport } from "../../../src/core/model/batch-report.js";
import { hashJson } from "../../../src/core/model/canonical.js";
import type { HistoryLine } from "../../../src/core/model/score-history.js";
import { approvalBlocks, buildReview, type ReviewFacts } from "../../../src/core/trust/approval.js";
import { rebuild, recordHash } from "../../../src/core/trust/rebuild.js";
import { renderReview } from "../../../src/core/trust/review-screen.js";
import { approved, batch, degraded, h, HASHES, KEY, SCORES } from "./kit.js";

const GOLDEN = fileURLToPath(new URL("../../fixtures/golden/trust-review-screens.txt", import.meta.url));

const RULES = { complete: true, no_wrong: true, baseline: true, matrix: true, extra: true, no_void: true };

/** A full-batch report: one `pass` case and, with `bad`, one `wrong` case and a failed matrix rule. */
function report(bad = false, extraWrong = 0): BatchReport {
  const pass = { case_id: "baseline_1", run_id: "run_1", class: "valid", result: { status: "success" as const, detail: null }, truth: {}, verdict: "pass" as const };
  return BatchReport.parse({
    schema: "intyy.batch_report/1.0",
    batch_id: "batch_a",
    tenant: "keystone",
    app: "kvfcu",
    capability: "kvfcu/open_share_subaccount@1",
    ended_at: "2026-01-15T09:00:00.000Z",
    kind: "full",
    cases: bad
      ? [pass, ...Array.from({ length: 1 + extraWrong }, (_, i) => ({ ...pass, case_id: `matrix_${String(i + 2)}`, run_id: `run_${String(i + 2)}`, verdict: "wrong" as const }))]
      : [pass],
    gate: { passed: !bad, rules: { ...RULES, ...(bad ? { matrix: false, no_wrong: false } : {}) } },
    outcome_score: 0.97,
    verdicts: bad ? { ...SCORES.verdicts, pass: 1, wrong: 1 + extraWrong } : SCORES.verdicts,
    margin: { lowest: 0.24, step: "open_member", targets: { open_member: { step: "open_member", lowest: 0.24, median: 0.52, score_low: 0.91 } } },
    fragile: ["open_member"],
    coverage_gaps: ["hang with the window closed", "logout with the window closed"],
    stability: null,
  });
}

type Over = { bad?: boolean; fragile?: boolean; lines?: HistoryLine[]; staff?: ReviewFacts["who"]; sealer?: string | null };

/** Fixed facts: a draft key with one full batch (`report(bad)`), a fresh batch, and an approved session link. */
function facts(o: Over = {}): ReviewFacts {
  const r = report(o.bad === true);
  const scores = o.fragile === false ? { ...SCORES, fragile: [] } : SCORES;
  const lines: HistoryLine[] = [
    batch(1, "batch_a", { report_hash: hashJson(r), gate: o.bad === true ? "failed" : "passed", scores }),
    ...(o.lines ?? []),
  ];
  const rec = rebuild(KEY, HASHES, lines);
  if (!rec.ok) throw new Error("test setup: rebuild failed");
  return {
    key: KEY,
    record: rec.value,
    batchId: "batch_a",
    report: r,
    now: { engine: "0.4.0", handlerSet: h("handlers") },
    artifactSealed: true,
    links: [{ role: "session", link: "kvfcu/sign_in@1", approved: o.bad === true ? null : "kvfcu/sign_in@1.0.0" }],
    sealer: o.sealer === undefined ? "op_017" : o.sealer,
    who: o.staff === undefined ? { staff: "op_022", roles: ["approver"] } : o.staff,
    decisions: [],
    prior: [],
  };
}

const codesOf = (f: ReviewFacts, move?: "approve" | "restore"): string[] => approvalBlocks(f, move).map((b) => b.code);

describe("approvalBlocks: four eyes", () => {
  test("approvalBlocks applies four eyes, the approver role, and the restore rule", () => {
    // an approver who sealed the artifact is blocked, and only by four_eyes
    {
      const f = facts({ staff: { staff: "op_017", roles: ["approver"] } });
      expect(codesOf(f)).toEqual(["four_eyes"]);
    }
    // another approver passes
    expect(codesOf(facts())).toEqual([]);
    // an artifact with no sealer fails safe
    expect(codesOf(facts({ sealer: null }))).toEqual(["four_eyes"]);
    // with no staff ID, role and sealer rules are not checked
    expect(codesOf(facts({ staff: null, sealer: null }))).toEqual([]);
    // a restore has no sealer rule
    {
      const f = facts({ lines: [approved(2, "op_022"), degraded(3)], staff: { staff: "op_017", roles: ["approver"] } });
      // The batch (minute 1) is older than the demotion (minute 3): the only block is the batch rule.
      expect(codesOf(f, "restore")).toEqual(["not_new_batch"]);
    }
    // a staff ID without the approver role gets role
    expect(codesOf(facts({ staff: { staff: "op_031", roles: ["operator"] } }))).toEqual(["role"]);
  });
});

/** The three situations of the golden file. */
const SITUATIONS: [string, ReviewFacts][] = [
  ["clean: a fresh passing batch, no fragile step", facts({ fragile: false })],
  ["blocked: a failed gate and a link not approved", facts({ bad: true })],
  ["fragile: one step needs a note", facts()],
];

function screens(): string {
  return SITUATIONS.flatMap(([name, f]) =>
    [false, true].map((full) => `===== ${name} (${full ? "full" : "short"}) =====\n${renderReview(buildReview(f), full)}\n`),
  ).join("\n");
}

describe("the approval screen", () => {
  test("the approval screen is stable, lists blocks and runs, shows stale and jev lines, and matches the golden file", () => {
    // each situation gives the same text for the same facts, ending with the record hash
    for (const [name, f] of SITUATIONS) {
      for (const full of [false, true]) {
        const text = renderReview(buildReview(f), full);
        expect(renderReview(buildReview(f), full), name).toBe(text);
        expect(text.split("\n").at(-1), name).toBe(`RECORD ${recordHash(f.record)}`);
      }
    }
    // a blocked key lists its blocks, a fragile key names its step and its --ack
    {
      const blocked = renderReview(buildReview(facts({ bad: true })));
      expect(blocked).toContain("gate_failed");
      expect(blocked).toContain("link_not_approved");
      const fragile = renderReview(buildReview(facts()));
      expect(fragile).toContain("--ack open_member");
      expect(renderReview(buildReview(facts({ fragile: false })))).toContain("BLOCKS APPROVAL\n  none");
    }
    // the short screen lists five runs that were not pass and says how many more; --full lists all
    {
      const f = { ...facts({ bad: true }), report: report(true, 6) };
      const short = renderReview(buildReview(f));
      expect(short.match(/^ {2}matrix_\d+ /gm)).toHaveLength(5);
      expect(short).toContain("and 2 more; see report.json, or --full");
      const full = renderReview(buildReview(f), true);
      expect(full.match(/^ {2}matrix_\d+ /gm)).toHaveLength(7);
      expect(full).not.toContain("more; see report.json");
    }
    // a changed engine shows as STALE on the screen and as a stale block
    {
      const f = { ...facts(), now: { engine: "0.5.0", handlerSet: h("handlers") } };
      expect(renderReview(buildReview(f))).toContain("engine STALE 0.4.0 then, 0.5.0 now");
      expect(codesOf(f)).toEqual(["stale"]);
    }
    // the jev and autonomy lines show the batch's labelled calls and the record's autonomy (section 8 §14.2)
    {
      const calls = [
        { case_id: "drill_1", run_id: "run_1", answer: "found", truth: "found", label: "right" },
        { case_id: "drill_2", run_id: "run_2", answer: "not_found", truth: "not_found", label: "right" },
        { case_id: "drill_3", run_id: "run_3", answer: "unclear", truth: "found", label: "below_threshold" },
      ];
      const scope = { check: "kvfcu/find_account_by_reference@1.0.0", check_patch: null, jev: "jev@fake" };
      const earned: HistoryLine = {
        event: "autonomy", at: "2026-01-15T09:10:00.000Z", by: "certify", reason: "batch_a", action: "earned", evidence: ["batch_a"], scope,
        counts: { correct: 10, found: 5, not_found: 5, wrong: 0, unclear: 1 },
      };
      const f = facts({ lines: [earned] });
      const text = renderReview(buildReview({ ...f, report: BatchReport.parse({ ...report(), jev: { version: "jev@fake", calls } }) }));
      expect(text).toContain("jev@fake: 3 labelled calls, 2 right, 0 wrong, 1 unclear");
      expect(text).toContain("autonomy: earning (10/20 correct, 5/5 found, 5/5 not_found, 0 wrong)");
      expect(renderReview(buildReview(f))).toContain("no labelled calls yet   autonomy: earning");
    }
    // the screens match the golden file
    if (process.env.UPDATE_GOLDEN === "1") writeFileSync(GOLDEN, screens());
    expect(screens()).toBe(readFileSync(GOLDEN, "utf8"));
  });
});
