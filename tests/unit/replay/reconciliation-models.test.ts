// Proves the model steps of reconciliation, as pure units: `reconcileInput` masks free text, and
// `reconcileWithModels` asks jev, then the second opinion, and settles only `found`. Every other
// answer, a missing model, or a failed call goes to a human, and a model never says nothing
// changed. Design section 5 §10.5 to §10.7, section 7 §11.1, CLAUDE.md ("Only plain code may say
// nothing changed"). M09 task 6.
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { Config } from "../../../src/core/model/config.js";
import {
  reconcileInput,
  reconcileWithModels,
  type CheckFacts,
} from "../../../src/core/replay/reconciliation.js";
import type { LogLine } from "../../../src/core/orchestrator/run-log.js";
import { Redactor } from "../../../src/core/safety/redaction/redactor.js";
import { Secret } from "../../../src/ports/secret.js";
import { TableClassifier } from "../../../src/fakes/table-classifier.js";
import { TableReviewer } from "../../../src/fakes/table-reviewer.js";
import type { Row } from "../../../src/fakes/table.js";
import type { JevReconcileOutput } from "../../../src/ports/models.js";
import { RULES } from "../discovery/kit.js";
import { recorder, type Recorded } from "../fakes/table-kit.js";

const CANARY = Config.parse(JSON.parse(readFileSync("intyy.json", "utf8"))).canary_members[0] ?? "";

const FACTS: CheckFacts = {
  capability: "app/check@1",
  status: "failed",
  outcome: null,
  failure: { code: "checkpoint_timeout", step: "read_result", phase: "checkpoint", trace: [] },
  finalScreen: { location: "/check", elements: [{ role: "row", name: "Share Savings OPEN" }] },
  notFoundOutcomes: ["sub_not_found"],
};

function inputOf(r = new Redactor(RULES)) {
  return reconcileInput(
    r,
    {
      capability: "app/open@1",
      commitStep: { id: "click_confirm", intent: "Confirm and open" },
      correlation: "notes",
      screen: { location: "/accounts/new", elements: [{ role: "heading", name: "Server Error" }] },
    },
    FACTS,
  );
}

const say = (verdict: JevReconcileOutput["verdict"], confidence: number): Row<JevReconcileOutput> => ({
  when: {},
  reply: { answer: { verdict, confidence } },
});

/** Runs `reconcileWithModels` over scripted models. `null` means that model is missing. */
async function run(
  jev: Row<JevReconcileOutput> | null,
  reviewer: Row<JevReconcileOutput> | null,
  min = 0.9,
) {
  const c = jev === null ? null : new TableClassifier({ reconcile: [jev] });
  const v = reviewer === null ? null : new TableReviewer({ secondOpinion: [reviewer] });
  const lines: LogLine[] = [];
  const recorded: Recorded[] = [];
  const asked: string[] = [];
  const answer = await reconcileWithModels({
    jev: c,
    reviewer: v,
    min,
    input: inputOf(),
    step: "click_confirm",
    recorder: (who) => {
      asked.push(who);
      return { record: recorder(recorded), request: `llm/00007_${who}_request.json` };
    },
    log: (l) => lines.push(l),
  });
  return { answer, lines, asked, recorded, c, v };
}

const recon = (lines: LogLine[]) => lines.filter((l) => l.event === "reconciliation");
const warnings = (lines: LogLine[]) =>
  lines.filter((l) => l.event === "warning").map((l) => (l.data as { code: string }).code);

describe("reconcileWithModels: both models sure and agreeing", () => {
  test("two sure and agreeing models give found, with both lines logged in order", async () => {
    // jev found 0.95 and reviewer found 0.95 give found; the lines run jev then reviewer.
    {
      const t = await run(say("found", 0.95), say("found", 0.95));
      expect(t.answer).toBe("found");
      expect(t.asked).toEqual(["jev", "reviewer"]);
      expect(recon(t.lines).map((l) => l.by)).toEqual(["jev", "reviewer"]);
      expect(recon(t.lines)[0]).toMatchObject({
        event: "reconciliation",
        step: "click_confirm",
        data: { verdict: "found", confidence: 0.95, threshold: 0.9, input: "llm/00007_jev_request.json" },
      });
      expect(recon(t.lines)[1]?.data).toMatchObject({ input: "llm/00007_reviewer_request.json" });
      expect(t.c?.seen).toHaveLength(1);
      expect(t.v?.seen).toHaveLength(1);
    }

    // both get the same masked input.
    {
      const t = await run(say("found", 0.95), say("found", 0.95));
      expect(t.v?.seen[0]?.input).toEqual(t.c?.seen[0]?.input);
    }

    // a confidence exactly at the minimum counts.
    {
      expect((await run(say("found", 0.9), say("found", 0.9))).answer).toBe("found");
    }
  });
});

describe("reconcileWithModels: anything else goes to a human", () => {
  test("any answer short of two sure found answers goes to a human", async () => {
    // jev found, reviewer not_found: human.
    {
      const t = await run(say("found", 0.95), say("not_found", 0.99));
      expect(t.answer).toBe("human");
      expect(t.asked).toEqual(["jev", "reviewer"]);
    }

    // jev found, reviewer found below the minimum: human.
    {
      expect((await run(say("found", 0.95), say("found", 0.85))).answer).toBe("human");
    }

    // jev found, reviewer unclear: human.
    {
      expect((await run(say("found", 0.95), say("unclear", 0.99))).answer).toBe("human");
    }

    // jev found 0.85 is under the minimum: human, and the reviewer is never called.
    {
      const t = await run(say("found", 0.85), say("found", 0.99));
      expect(t.answer).toBe("human");
      expect(t.asked).toEqual(["jev"]);
      expect(t.v?.seen).toEqual([]);
      expect(recon(t.lines)).toHaveLength(1);
      // The line shows what the engine made of it: unclear, with jev's own confidence.
      expect(recon(t.lines)[0]?.data).toMatchObject({ verdict: "unclear", confidence: 0.85 });
    }

    // jev not_found 0.99 is human, and the reviewer is not asked (a model never says nothing changed).
    {
      const t = await run(say("not_found", 0.99), say("not_found", 0.99));
      expect(t.answer).toBe("human");
      expect(t.asked).toEqual(["jev"]);
      expect(t.v?.seen).toEqual([]);
    }

    // jev unclear: human, reviewer not asked.
    {
      const t = await run(say("unclear", 0.99), say("found", 0.99));
      expect(t.answer).toBe("human");
      expect(t.v?.seen).toEqual([]);
    }

    // no jev: human, and nothing is logged or recorded.
    {
      const t = await run(null, say("found", 0.99));
      expect(t.answer).toBe("human");
      expect(t.asked).toEqual([]);
      expect(t.lines).toEqual([]);
      expect(t.v?.seen).toEqual([]);
    }

    // no reviewer: human, even when jev is sure found.
    {
      const t = await run(say("found", 0.99), null);
      expect(t.answer).toBe("human");
      expect(t.asked).toEqual(["jev"]);
    }
  });
});

describe("reconcileWithModels: a failing model (section 5 §10.7)", () => {
  test("a failing model or an unstorable request goes to a human with the right warning", async () => {
    // jev times out: human, warning classifier_unavailable, verdict unclear at 0.
    {
      const t = await run({ when: {}, reply: { failure: "timeout" } }, say("found", 0.99));
      expect(t.answer).toBe("human");
      expect(warnings(t.lines)).toEqual(["classifier_unavailable"]);
      expect(recon(t.lines)[0]?.data).toMatchObject({ verdict: "unclear", confidence: 0 });
      expect(t.v?.seen).toEqual([]);
    }

    // jev unavailable: human with classifier_unavailable.
    {
      const t = await run({ when: {}, reply: { failure: "unavailable" } }, say("found", 0.99));
      expect(t.answer).toBe("human");
      expect(warnings(t.lines)).toEqual(["classifier_unavailable"]);
    }

    // jev bad output: human with classifier_invalid_output.
    {
      const t = await run({ when: {}, reply: { raw: { verdict: "maybe" } } }, say("found", 0.99));
      expect(t.answer).toBe("human");
      expect(warnings(t.lines)).toEqual(["classifier_invalid_output"]);
      expect(t.v?.seen).toEqual([]);
    }

    // reviewer times out after a sure jev found: human, with the warning.
    {
      const t = await run(say("found", 0.95), { when: {}, reply: { failure: "timeout" } });
      expect(t.answer).toBe("human");
      expect(warnings(t.lines)).toEqual(["classifier_unavailable"]);
      expect(recon(t.lines).map((l) => l.by)).toEqual(["jev", "reviewer"]);
    }

    // reviewer bad output: human.
    {
      const t = await run(say("found", 0.95), { when: {}, reply: { raw: 7 } });
      expect(t.answer).toBe("human");
      expect(warnings(t.lines)).toEqual(["classifier_invalid_output"]);
    }

    // a request that cannot be stored means the model is never sent: human.
    {
      const c = new TableClassifier({ reconcile: [say("found", 0.99)] });
      const lines: LogLine[] = [];
      const answer = await reconcileWithModels({
        jev: c,
        reviewer: null,
        min: 0.9,
        input: inputOf(),
        step: "click_confirm",
        recorder: () => ({ record: recorder([], "request"), request: "llm/00001_jev_request.json" }),
        log: (l) => lines.push(l),
      });
      expect(answer).toBe("human");
      expect(warnings(lines)).toEqual(["classifier_unavailable"]);
    }
  });
});

describe("safety: no answer can be anything but found or human", () => {
  const verdicts = ["found", "not_found", "unclear"] as const;
  const confidences = [0, 0.5, 0.89, 0.9, 0.95, 1];

  test("only two sure found answers settle, and a failing model never settles", async () => {
    // every pair of answers settles as found or human; absent_by_check and refused never appear.
    {
      for (const a of verdicts)
        for (const b of verdicts)
          for (const ca of confidences)
            for (const cb of confidences) {
              const t = await run(say(a, ca), say(b, cb));
              expect(["found", "human"]).toContain(t.answer);
              // Only two sure `found` answers settle anything.
              const sure = (v: string, c: number) => v === "found" && c >= 0.9;
              expect(t.answer === "found").toBe(sure(a, ca) && sure(b, cb));
              expect(JSON.stringify(t.lines)).not.toMatch(/absent_by_check|refused/);
            }
    }

    // a failing jev or reviewer never settles.
    {
      for (const failure of ["timeout", "unavailable", "refused", "invalid_output"] as const) {
        expect((await run({ when: {}, reply: { failure } }, say("found", 1))).answer).toBe("human");
        expect((await run(say("found", 1), { when: {}, reply: { failure } })).answer).toBe("human");
      }
    }
  });
});

describe("reconcileInput masks free text (section 4 §9.5; section 5 §10.5)", () => {
  test("reconcileInput masks secrets, keeps the shape, and passes elements through", () => {
    // the canary and a bound secret never reach the input, and the shape follows section 5 §10.5.
    {
      const r = new Redactor(RULES);
      r.addKnown({ ref: "input.member_id", value: CANARY, label: "pii", type: "text", kind: "member" });
      r.addSecret("operator_username", new Secret("kv_teller_4821"));
      const i = reconcileInput(
        r,
        {
          capability: "app/open@1",
          commitStep: { id: "click_confirm", intent: `Confirm for ${CANARY} by kv_teller_4821` },
          correlation: "none",
          screen: { location: `/members/${CANARY}/new`, elements: [] },
        },
        { ...FACTS, finalScreen: { location: `/members/${CANARY}`, elements: [] } },
      );
      const text = JSON.stringify(i);
      expect(text).not.toContain(CANARY);
      expect(text).not.toContain("kv_teller_4821");
      expect(i).toMatchObject({
        schema: "intyy.jev.reconcile/1.0",
        parent: { capability: "app/open@1", commit_step: { id: "click_confirm" }, correlation: "none" },
        check: { capability: "app/check@1", status: "failed", outcome: null, failure: { code: "checkpoint_timeout" } },
        not_found_outcomes: ["sub_not_found"],
      });
    }

    // the check's own elements pass through unchanged (already masked on disk).
    {
      const i = inputOf();
      expect(i.check.final_screen.elements).toEqual([{ role: "row", name: "Share Savings OPEN" }]);
      expect(i.parent.last_screen.elements).toEqual([{ role: "heading", name: "Server Error" }]);
    }

    // a check with no failure gives failure null.
    {
      const i = reconcileInput(
        new Redactor(RULES),
        { capability: "a/b@1", commitStep: { id: "s", intent: "x" }, correlation: "none", screen: { location: "/", elements: [] } },
        { ...FACTS, status: "business_outcome", outcome: "other", failure: null },
      );
      expect(i.check).toMatchObject({ status: "business_outcome", outcome: "other", failure: null });
    }
  });
});
