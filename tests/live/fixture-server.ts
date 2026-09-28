// A tiny HTTP server on 127.0.0.1 for live surface tests. It serves the fixture site as HTML,
// the same screens as the snapshot fake's graph in tests/contract/surface/site.ts.
// For the network guard test it also serves `/redirect`, a 302 to www.ncua.gov, and `/jump`,
// whose script jumps to the bank app's `/__test__/faultlog`. The server itself never calls the
// bank app. Design section 9 §5.9 and §16, section 4 §6.8; M02 tasks 6 and 12 (owner decision).
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/** A running fixture server. */
export type FixtureServer = { origin: string; close: () => Promise<void> };

/** Wraps a body in a plain page. */
const page = (title: string, body: string): string =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;

/** The pages, by path. Each matches one screen of the fake's graph. */
const PAGES: Record<string, string> = {
  "/": page(
    "Home",
    `<form id="search" onsubmit="location.href='/members'; return false;">
      <label for="member_id">Member ID</label> <input id="member_id" type="text">
      <label for="password">Password</label> <input id="password" type="password">
      <button type="submit">Search</button>
    </form>
    <p><a href="/members">Members</a></p>
    <p><a href="https://www.ncua.gov/">NCUA</a></p>
    <button type="button" onclick="confirm('Delete member?')">Delete</button>
    <button type="button" onclick="window.open('/lookup')">Lookup</button>
    <iframe src="/frame" title="help" width="300" height="60"></iframe>
    <canvas width="200" height="100" aria-label="Chart"></canvas>
    <p><label><input type="checkbox"> Joint</label></p>
    <p><label for="kind">Kind</label> <select id="kind"><option>Savings</option><option>Checking</option></select></p>
    <button type="button" onclick="document.body.insertAdjacentHTML('afterbegin', '<p>Note added</p>')">Add note</button>`,
  ),
  "/frame": page("Frame", `<button type="button">Help</button>`),
  "/members": page("Members", `<h1>Members</h1>`),
  "/lookup": page("Lookup", `<button type="button" onclick="window.close()">Close</button>`),
};

/** The address `/jump` sends the browser to, when a bank origin is given. */
const jumpTarget = (bank: string): string => `${bank}/__test__/faultlog`;

/** Starts the server on a free loopback port. `bank` sets where `/jump` points. */
export async function startFixtureServer(bank = "http://127.0.0.1:8080"): Promise<FixtureServer> {
  const server: Server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    if (path === "/redirect") {
      // Why: section 4 §6.6, a redirect off the list must be blocked at its first bad hop.
      res.writeHead(302, { location: "https://www.ncua.gov/" }).end();
      return;
    }
    if (path === "/jump") {
      const target = JSON.stringify(jumpTarget(bank));
      res
        .writeHead(200, { "content-type": "text/html; charset=utf-8" })
        .end(page("Jump", `<p>Jumping</p><script>location.href = ${target};</script>`));
      return;
    }
    const body = PAGES[path];
    if (body === undefined) {
      res.writeHead(404, { "content-type": "text/plain" }).end("not found");
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${String(port)}`,
    close: () =>
      new Promise<void>((resolve) =>
        server.close(() => {
          resolve();
        }),
      ),
  };
}
