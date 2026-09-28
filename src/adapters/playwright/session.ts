// The Playwright surface session: a fresh Chromium session with the network guard set first.
// Follows design section 9 §5.2 (session), section 4 §6.2 and §6.6 (hosts, redirect hops),
// §6.8 (the guard), §6.10 (browser features), §8.8 (browser hygiene), and section 7 §9.
import { chromium, type Browser, type BrowserContext, type Page, type Route } from "playwright";
import { EventHub } from "../../core/events/hub.js";
import type { Hands, SurfaceSession } from "../../ports/hands.js";
import { fail, ok, type Outcome } from "../../ports/outcome.js";
import type {
  Allowlist,
  Eyes,
  RequestKind,
  SessionConfig,
  SurfaceEvent,
} from "../../ports/surface.js";
import { PlaywrightEyes } from "./eyes.js";
import { PlaywrightHands } from "./hands.js";
import { BrowserState, STEP_TIMEOUT_MS } from "./state.js";

/** Resource types that count as static files. They raise no request events (section 9 §5.2). */
const STATIC = new Set(["image", "stylesheet", "font", "script", "media", "manifest"]);

/**
 * Why: the dev runner may wrap functions with a `__name` helper. Page functions run in the
 * browser, where that helper does not exist. This no-op stands in for it.
 */
const NAME_SHIM = "globalThis.__name = globalThis.__name || ((f) => f);";

/** Why: section 4 §6.10, printing is suppressed. Print spools can store pages. */
const NO_PRINT = "window.print = () => undefined;";

/** The network guard (section 4 §6.8): every request, and every redirect hop (§6.6). */
async function guard(
  route: Route,
  allowlist: Allowlist,
  hub: EventHub<SurfaceEvent>,
): Promise<void> {
  const request = route.request();
  const kind: RequestKind = request.isNavigationRequest() ? "document" : "resource";
  const block = async (
    url: string,
    rule: "allowlist.host" | "allowlist.path" | "allowlist.path_malformed",
  ): Promise<void> => {
    hub.emit({ kind: "network_blocked", url, request: kind, rule });
    await route.abort("blockedbyclient");
  };
  const first = allowlist.check(request.url(), kind);
  if (!first.allowed) return block(request.url(), first.rule);
  // Why: Playwright routes only the first request of a redirect chain. Fetch without following,
  // check the next hop, then hand the answer back so the browser follows it through this guard.
  let response;
  try {
    response = await route.fetch({ maxRedirects: 0, timeout: STEP_TIMEOUT_MS });
  } catch {
    await route.abort("failed");
    return;
  }
  const location = response.headers().location;
  if (response.status() >= 300 && response.status() < 400 && location !== undefined) {
    const next = new URL(location, request.url()).href;
    const hop = allowlist.check(next, kind);
    if (!hop.allowed) return block(next, hop.rule);
  }
  await route.fulfill({ response });
}

/** Wires one page's events into the hub, and tracks it as the active window. */
function watchPage(s: BrowserState, page: Page): void {
  const hub = s.hub;
  page.on("request", (r) => {
    if (r.isNavigationRequest() && r.frame() === page.mainFrame()) {
      hub.emit({ kind: "navigation_started", url: r.url() });
    } else if (!STATIC.has(r.resourceType())) {
      hub.emit({ kind: "request_started", url: r.url() });
    }
  });
  const requestDone = (r: {
    url(): string;
    resourceType(): string;
    isNavigationRequest(): boolean;
  }): void => {
    if (!r.isNavigationRequest() && !STATIC.has(r.resourceType())) {
      hub.emit({ kind: "request_done", url: r.url() });
    }
  };
  page.on("requestfinished", requestDone);
  page.on("requestfailed", requestDone);
  page.on("response", (res) => {
    const r = res.request();
    if (r.isNavigationRequest() && r.frame() === page.mainFrame() && res.status() >= 500) {
      hub.emit({ kind: "browser_error_page", url: res.url() });
    }
  });
  page.on("framenavigated", (frame) => {
    if (frame !== page.mainFrame()) return;
    hub.emit({ kind: "navigation_done", url: frame.url() });
    s.changed();
  });
  // Why: section 4 §6.10, a native box is never answered automatically. Holding it keeps it open.
  page.on("dialog", (d) => {
    s.dialog = d;
    hub.emit({
      kind: "dialog_opened",
      dialog: { kind: d.type() as "alert" | "confirm" | "prompt", message: d.message() },
    });
    s.changed();
  });
  page.on("download", () => {
    hub.emit({ kind: "browser_blocked", feature: "download" });
  });
  // Why: with a listener set, Playwright holds the file chooser, so it never opens.
  page.on("filechooser", () => {
    hub.emit({ kind: "browser_blocked", feature: "upload" });
  });
  page.on("crash", () => {
    hub.emit({ kind: "connection_closed" });
  });
  page.on("close", () => {
    const i = s.pages.indexOf(page);
    if (i > 0) {
      s.pages.splice(i, 1);
      hub.emit({ kind: "popup_closed" });
      s.changed();
    }
  });
}

/** A Playwright surface: visible Chromium, one fresh context per run (section 4 §8.8). */
export class PlaywrightSurface implements SurfaceSession {
  #browser: Browser | null = null;
  #state: BrowserState | null = null;

  async open(
    cfg: SessionConfig,
  ): Promise<Outcome<{ eyes: Eyes; hands: Hands }, "browser_failed" | "unreachable">> {
    let browser: Browser;
    try {
      browser = await chromium.launch({
        headless: !cfg.visible,
        // Why: section 4 §8.8, crash dumps off.
        args: ["--disable-breakpad", "--disable-crash-reporter"],
      });
    } catch {
      return fail("browser_failed");
    }
    this.#browser = browser;
    const hub = new EventHub<SurfaceEvent>();
    const s = new BrowserState(hub, cfg.viewport);
    this.#state = s;
    browser.on("disconnected", () => {
      if (!s.closed) hub.emit({ kind: "connection_closed" });
    });

    let context: BrowserContext;
    try {
      // Why: section 4 §8.8 and §6.10. In memory only: no profile, no downloads, no service
      // workers, no permissions, no video, no trace. Fixed viewport and pixel density.
      context = await browser.newContext({
        viewport: cfg.viewport,
        deviceScaleFactor: 1,
        locale: cfg.locale,
        timezoneId: cfg.timeZone,
        serviceWorkers: "block",
        acceptDownloads: false,
        permissions: [],
      });
      await context.addInitScript({ content: `${NAME_SHIM}\n${NO_PRINT}` });
      await context.route("**/*", (route) => guard(route, cfg.allowlist, hub));
      await context.routeWebSocket(/.*/, (ws) => {
        const v = cfg.allowlist.check(ws.url(), "websocket");
        if (v.allowed) {
          ws.connectToServer();
          return;
        }
        hub.emit({ kind: "network_blocked", url: ws.url(), request: "websocket", rule: v.rule });
        void ws.close();
      });
      let starting = true;
      context.on("page", (page) => {
        // Why: the first page is the session's own window, not a pop-up.
        if (starting) return;
        if (!cfg.allowlist.popups) {
          hub.emit({ kind: "browser_blocked", feature: "popup" });
          void page.close();
          return;
        }
        s.pages.push(page);
        watchPage(s, page);
        void page.waitForLoadState("domcontentloaded").then(
          () => {
            hub.emit({ kind: "popup_opened", url: page.url() });
            s.changed();
          },
          () => undefined,
        );
      });
      const page = await context.newPage();
      starting = false;
      s.pages.push(page);
      watchPage(s, page);
    } catch {
      await this.close();
      return fail("browser_failed");
    }

    const main = s.pages[0];
    if (main === undefined) return fail("browser_failed");
    try {
      await main.goto(new URL("/", cfg.origin).href, {
        waitUntil: "load",
        timeout: STEP_TIMEOUT_MS,
      });
    } catch (e) {
      // Why: a start page the guard blocks leaves a blank window. Anything else is unreachable.
      if (!(e instanceof Error && /ERR_BLOCKED_BY_CLIENT/.test(e.message))) {
        await this.close();
        return fail("unreachable");
      }
    }
    return ok({ eyes: new PlaywrightEyes(s), hands: new PlaywrightHands(s) });
  }

  async close(): Promise<void> {
    if (this.#state !== null) {
      this.#state.closed = true;
      this.#state.hub.end();
    }
    const b = this.#browser;
    this.#browser = null;
    await b?.close();
  }
}
