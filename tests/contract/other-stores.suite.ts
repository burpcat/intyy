// Contract suites for the candidate, log, and evidence stores. Run against fakes and file adapters.
// Design section 9 §5.8 and section 3 §6.1, §7.1, §7.3.
import { describe, expect, test } from "vitest";
import { sha256Hex } from "../../src/core/model/canonical.js";
import type { IndexLine } from "../../src/core/model/store-index.js";
import type { CandidateStore, EvidenceStore, LogStore } from "../../src/ports/stores.js";
import {
  masked,
  type CandidateFiles,
  type Decision,
  type LogLine,
  type LogRecord,
} from "./test-kinds.js";

/** What `seal` wrote for one artifact version, read back for verification. */
export type SealedRead = { artifact: unknown; crops: Record<string, Uint8Array>; index: IndexLine[] };

/** One implementation under test: the store, plus a way to read back what `seal` wrote. */
export type CandidateStoreFixture = {
  store: CandidateStore<CandidateFiles, Decision>;
  readSealed: (artifactId: string, version: string) => Promise<SealedRead | null>;
};

/** Runs the candidate store contract against one implementation. */
export function candidateStoreContract(
  label: string,
  make: () => Promise<CandidateStoreFixture>,
): void {
  describe(`CandidateStore contract: ${label}`, () => {
    test("files read back; a missing file is not_found", async () => {
      const { store } = await make();
      expect(await store.putFile("kvfcu/sign_in/c1", "runs.json", { runs: ["r1"] })).toEqual({
        ok: true,
        value: undefined,
      });
      expect(await store.getFile("kvfcu/sign_in/c1", "runs.json")).toEqual({
        ok: true,
        value: { runs: ["r1"] },
      });
      expect(await store.getFile("kvfcu/sign_in/c1", "candidate.json")).toMatchObject({
        ok: false,
        failure: "not_found",
      });
    });

    test("a file write replaces the old content", async () => {
      const { store } = await make();
      await store.putFile("kvfcu/sign_in/c1", "candidate.json", { steps: 1 });
      await store.putFile("kvfcu/sign_in/c1", "candidate.json", { steps: 2 });
      expect(await store.getFile("kvfcu/sign_in/c1", "candidate.json")).toEqual({
        ok: true,
        value: { steps: 2 },
      });
    });

    test("decisions append in order; an absent log is empty", async () => {
      const { store } = await make();
      expect(await store.decisions("kvfcu/sign_in/c1")).toEqual({ ok: true, value: [] });
      await store.appendDecision("kvfcu/sign_in/c1", { by: "op_017", decision: "accept" });
      await store.appendDecision("kvfcu/sign_in/c1", { by: "op_017", decision: "rename" });
      expect(await store.decisions("kvfcu/sign_in/c1")).toEqual({
        ok: true,
        value: [
          { by: "op_017", decision: "accept" },
          { by: "op_017", decision: "rename" },
        ],
      });
    });

    test("list returns candidate IDs, sorted", async () => {
      const { store } = await make();
      await store.putFile("kvfcu/sign_in/c2", "runs.json", { runs: [] });
      await store.appendDecision("kvfcu/find/c1", { by: "op_017", decision: "accept" });
      expect(await store.list()).toEqual(["kvfcu/find/c1", "kvfcu/sign_in/c2"]);
    });

    test(
      "seal writes the artifact folder and its crops, and one index line; " +
        "a version already sealed is refused; the candidate's own files are untouched",
      async () => {
        const { store, readSealed } = await make();
        await store.putFile("kvfcu/sign_in/c1", "runs.json", { runs: ["r1"] });
        const artifact = { identity: { app: "kvfcu", capability: "sign_in", version: "1.0.0" } };
        const crop = Uint8Array.from([137, 80, 78, 71]);

        const sealed = await store.seal("kvfcu/sign_in/c1", "1.0.0", "op_017", artifact, {
          search_button: crop,
        });
        if (!sealed.ok) throw new Error("seal failed");

        const read = await readSealed("kvfcu/sign_in", "1.0.0");
        expect(read?.artifact).toEqual(artifact);
        expect(read?.crops).toEqual({ search_button: crop });
        expect(read?.index).toMatchObject([
          {
            event: "sealed",
            kind: "artifact",
            id: "kvfcu/sign_in",
            rev: "1.0.0",
            hash: sealed.value.hash,
            by: "op_017",
          },
        ]);

        expect(
          await store.seal("kvfcu/sign_in/c1", "1.0.0", "op_017", artifact, {}),
        ).toMatchObject({ ok: false, failure: "conflict" });

        expect(await store.getFile("kvfcu/sign_in/c1", "runs.json")).toEqual({
          ok: true,
          value: { runs: ["r1"] },
        });
      },
    );
  });
}

/** Runs the log store contract against one implementation. */
export function logStoreContract(
  label: string,
  make: () => Promise<LogStore<LogLine, LogRecord>>,
): void {
  describe(`LogStore contract: ${label}`, () => {
    test("lines append in order; an absent log is empty", async () => {
      const store = await make();
      expect(await store.lines("keystone/history")).toEqual({ ok: true, value: [] });
      await store.append("keystone/history", { n: 1 });
      await store.append("keystone/history", { n: 2 });
      expect(await store.lines("keystone/history")).toEqual({
        ok: true,
        value: [{ n: 1 }, { n: 2 }],
      });
      expect(await store.lines("keystone/live")).toEqual({ ok: true, value: [] });
    });

    test("a record is replaced whole; a missing record is not_found", async () => {
      const store = await make();
      expect(await store.getRecord("keystone/record")).toMatchObject({
        ok: false,
        failure: "not_found",
      });
      await store.putRecord("keystone/record", { total: 1 });
      await store.putRecord("keystone/record", { total: 2 });
      expect(await store.getRecord("keystone/record")).toEqual({ ok: true, value: { total: 2 } });
    });
  });
}

/** Runs the evidence store contract against one implementation. */
export function evidenceStoreContract(label: string, make: () => Promise<EvidenceStore>): void {
  const RUN = "run_2026-01-15_7kq2m9x4tb";

  describe(`EvidenceStore contract: ${label}`, () => {
    test("a run folder is created once", async () => {
      const store = await make();
      expect((await store.createRun("keystone", RUN)).ok).toBe(true);
      expect(await store.createRun("keystone", RUN)).toMatchObject({
        ok: false,
        failure: "conflict",
      });
      expect((await store.openRun("keystone", RUN)).ok).toBe(true);
      expect(await store.openRun("keystone", "run_2026-01-15_0000000000")).toMatchObject({
        ok: false,
        failure: "not_found",
      });
    });

    test("events append in order, durable or not", async () => {
      const store = await make();
      const run = await store.createRun("keystone", RUN);
      if (!run.ok) throw new Error("createRun failed");
      expect(
        await run.value.appendEvent(masked({ seq: 1, event: "run_start" }), { durable: true }),
      ).toEqual({ ok: true, value: undefined });
      expect(await run.value.appendEvent(masked({ seq: 2, event: "action" }))).toEqual({
        ok: true,
        value: undefined,
      });
      expect(await store.events("keystone", RUN)).toEqual({
        ok: true,
        value: [
          { seq: 1, event: "run_start" },
          { seq: 2, event: "action" },
        ],
      });
      expect(await store.events("keystone", "run_2026-01-15_0000000000")).toMatchObject({
        ok: false,
        failure: "not_found",
      });
    });

    test("writeFile returns the file's hash and size", async () => {
      const store = await make();
      const run = await store.createRun("keystone", RUN);
      if (!run.ok) throw new Error("createRun failed");
      const text = '{"masked":true}';
      expect(await run.value.writeFile("llm/jev_00017.json", masked(text))).toEqual({
        ok: true,
        value: { sha256: sha256Hex(text), bytes: Buffer.byteLength(text) },
      });
      const png = Uint8Array.from([137, 80, 78, 71]);
      expect(
        await run.value.writeFile("screens/00019_click_search_ladder.png", masked(png)),
      ).toEqual({
        ok: true,
        value: { sha256: sha256Hex(png), bytes: 4 },
      });
    });

    test("readFile reads back written bytes; a missing file is not_found; reading never writes", async () => {
      const store = await make();
      const run = await store.createRun("keystone", RUN);
      if (!run.ok) throw new Error("createRun failed");
      const text = '{"masked":true}';
      await run.value.writeFile("a11y/00013_observation.a11y.yaml", masked(text));

      // Why: task 10's candidate new opens a finished run to read it. Read-only means no
      // index line and no event get added just by reading (docs/decisions.md, M04).
      const before = await store.index("keystone");
      const opened = await store.openRun("keystone", RUN);
      if (!opened.ok) throw new Error("openRun failed");
      expect(await opened.value.readFile("a11y/00013_observation.a11y.yaml")).toEqual({
        ok: true,
        value: new TextEncoder().encode(text),
      });
      expect(await opened.value.readFile("llm/00099_planner_request.json")).toMatchObject({
        ok: false,
        failure: "not_found",
      });
      expect(await store.index("keystone")).toEqual(before);
      expect(await store.events("keystone", RUN)).toEqual({ ok: true, value: [] });
    });

    test("run.json is replaced whole", async () => {
      const store = await make();
      const run = await store.createRun("keystone", RUN);
      if (!run.ok) throw new Error("createRun failed");
      expect(await store.readRunJson("keystone", RUN)).toMatchObject({
        ok: false,
        failure: "not_found",
      });
      await run.value.writeRunJson(masked({ status: "running" }));
      await run.value.writeRunJson(masked({ status: "success" }));
      expect(await store.readRunJson("keystone", RUN)).toEqual({
        ok: true,
        value: { status: "success" },
      });
    });

    test("the tenant index appends in order; runs list sorted", async () => {
      const store = await make();
      expect(await store.index("keystone")).toEqual({ ok: true, value: [] });
      await store.createRun("keystone", "run_2026-01-15_bbbbbbbbbb");
      await store.createRun("keystone", "run_2026-01-15_aaaaaaaaaa");
      await store.appendIndex(
        "keystone",
        masked({ run_id: "run_2026-01-15_bbbbbbbbbb", status: "running" }),
      );
      await store.appendIndex(
        "keystone",
        masked({ run_id: "run_2026-01-15_bbbbbbbbbb", status: "success" }),
      );
      expect(await store.index("keystone")).toEqual({
        ok: true,
        value: [
          { run_id: "run_2026-01-15_bbbbbbbbbb", status: "running" },
          { run_id: "run_2026-01-15_bbbbbbbbbb", status: "success" },
        ],
      });
      expect(await store.listRuns("keystone")).toEqual([
        "run_2026-01-15_aaaaaaaaaa",
        "run_2026-01-15_bbbbbbbbbb",
      ]);
      expect(await store.listRuns("lakeshore")).toEqual([]);
    });

    test("unsafe tenant, run, and file names are bugs and throw", async () => {
      const store = await make();
      // Why `.then`: a bug may throw at once or reject later. Both count.
      const later = <T>(f: () => Promise<T>): Promise<T> => Promise.resolve().then(f);
      await expect(later(() => store.createRun("../x", RUN))).rejects.toThrow("unsafe store path");
      await expect(later(() => store.createRun("keystone", "../../x"))).rejects.toThrow(
        "unsafe store path",
      );
      const run = await store.createRun("keystone", RUN);
      if (!run.ok) throw new Error("createRun failed");
      await expect(later(() => run.value.writeFile("../run.json", masked("x")))).rejects.toThrow(
        "unsafe store path",
      );
      await expect(later(() => run.value.readFile("../run.json"))).rejects.toThrow(
        "unsafe store path",
      );
    });
  });
}
