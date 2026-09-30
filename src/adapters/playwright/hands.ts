// The Playwright hands: perform one resolved action. Only the gate receives them.
// Follows design section 9 §5.2 (hands; transport trouble is a value), section 7 §7.2 and §7.3,
// section 4 §8.5 to §8.7 (a secret is opened only here, and never echoed in an error).
import type { ActResult, Hands, ResolvedAction } from "../../ports/hands.js";
import { fail, ok, type Outcome } from "../../ports/outcome.js";
import { Secret } from "../../ports/secret.js";
import { markSecretField } from "./page-script.js";
import { SECRET_KEY, STEP_TIMEOUT_MS, type BrowserState } from "./state.js";

/** Why: no error text leaves the hands. A library message might echo a typed value (section 4 §8.7). */
function transportOf(e: unknown): ActResult {
  const name = e instanceof Error ? e.name : "";
  const text = e instanceof Error ? e.message : "";
  if (name === "TimeoutError") return { dispatched: "unknown", transport: "navigation_timeout" };
  if (/ERR_BLOCKED_BY_CLIENT/.test(text)) return { dispatched: true };
  if (/closed|ERR_CONNECTION|ERR_EMPTY_RESPONSE|ERR_ABORTED/.test(text)) {
    return { dispatched: "unknown", transport: "connection_closed" };
  }
  return { dispatched: "unknown" };
}

/** The hands over one Playwright session. */
export class PlaywrightHands implements Hands {
  constructor(private readonly s: BrowserState) {}

  async act(a: ResolvedAction): Promise<Outcome<ActResult, "stale_element">> {
    const page = this.s.active;
    if (page === null) return ok({ dispatched: false, transport: "connection_closed" });
    const done = ok<ActResult>({ dispatched: true });
    try {
      if (a.type === "navigate") {
        // Why: the hands only dispatch; the engine waits for state (section 7 §2.1, §5.1). Waiting
        // for "load" hangs when the page's own script starts a jump the guard then blocks.
        const res = await page.goto(a.url, { waitUntil: "commit", timeout: STEP_TIMEOUT_MS });
        return res !== null && res.status() >= 500
          ? ok({ dispatched: true, transport: "browser_error_page" })
          : done;
      }
      if (a.type === "scroll") {
        await page.mouse.wheel(0, a.direction === "down" ? 600 : -600);
        return done;
      }
      if (a.type === "press" && a.target === null) {
        const step = page.keyboard.press(a.key);
        step.catch(() => undefined);
        await Promise.race([step, this.s.nextDialog()]);
        return done;
      }
      if (a.target === null) return done;
      const t = await this.s.resolve(a.target);
      if (t === null) return fail("stale_element");

      if (t.kind === "dialog") {
        const d = this.s.dialog;
        if (a.type !== "click" || d === null || t.part === "box") return ok({ dispatched: false });
        // Why: section 9 §5.2, answering a native dialog is a click on Accept or Dismiss.
        if (t.part === "accept") await d.accept();
        else await d.dismiss();
        // Why: Playwright has no "dialog closed" event, so the hands report it.
        this.s.dialog = null;
        this.s.hub.emit({ kind: "dialog_closed" });
        this.s.changed();
        return done;
      }

      const opts = { timeout: STEP_TIMEOUT_MS };
      /**
       * Why: an action that opens a native box does not return while the box is open. The box
       * is proof the action went out, so it counts as dispatched; the action ends once answered.
       */
      const orDialog = async (step: Promise<unknown>): Promise<void> => {
        step.catch(() => undefined);
        await Promise.race([step, this.s.nextDialog()]);
      };
      switch (a.type) {
        case "click": {
          // Why: section 7 §7.1, the readiness wait is capped shorter than a full step's
          // timeout. `a.readinessTimeoutMs` is undefined for a caller that does not set it.
          const clickOpts = { timeout: a.readinessTimeoutMs ?? STEP_TIMEOUT_MS };
          await orDialog(t.locator.click(clickOpts));
          return done;
        }
        case "type": {
          const secret = a.text instanceof Secret;
          // Why: section 4 §8.5, the value is fetched at typing time and dropped right after.
          await t.locator.fill(a.text instanceof Secret ? Secret.open(a.text) : a.text, opts);
          if (secret) await t.locator.evaluate(markSecretField, SECRET_KEY);
          return done;
        }
        case "select":
          await t.locator.selectOption({ label: a.option }, opts);
          return done;
        case "set_checked":
          await t.locator.setChecked(a.checked, opts);
          return done;
        case "press":
          await orDialog(t.locator.press(a.key, opts));
          return done;
      }
    } catch (e) {
      // Why: an action that timed out before its dispatch never reached the page.
      if (a.type !== "navigate" && e instanceof Error && e.name === "TimeoutError") {
        return ok({ dispatched: false });
      }
      return ok(transportOf(e));
    }
  }
}
