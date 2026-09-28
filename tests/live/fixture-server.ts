// A tiny HTTP server on 127.0.0.1 for live surface tests. It serves the fixture site as HTML,
// the same screens as the snapshot fake's graph in tests/contract/surface/site.ts.
// It never touches the bank app. Design section 9 §5.9 and §16; M02 tasks 6 and 12.
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
    <p><label for="kind">Kind</label> <select id="kind"><option>Savings</option><option>Checking</option></select></p>`,
  ),
  "/frame": page("Frame", `<button type="button">Help</button>`),
  "/members": page("Members", `<h1>Members</h1>`),
  "/lookup": page("Lookup", `<button type="button" onclick="window.close()">Close</button>`),
};

/** Starts the server on a free loopback port. */
export async function startFixtureServer(): Promise<FixtureServer> {
  const server: Server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
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
