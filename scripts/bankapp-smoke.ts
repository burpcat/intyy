// Checks the bank app answers at its origin, with test mode on. Prints no response bodies.
// Follows build plan section 10 §5.6 (bankapp:smoke) and CONTRACT §1, §4, and §8.
import { readFileSync } from "node:fs";

/** Why: CONTRACT §6, the app is slow on purpose. Give each request room. */
const timeoutMs = 30_000;

/** A failed check: what went wrong, and the command or setting that fixes it. */
class SmokeFailure extends Error {
  constructor(problem: string, readonly fix: string) {
    super(problem);
  }
}

function readOrigin(): URL {
  const config: unknown = JSON.parse(readFileSync(new URL("../bankapp.json", import.meta.url), "utf8"));
  if (typeof config !== "object" || config === null || !("origin" in config) || typeof config.origin !== "string") {
    throw new SmokeFailure("bankapp.json has no origin string.", 'Add "origin": "http://127.0.0.1:8080".');
  }
  const origin = new URL(config.origin);
  // Why: CLAUDE.md, tests never call any host except 127.0.0.1.
  if (origin.hostname !== "127.0.0.1") {
    throw new SmokeFailure(`Origin host is ${origin.hostname}, not 127.0.0.1.`, "Set origin to http://127.0.0.1:8080.");
  }
  return origin;
}

async function get(origin: URL, path: string): Promise<Response> {
  try {
    // Why: redirect "manual" keeps every request on 127.0.0.1.
    return await fetch(new URL(path, origin), { redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    throw new SmokeFailure(
      `The bank app does not answer at ${origin.origin}.`,
      "Start it: run `make up` in ../kvfcu-bank, then run this check again.",
    );
  }
}

async function checkHome(origin: URL): Promise<void> {
  const res = await get(origin, "/");
  if (res.status >= 400) {
    throw new SmokeFailure(
      `GET / answered ${String(res.status)}.`,
      "Check that the bank app, not another server, listens on port 8080.",
    );
  }
}

async function checkTestMode(origin: URL): Promise<void> {
  const res = await get(origin, "/__test__/faultlog");
  if (res.status === 404) {
    throw new SmokeFailure(
      "GET /__test__/faultlog answered 404, so test mode is off.",
      "Set KVFCU_TEST_MODE=1 in the bank app's .env, then restart it with `make up`.",
    );
  }
  if (res.status !== 200) {
    throw new SmokeFailure(`GET /__test__/faultlog answered ${String(res.status)}.`, "Restart the bank app with `make up`.");
  }
  const body: unknown = await res.json().catch(() => null);
  // Why: CONTRACT §8, the fault log answers {"entries": [...]}.
  if (typeof body !== "object" || body === null || !("entries" in body) || !Array.isArray(body.entries)) {
    throw new SmokeFailure(
      "GET /__test__/faultlog did not answer JSON with an entries list.",
      "Check the bank app runs CONTRACT 1.1.0 at the commit in bankapp.json.",
    );
  }
}

async function main(): Promise<void> {
  try {
    const origin = readOrigin();
    await checkHome(origin);
    await checkTestMode(origin);
    console.log(`bankapp:smoke passed. The bank app answers at ${origin.origin}, with test mode on.`);
  } catch (err) {
    if (!(err instanceof SmokeFailure)) throw err;
    console.error(`bankapp:smoke failed: ${err.message}`);
    console.error(`Fix: ${err.fix}`);
    process.exitCode = 1;
  }
}

await main();
