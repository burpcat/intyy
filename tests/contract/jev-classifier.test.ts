// Proves the jev classifier adapter (TypeSafe AI's Jev, SDK `@typesafe-ai/sdk`) with an injected
// fetch and no network: labels map to the core's trouble and reconcile outputs with jev's
// `confidence`; the request names the pinned model `jev-1.13.0` and offers the right labels;
// the stored request equals the sent request and the reply is stored after it; a failed write
// sends nothing; 401/429/5xx are `unavailable` with one call (no retry); a timeout or abort is
// `timeout`; a bad body, an unoffered label, or confidence outside 0..1 is `invalid_output`;
// and masked inputs leak no known value. Design section 5 §10 (§10.7 failures, §10.8 the pinned
// version); section 9 §5.3; section 7 §8; docs/decisions.md M09 (2026-10-01).
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { JEV_MODEL, JevClassifier } from "../../src/adapters/jev/classifier.js";
import { Config } from "../../src/core/model/config.js";
import { Redactor, type RedactionRules } from "../../src/core/safety/redaction/redactor.js";
import type { Masked } from "../../src/ports/masked.js";
import type { JevReconcileInput, JevTroubleInput } from "../../src/ports/models.js";

// Why from config: the canary never appears as a literal in tests (CLAUDE.md).
const CANARY =
  Config.parse(JSON.parse(readFileSync(new URL("../../intyy.json", import.meta.url), "utf8")))
    .canary_members[0] ?? "";

/** A trouble input with two handlers and two outcomes; `over` replaces fields. */
function troubleInput(over: Partial<JevTroubleInput> = {}): Masked<JevTroubleInput> {
  return {
    schema: "intyy.jev.step/1.0",
    step: {
      id: "open_form",
      intent: "Open the form",
      action: "click",
      risk: "idempotent",
      phase: "checkpoint",
    },
    expected: {
      condition: "form_shown",
      description: "The form shows",
      trace: [{ path: "form_shown", check: "element_visible", passed: false }],
    },
    last_good: { step: "open_member", location: "/members/{input.member_id}" },
    screen: {
      location: "/accounts/new",
      truncated: false,
      elements: [{ role: "heading", name: "KYC reminder" }],
    },
    outcomes: [
      { code: "member_not_found", description: "No such member." },
      { code: "limit_exceeded", description: "Over the limit." },
    ],
    handlers: [
      { id: "kyc", class: "popup", description: "A KYC reminder popup." },
      { id: "session_expired", class: "session", description: "The session ended." },
    ],
    tied: [],
    ...over,
  } as unknown as Masked<JevTroubleInput>;
}

/** A reconcile input. */
function reconcileInput(): Masked<JevReconcileInput> {
  return {
    schema: "intyy.jev.reconcile/1.0",
    parent: {
      capability: "app/cap@1",
      commit_step: { id: "click_confirm", intent: "Confirm" },
      correlation: "none",
      last_screen: { location: "/accounts/new", elements: [{ role: "heading", name: "500 Error" }] },
    },
    check: {
      capability: "app/count@1",
      status: "succeeded",
      outcome: null,
      failure: null,
      final_screen: { location: "/list", elements: [{ role: "text", name: "Count 3" }] },
    },
    not_found_outcomes: ["not_found"],
  } as unknown as Masked<JevReconcileInput>;
}

/** A 200 reply with one `choice` answer. */
function reply(choice: unknown, confidence: unknown = 0.9) {
  return {
    model: JEV_MODEL,
    answers: { pick: { type: "choice", choice, confidence, probabilities: { [String(choice)]: 1 } } },
    usage: { input_tokens: 10, output_tokens: 1 },
  };
}

/** A fake fetch that keeps the bytes it was sent and answers `status` with `body`. */
function fakeFetch(body: unknown, status = 200) {
  const sent: Uint8Array[] = [];
  const f: typeof fetch = (_url, init) => {
    const b = init?.body;
    sent.push(typeof b === "string" ? new TextEncoder().encode(b) : new Uint8Array(b as ArrayBuffer));
    return Promise.resolve(
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
    );
  };
  return { f, sent };
}

/** A recorder that keeps what it was asked to write. */
function recorder(okWrites = true) {
  const stored: { part: string; bytes: Uint8Array }[] = [];
  const record = (part: "request" | "reply", bytes: Uint8Array) => {
    stored.push({ part, bytes: new Uint8Array(bytes) });
    return Promise.resolve(okWrites);
  };
  return { record, stored };
}

const jev = (f: typeof fetch, timeoutMs?: number) =>
  new JevClassifier({
    apiKey: "test-key",
    fetch: f,
    baseURL: "http://127.0.0.1:9",
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
const text = (b: Uint8Array | undefined) => new TextDecoder().decode(b);

/** The part of the request body this test reads. */
type Body = {
  model: string;
  state: Record<string, unknown>;
  questions: Record<string, { type: string; criteria: Record<string, string> }>;
};
const bodyOf = (b: Uint8Array | undefined) => JSON.parse(text(b)) as Body;

describe("trouble: labels become buckets, confidence is jev's (section 5 §10.3)", () => {
  test("a handler label", async () => {
    const { f } = fakeFetch(reply("handler:kyc", 0.9));
    expect(await jev(f).trouble(troubleInput(), recorder().record)).toEqual({
      ok: true,
      value: { bucket: "handler", handler: "kyc", outcome: null, confidence: 0.9 },
    });
  });

  test("an outcome label", async () => {
    const { f } = fakeFetch(reply("outcome:limit_exceeded", 0.97));
    expect(await jev(f).trouble(troubleInput(), recorder().record)).toEqual({
      ok: true,
      value: { bucket: "outcome", handler: null, outcome: "limit_exceeded", confidence: 0.97 },
    });
  });

  test.each(["needs_review", "unsafe"] as const)("the fixed label %s", async (label) => {
    const { f } = fakeFetch(reply(label, 0.5));
    expect(await jev(f).trouble(troubleInput(), recorder().record)).toEqual({
      ok: true,
      value: { bucket: label, handler: null, outcome: null, confidence: 0.5 },
    });
  });
});

describe("reconcile: found, not_found, unclear", () => {
  test.each(["found", "not_found", "unclear"] as const)("%s", async (verdict) => {
    const { f } = fakeFetch(reply(verdict, 0.8));
    expect(await jev(f).reconcile(reconcileInput(), recorder().record)).toEqual({
      ok: true,
      value: { verdict, confidence: 0.8 },
    });
  });

  test("the request offers exactly the three reconcile labels and the pinned model", async () => {
    const { f, sent } = fakeFetch(reply("found"));
    await jev(f).reconcile(reconcileInput(), recorder().record);
    const b = bodyOf(sent[0]);
    expect(b.model).toBe("jev-1.13.0");
    expect(Object.keys(b.questions)).toEqual(["pick"]);
    expect(b.questions["pick"]?.type).toBe("choice");
    expect(Object.keys(b.questions["pick"]?.criteria ?? {}).sort()).toEqual(["found", "not_found", "unclear"]);
  });
});

describe("the trouble request (section 5 §10.2, §10.8)", () => {
  test("pins the model, asks one choice question, and offers every label", async () => {
    const { f, sent } = fakeFetch(reply("needs_review"));
    await jev(f).trouble(troubleInput(), recorder().record);
    const b = bodyOf(sent[0]);
    expect(JEV_MODEL).toBe("jev-1.13.0");
    expect(b.model).toBe("jev-1.13.0");
    expect(Object.keys(b.questions)).toEqual(["pick"]);
    expect(b.questions["pick"]?.type).toBe("choice");
    expect(Object.keys(b.questions["pick"]?.criteria ?? {}).sort()).toEqual(
      [
        "handler:kyc",
        "handler:session_expired",
        "needs_review",
        "outcome:limit_exceeded",
        "outcome:member_not_found",
        "unsafe",
      ].sort(),
    );
  });

  test("the handlers and outcomes are labels only: not repeated in the state", async () => {
    const { f, sent } = fakeFetch(reply("needs_review"));
    await jev(f).trouble(troubleInput(), recorder().record);
    const state = bodyOf(sent[0]).state;
    expect("handlers" in state).toBe(false);
    expect("outcomes" in state).toBe(false);
    expect(state["screen"]).toBeDefined();
    expect(state["step"]).toBeDefined();
  });

  test("the API key never lands in the stored bytes", async () => {
    const { f } = fakeFetch(reply("needs_review"));
    const { record, stored } = recorder();
    await jev(f).trouble(troubleInput(), record);
    for (const s of stored) expect(text(s.bytes)).not.toContain("test-key");
  });
});

describe("call order (section 9 §5.3)", () => {
  test("the stored request equals the sent request; the reply is stored after it", async () => {
    const { f, sent } = fakeFetch(reply("handler:kyc"));
    const { record, stored } = recorder();
    await jev(f).trouble(troubleInput(), record);
    expect(stored.map((s) => s.part)).toEqual(["request", "reply"]);
    expect(sent).toHaveLength(1);
    expect(Buffer.from(stored[0]?.bytes ?? []).equals(Buffer.from(sent[0] ?? []))).toBe(true);
    expect(text(stored[1]?.bytes)).toContain('"model":"jev-1.13.0"');
    expect(JSON.parse(text(stored[1]?.bytes))).toEqual(reply("handler:kyc"));
  });

  test("a failed write is write_failed and nothing is sent", async () => {
    const { f, sent } = fakeFetch(reply("handler:kyc"));
    expect(await jev(f).trouble(troubleInput(), recorder(false).record)).toMatchObject({
      ok: false,
      failure: "write_failed",
    });
    expect(sent).toHaveLength(0);
  });

  test("the same holds for reconcile", async () => {
    const { f, sent } = fakeFetch(reply("found"));
    expect(await jev(f).reconcile(reconcileInput(), recorder(false).record)).toMatchObject({
      failure: "write_failed",
    });
    expect(sent).toHaveLength(0);
  });

  test("a failed reply write is write_failed", async () => {
    const { f } = fakeFetch(reply("found"));
    let n = 0;
    const record = () => Promise.resolve(++n === 1);
    expect(await jev(f).reconcile(reconcileInput(), record)).toMatchObject({
      ok: false,
      failure: "write_failed",
    });
  });
});

describe("failures (section 5 §10.7; section 9 §5.3)", () => {
  test.each([401, 429, 503])("HTTP %d is unavailable, with no retry", async (status) => {
    const { f, sent } = fakeFetch({ error: { message: "no" } }, status);
    expect(await jev(f).trouble(troubleInput(), recorder().record)).toMatchObject({
      ok: false,
      failure: "unavailable",
    });
    expect(sent).toHaveLength(1);
  });

  test("a rejected fetch is unavailable", async () => {
    const f: typeof fetch = () => Promise.reject(new TypeError("connection refused"));
    expect(await jev(f).reconcile(reconcileInput(), recorder().record)).toMatchObject({
      ok: false,
      failure: "unavailable",
    });
  });

  /** A fetch that never answers on its own; it ends only when its signal aborts. */
  const hang: typeof fetch = (_url, init) =>
    new Promise((_resolve, reject) => {
      const abort = () => {
        reject(new DOMException("aborted", "AbortError"));
      };
      // Why the first check: the caller may abort before the fetch starts, and no event fires then.
      if (init?.signal?.aborted === true) abort();
      init?.signal?.addEventListener("abort", abort);
    });

  test("a call past its time limit is a timeout", async () => {
    expect(await jev(hang, 20).trouble(troubleInput(), recorder().record)).toMatchObject({
      ok: false,
      failure: "timeout",
    });
    expect(await jev(hang, 20).reconcile(reconcileInput(), recorder().record)).toMatchObject({
      ok: false,
      failure: "timeout",
    });
  });

  test("a signal already aborted is a timeout", async () => {
    const controller = new AbortController();
    controller.abort();
    expect(
      await jev(hang).trouble(troubleInput(), recorder().record, controller.signal),
    ).toMatchObject({ ok: false, failure: "timeout" });
  });

  test("an abort during the call is a timeout", async () => {
    const controller = new AbortController();
    const pending = jev(hang).reconcile(reconcileInput(), recorder().record, controller.signal);
    controller.abort();
    expect(await pending).toMatchObject({ ok: false, failure: "timeout" });
  });
});

describe("bad output is invalid_output (section 5 §10.7)", () => {
  test.each([
    ["an empty body", {}],
    ["no pick answer", { model: JEV_MODEL, answers: {}, usage: {} }],
    ["a label that was not offered", reply("zzz")],
    ["an inherited property name as the label", reply("constructor")],
    ["a handler that was not offered", reply("handler:ghost")],
    ["confidence above 1", reply("handler:kyc", 1.5)],
    ["confidence below 0", reply("handler:kyc", -0.1)],
    ["confidence that is a string", reply("handler:kyc", "0.9")],
    ["a score answer", { model: JEV_MODEL, answers: { pick: { type: "score", score: 3, confidence: 0.9 } } }],
  ])("trouble: %s", async (_name, body) => {
    const { f } = fakeFetch(body);
    expect(await jev(f).trouble(troubleInput(), recorder().record)).toEqual({
      ok: false,
      failure: "invalid_output",
    });
  });

  test.each([
    ["a trouble label sent to reconcile", reply("handler:kyc")],
    ["an unoffered label", reply("zzz")],
    ["confidence above 1", reply("found", 1.5)],
    ["an empty body", {}],
  ])("reconcile: %s", async (_name, body) => {
    const { f } = fakeFetch(body);
    expect(await jev(f).reconcile(reconcileInput(), recorder().record)).toEqual({
      ok: false,
      failure: "invalid_output",
    });
  });
});

describe("safety: masked inputs leak no known value into the request", () => {
  const rules: RedactionRules = {
    detectors: [],
    digitRunMin: 5,
    formats: [],
    labels: {},
    dateFormats: [],
  };

  test("the canary member and a known name are references in the stored bytes", async () => {
    expect(CANARY).toMatch(/^\d+$/);
    const r = new Redactor(rules);
    r.addKnown({ ref: "input.member_id", value: CANARY, label: "pii", type: "text", kind: "member" });
    r.addKnown({
      ref: "input.holder",
      value: "Dana Quillfeather",
      label: "pii",
      type: "text",
      kind: "name",
    });
    const m = (s: string) => r.text(s);
    const i = troubleInput({
      last_good: { step: "open_member", location: m(`/members/${CANARY}`) },
      screen: {
        location: m(`/members/${CANARY}/accounts`),
        truncated: false,
        elements: [
          { role: "heading", name: m(`Member ${CANARY}`) },
          { role: "text", name: m("Holder: Dana Quillfeather") },
        ],
      },
    });
    const { f, sent } = fakeFetch(reply("needs_review"));
    const { record, stored } = recorder();
    await jev(f).trouble(i, record);
    for (const bytes of [stored[0]?.bytes, sent[0]]) {
      const sentText = text(bytes);
      expect(sentText).not.toContain(CANARY);
      expect(sentText).not.toContain("Quillfeather");
      expect(sentText).toContain("{input.member_id}");
      expect(sentText).toContain("{input.holder}");
    }
  });
});
