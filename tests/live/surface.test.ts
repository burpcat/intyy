// Runs the surface contract on the real Playwright adapter, against the fixture server.
// It never touches the bank app. Design section 9 §5.9 and §16; M02 tasks 6 and 12.
import { afterAll } from "vitest";
import { PlaywrightSurface } from "../../src/adapters/playwright/session.js";
import { surfaceContract } from "../contract/surface/surface.suite.js";
import { startFixtureServer } from "./fixture-server.js";

const server = await startFixtureServer();
afterAll(() => server.close());

surfaceContract("playwright", () =>
  Promise.resolve({ session: new PlaywrightSurface(), origin: server.origin }),
);
