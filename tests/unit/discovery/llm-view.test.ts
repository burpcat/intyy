// Proves the LLM's view holds no canary value: a scripted run on a screen that shows the canary
// member and types the operator secrets. Then a scan of every stored prompt and reply, and every
// other run file, finds none of them in any of four forms. A planted control proves the scan reads
// llm/. Design section 4 §10 (the LLM's view), §14 (canary scans); section 9 §5.3. M03 task 9.
import { readFileSync } from "node:fs";
import { afterAll, describe, expect, test } from "vitest";
import { Config } from "../../../src/core/model/config.js";
import { scanForCanaries } from "../../../src/core/safety/canary/scan.js";
import type { FakeSite } from "../../../src/fakes/snapshot-surface/index.js";
import { PASSWORD, run, SITE, type Ran } from "./run-kit.js";

// Why from config: the canary never appears as a literal in tests (updates file §7, CLAUDE.md).
const CANARY =
  Config.parse(JSON.parse(readFileSync(new URL("../../../intyy.json", import.meta.url), "utf8")))
    .canary_members[0] ?? "";
const USERNAME = "teller-canary-user";

/** SITE, with the canary member on the home page as text, a table cell, and a link, and a greeting that shows the username secret. */
function canarySite(): FakeSite {
  const home = SITE.screens["/home"];
  if (home === undefined) throw new Error("SITE has no home page");
  return {
    ...SITE,
    screens: {
      ...SITE.screens,
      "/home": {
        ...home,
        elements: [
          ...home.elements,
          // Why: the bank app greets the operator by user ID after sign-in (the real M03 run).
          {
            id: "hello",
            role: "generic",
            roleGroup: "container",
            text: `Welcome, ${USERNAME} | Logout`,
          },
          {
            id: "recent",
            role: "generic",
            roleGroup: "container",
            text: `Last member viewed: ${CANARY}`,
          },
          { id: "t", role: "table", roleGroup: "container", name: "Recent" },
          {
            id: "c",
            parent: "t",
            role: "cell",
            roleGroup: "container",
            text: CANARY,
            context: { column: "Member ID" },
          },
          {
            id: "l",
            role: "link",
            roleGroup: "navigation",
            name: `Open ${CANARY}`,
            href: `/members/${CANARY}`,
          },
        ],
      },
    },
  };
}

let ran: Ran;
afterAll(async () => {
  await ran.remove();
});

describe("the LLM's view (section 4 §10)", () => {
  test("no stored prompt or reply, and no other run file, holds a canary value", async () => {
    expect(CANARY).toMatch(/^\d+$/);
    ran = await run({
      site: canarySite(),
      secrets: {
        INTYY_KEYSTONE_KVFCU_OPERATOR_USERNAME: USERNAME,
        INTYY_KEYSTONE_KVFCU_OPERATOR_PASSWORD: PASSWORD,
      },
    });
    expect(ran.result.status).toBe("success");
    const llm = ran.files.filter((f) => f.path.startsWith("llm/"));
    expect(llm.length).toBeGreaterThanOrEqual(8);
    // Why: the last turn saw the home page, so the canary was on screen when it was sent.
    const last = new TextDecoder().decode(
      llm.filter((f) => f.path.endsWith("_request.json")).at(-1)?.bytes,
    );
    expect(last).toContain("Teller Workstation");
    // Why: a secret the app shows back masks as its reference (docs/decisions.md, M03).
    expect(last).toContain("Welcome, {secret.operator_username} | Logout");
    expect(scanForCanaries(ran.files, [CANARY, PASSWORD, USERNAME])).toEqual([]);
  });

  test("the scan finds a planted marker in llm/, so a clean scan means clean", () => {
    const planted = [
      ...ran.files,
      { path: "llm/99999_planted.json", bytes: new TextEncoder().encode(`{"x":"${CANARY}"}`) },
    ];
    expect(scanForCanaries(planted, [CANARY])).toEqual([
      { path: "llm/99999_planted.json", marker: 0, form: "raw" },
    ]);
  });
});
