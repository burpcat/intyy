// Contract suite for the document store. Runs against the fake and the file adapter.
// Design section 9 §5.8, §6.4, and §16 (store sealing, four eyes).
import { describe, expect, test } from "vitest";
import type { ManualClock } from "../../src/fakes/clock.js";
import type { DocumentStore } from "../../src/ports/stores.js";
import { doc, type TestDoc } from "./test-kinds.js";

/** What each implementation gives the suite. */
export type DocStoreSubject = {
  store: DocumentStore<TestDoc>;
  clock: ManualClock;
  /** Changes a sealed revision in place, like a hand edit of the file. */
  tamper(id: string, rev: string, change: (d: Record<string, unknown>) => void): Promise<void>;
  /** Replaces the open candidate's content, like a hand edit that breaks its schema. */
  corruptCandidate(id: string, content: unknown): Promise<void>;
};

/** Runs the document store contract against one implementation. */
export function documentStoreContract(label: string, make: () => Promise<DocStoreSubject>): void {
  describe(`DocumentStore contract: ${label}`, () => {
    test("a candidate reads back and lists; a new candidate replaces the open one", async () => {
      const { store } = await make();
      expect(await store.putCandidate("global", doc(1), "op_017")).toEqual({
        ok: true,
        value: undefined,
      });
      expect(await store.getCandidate("global")).toEqual({
        ok: true,
        value: { id: "global", rev: "1", doc: doc(1) },
      });
      expect(await store.list({})).toEqual([{ id: "global", rev: "1", state: "candidate" }]);

      await store.putCandidate("global", doc(2, "second"), "op_017");
      const got = await store.getCandidate("global");
      expect(got.ok && got.value.doc.body).toBe("second");
      expect(await store.list({ id: "global" })).toEqual([
        { id: "global", rev: "2", state: "candidate" },
      ]);
    });

    test("a missing candidate or revision is not_found; seal with no candidate is invalid", async () => {
      const { store } = await make();
      expect((await store.getCandidate("global")).ok).toBe(false);
      expect(await store.getCandidate("global")).toMatchObject({ failure: "not_found" });
      expect(await store.approve("global", "9", "op_031")).toMatchObject({
        ok: false,
        failure: "not_found",
      });
      expect(await store.get("global", "1")).toMatchObject({ ok: false, failure: "not_found" });
      expect(await store.seal("global", "op_017")).toMatchObject({ ok: false, failure: "invalid" });
    });

    test("putCandidate refuses a bad schema and an approved block", async () => {
      const { store } = await make();
      const bad = { ...doc(1), extra: true } as unknown as TestDoc;
      expect(await store.putCandidate("global", bad, "op_017")).toMatchObject({
        ok: false,
        failure: "invalid",
      });
      const pre = { ...doc(1), approved: { by: "op_031", at: "2026-01-15T09:00:00.000Z" } };
      expect(await store.putCandidate("global", pre, "op_017")).toMatchObject({
        ok: false,
        failure: "invalid",
      });
    });

    test("a candidate edited into a bad shape reads as invalid", async () => {
      const subject = await make();
      await subject.store.putCandidate("global", doc(1), "op_017");
      await subject.corruptCandidate("global", { schema: "test.doc/1.0", revision: 1 });
      expect(await subject.store.getCandidate("global")).toMatchObject({
        ok: false,
        failure: "invalid",
      });
      expect(await subject.store.seal("global", "op_017")).toMatchObject({
        ok: false,
        failure: "invalid",
      });
    });

    test("seal, conflict, four eyes, and approve take one revision through its states", async () => {
      const { store, clock } = await make();
      await store.putCandidate("tenant/keystone", doc(1), "op_017");
      const sealed = await store.seal("tenant/keystone", "op_017");
      expect(sealed.ok).toBe(true);
      if (!sealed.ok) return;
      expect(sealed.value.rev).toBe("1");
      expect(sealed.value.hash).toMatch(/^sha256:[0-9a-f]{64}$/);

      // seal freezes the candidate and get returns it with its hash and sealer
      const got = await store.get("tenant/keystone", "1");
      expect(got).toEqual({
        ok: true,
        value: {
          id: "tenant/keystone",
          rev: "1",
          hash: sealed.value.hash,
          sealedBy: "op_017",
          doc: doc(1),
          approved: null,
        },
      });
      expect(await store.getCandidate("tenant/keystone")).toMatchObject({ failure: "not_found" });
      expect(await store.list({})).toEqual([{ id: "tenant/keystone", rev: "1", state: "sealed" }]);

      // putCandidate on a sealed revision is a conflict
      expect(await store.putCandidate("tenant/keystone", doc(1, "again"), "op_017")).toMatchObject({
        ok: false,
        failure: "conflict",
      });

      // four eyes: the sealer cannot approve
      expect(await store.approve("tenant/keystone", "1", "op_017")).toEqual({
        ok: false,
        failure: "rule",
        detail: "four_eyes",
      });
      const unapproved = await store.get("tenant/keystone", "1");
      expect(unapproved.ok && unapproved.value.approved).toBeNull();

      // approve stamps once, with the approver and the clock's time
      clock.advance(60_000);
      expect(await store.approve("tenant/keystone", "1", "op_031")).toEqual({
        ok: true,
        value: undefined,
      });
      const approved = await store.get("tenant/keystone", "1");
      const at = clock.now().toISOString();
      expect(approved.ok && approved.value.approved).toEqual({ by: "op_031", at });
      expect(approved.ok && approved.value.doc.approved).toEqual({ by: "op_031", at });
      expect(await store.approve("tenant/keystone", "1", "op_022")).toEqual({
        ok: false,
        failure: "rule",
        detail: "already_approved",
      });
      expect(await store.list({})).toEqual([{ id: "tenant/keystone", rev: "1", state: "approved" }]);

      // the hash excludes approved: it is the same before and after approval
      expect(approved.ok && approved.value.hash === sealed.value.hash).toBe(true);
    });

    test("the hash does not depend on key order", async () => {
      const { store } = await make();
      await store.putCandidate("a", { schema: "test.doc/1.0", revision: 1, body: "x" }, "op_017");
      await store.putCandidate("b", { body: "x", revision: 1, schema: "test.doc/1.0" }, "op_017");
      const a = await store.seal("a", "op_017");
      const b = await store.seal("b", "op_017");
      expect(a.ok && b.ok && a.value.hash === b.value.hash).toBe(true);
    });

    test("a hand edit of a sealed file fails to load", async () => {
      const subject = await make();
      for (const id of ["t1", "t2", "t3"]) {
        await subject.store.putCandidate(id, doc(1), "op_017");
        await subject.store.seal(id, "op_017");
      }
      // a changed sealed file fails to load and cannot be approved
      await subject.tamper("t1", "1", (d) => {
        d.body = "changed";
      });
      expect(await subject.store.get("t1", "1")).toMatchObject({
        ok: false,
        failure: "hash_mismatch",
      });
      expect(await subject.store.approve("t1", "1", "op_031")).toMatchObject({
        ok: false,
        failure: "hash_mismatch",
      });

      // an approved block added by hand fails to load
      await subject.tamper("t2", "1", (d) => {
        d.approved = { by: "op_031", at: "2026-01-15T09:00:00.000Z" };
      });
      expect(await subject.store.get("t2", "1")).toMatchObject({
        ok: false,
        failure: "hash_mismatch",
      });

      // a changed approved block fails to load
      await subject.store.approve("t3", "1", "op_031");
      await subject.tamper("t3", "1", (d) => {
        d.approved = { by: "op_022", at: "2026-01-15T09:00:00.000Z" };
      });
      expect(await subject.store.get("t3", "1")).toMatchObject({
        ok: false,
        failure: "hash_mismatch",
      });
    });

    test("list shows every revision, oldest first, filtered by ID", async () => {
      const { store } = await make();
      await store.putCandidate("global", doc(1), "op_017");
      await store.seal("global", "op_017");
      await store.approve("global", "1", "op_031");
      await store.putCandidate("global", doc(2), "op_017");
      await store.seal("global", "op_017");
      await store.putCandidate("global", doc(3), "op_017");
      await store.putCandidate("tenant/keystone", doc(1), "op_017");
      expect(await store.list({ id: "global" })).toEqual([
        { id: "global", rev: "1", state: "approved" },
        { id: "global", rev: "2", state: "sealed" },
        { id: "global", rev: "3", state: "candidate" },
      ]);
      expect(await store.list({})).toHaveLength(4);
    });

    test("an unsafe ID is a bug and throws", async () => {
      const { store } = await make();
      // Why `.then`: a bug may throw at once or reject later. Both count.
      await expect(
        Promise.resolve().then(() => store.putCandidate("../escape", doc(1), "op_017")),
      ).rejects.toThrow("unsafe store path");
    });
  });
}
