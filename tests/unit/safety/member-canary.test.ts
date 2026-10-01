// The member canary, offline (design section 4 §14, "Member canary" and "How the canary scans
// work"; M07 gate row "Secret canary and member canary still pass"): a fake-surface replay for
// the member listed in `intyy.json` `canary_members`, in a temporary data root, with the member's
// number shown on two screens. Then a scan of every file the run wrote finds neither the member
// number nor any value the run returned. The live twin is tests/live/member-canary.test.ts.
// The number is read from `intyy.json` at run time, never written here (CLAUDE.md).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { afterAll, expect, test } from "vitest";
import { FileEvidenceStore, FileLogStore } from "../../../src/adapters/files/other-stores.js";
import { Config } from "../../../src/core/model/config.js";
import { RequestIndexLine } from "../../../src/core/model/request-index.js";
import { runReplay } from "../../../src/core/replay/executor.js";
import { scanForCanaries } from "../../../src/core/safety/canary/scan.js";
import {
  ACCOUNT_NUMBER,
  TENANT,
  authorizationFor,
  buildHarness,
  fixtureSite,
  replayInputOf,
  requestOf,
} from "../replay/executor-harness.js";
import type { FakeElement, FakeSite } from "../../../src/fakes/snapshot-surface/index.js";
import { readTree, tempRoot } from "./canary-kit.js";

const ROOT = join(import.meta.dirname, "../../..");
const config = Config.parse(JSON.parse(readFileSync(join(ROOT, "intyy.json"), "utf8")));

const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => {
  await Promise.all(cleanups.map((c) => c()));
});

test("replaying for the canary member leaks the number, or any returned value, into no written file", async () => {
  const canary = config.canary_members[0];
  if (canary === undefined) throw new Error("intyy.json has no canary_members configured");

  // A site that shows the member number the way a real bank screen does: on the result page, and
  // again as part of a sentence. Confirm is stuck, so the commit ends `uncertain`: the run then
  // saves its masked `commit_after` screenshot, DOM, and accessibility snapshot, and a child run
  // checks (section 7 §11.1). Those files are the ones a leak would land in.
  const plain = fixtureSite({ confirm: "stuck" });
  const memberTexts: FakeElement[] = [
    { id: "member_banner", role: "generic", roleGroup: "container", text: `Member ${canary}` },
    { id: "member_note", role: "generic", roleGroup: "container", text: `Found member number ${canary} in good standing` },
  ];
  const site: FakeSite = {
    ...plain,
    screens: {
      ...plain.screens,
      "/result": { elements: [...(plain.screens["/result"]?.elements ?? []), ...memberTexts] },
      "/check": {
        elements: [
          { id: "account_number_display", role: "generic", roleGroup: "container", label: "Account number", text: ACCOUNT_NUMBER },
          ...memberTexts,
        ],
      },
    },
  };

  const t = await tempRoot("intyy-member-canary-");
  cleanups.push(t.remove);
  const tmpDir = join(t.root, "tmp");
  const evidence = new FileEvidenceStore({ root: join(t.root, "evidence"), tmpDir });
  const requestIndexStore = new FileLogStore<RequestIndexLine, never>(
    { line: RequestIndexLine, record: z.never() },
    { dir: join(t.root, "request-index"), tmpDir },
  );
  const base = await buildHarness(site);
  const h = { ...base, deps: { ...base.deps, evidence, requestIndex: { ...base.deps.requestIndex, store: requestIndexStore } } };

  const request = requestOf({
    request_id: "req_member_canary_1",
    inputs: { member_id: canary },
    capability: "kvfcu/open_sub_checked@1",
    authorization: authorizationFor("kvfcu/open_sub_checked@1"),
  });
  const { runId, result } = await runReplay(replayInputOf(h, request), h.deps);
  expect(result.status).toBe("success");
  if (result.status !== "success") throw new Error("expected success");
  expect(result.outputs).toEqual({ account_number: ACCOUNT_NUMBER });

  // Why every returned value too: a returned number is as sensitive as the member's own (live twin).
  const markers = [canary, ...Object.values(result.outputs).map(String)];
  const files = await readTree(t.root);
  // Why: prove the scan read what the run wrote, so an empty result means clean, not missed.
  const paths = files.map((f) => f.path);
  expect(paths).toEqual(expect.arrayContaining([`evidence/${TENANT}/runs/${runId}/events.jsonl`, `evidence/${TENANT}/runs/${runId}/run.json`]));
  expect(paths.some((p) => p.startsWith("request-index/"))).toBe(true);
  expect(paths.some((p) => p.includes("/dom/"))).toBe(true);
  expect(paths.some((p) => p.includes("/screens/"))).toBe(true);
  expect(result.effect).toMatchObject({ commit: "found_by_check" });
  expect(scanForCanaries(files, markers)).toEqual([]);
});
