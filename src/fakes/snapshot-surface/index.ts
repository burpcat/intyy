// The snapshot surface: a fake twin of the Playwright adapter. It answers from a scripted screen
// graph: screens by path, and what each click does. Follows design section 9 §5.2 and §5.9,
// section 7 §9 (native dialogs and pop-ups), and section 4 §6.8 (the network guard).
import { EventHub } from "../../core/events/hub.js";
import {
  toFactory,
  type ActResult,
  type Hands,
  type ResolvedAction,
  type SurfaceSession,
} from "../../ports/hands.js";
import { fail, ok, type Outcome } from "../../ports/outcome.js";
import { Secret } from "../../ports/secret.js";
import type {
  Allowlist,
  Box,
  ElementRef,
  Eyes,
  FieldState,
  NativeDialog,
  Observation,
  Png,
  RoleGroup,
  SessionConfig,
  SurfaceFactory,
  SurfaceElement,
  SurfaceEvent,
  Viewport,
} from "../../ports/surface.js";

/** What a click does in the fake. An address may be a path or a full URL. */
export type FakeEffect =
  | { go: string }
  | { dialog: NativeDialog; accept?: FakeEffect; dismiss?: FakeEffect }
  | { popup: string }
  | { closePopup: true }
  | { download: true }
  | { upload: true };

/** One scripted element. `frame` puts it inside `frame[n]`. A plain link goes to its `href`. */
export type FakeElement = {
  id: string;
  role: string;
  roleGroup: RoleGroup;
  name?: string;
  label?: string;
  text?: string;
  tooltip?: string;
  href?: string;
  field?: FieldState;
  form?: { id: string; submits: boolean };
  unreadable?: true;
  enabled?: boolean;
  box?: Box | null;
  frame?: number;
  onClick?: FakeEffect;
};

/** One scripted screen. `dom` and `a11y` override the generated raw snapshots. */
export type FakeScreen = { elements: readonly FakeElement[]; dom?: string; a11y?: string };

/** A scripted site: one origin and its screens by path. */
export type FakeSite = { origin: string; screens: Readonly<Record<string, FakeScreen>> };

/** The PNG file signature. Fake images start with it, then JSON that says what was drawn. */
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** A fake PNG: the signature, then the JSON of `body`. Tests read the JSON back. */
function fakePng(body: unknown): Png {
  const json = new TextEncoder().encode(JSON.stringify(body));
  const bytes = new Uint8Array(PNG_SIGNATURE.length + json.length);
  bytes.set(PNG_SIGNATURE);
  bytes.set(json, PNG_SIGNATURE.length);
  // Why a cast: the Png brand has no runtime form.
  return bytes as Png;
}

/** One open window: its address, its screen, and the fields' state. */
type Page = { url: string; screen: FakeScreen; fields: Map<string, FieldState> };

/** The open native box, and what its buttons do. */
type OpenDialog = { dialog: NativeDialog; accept?: FakeEffect; dismiss?: FakeEffect };

/** The fake's live state. `generation` changes on every page change, so old refs go stale. */
class FakeBrowser {
  readonly hub = new EventHub<SurfaceEvent>();
  main: Page | null = null;
  popup: Page | null = null;
  dialog: OpenDialog | null = null;
  generation = 0;
  open = true;

  constructor(
    readonly site: FakeSite,
    readonly allowlist: Allowlist,
    readonly viewport: Viewport,
  ) {}

  /** The active page: the newest open window (section 7 §9.2). */
  get active(): Page | null {
    return this.popup ?? this.main;
  }

  /** Makes a ref for an element on the current generation. */
  ref(id: string): ElementRef {
    // Why a cast: the ElementRef brand has no runtime form.
    return `${String(this.generation)}/${id}` as unknown as ElementRef;
  }

  /** The id behind a ref, or null when the ref is stale. */
  idOf(ref: ElementRef): string | null {
    const [gen, id] = (ref as unknown as string).split("/");
    return gen === String(this.generation) && id !== undefined ? id : null;
  }

  /** Loads an address through the guard (section 4 §6.8). Returns the page, or null when blocked. */
  load(address: string): Page | null {
    const url = new URL(address, this.site.origin).href;
    const verdict = this.allowlist.check(url, "document");
    if (!verdict.allowed) {
      this.hub.emit({ kind: "network_blocked", url, request: "document", rule: verdict.rule });
      return null;
    }
    const u = new URL(url);
    const screen = u.origin === this.site.origin ? this.site.screens[u.pathname] : undefined;
    this.hub.emit({ kind: "navigation_started", url });
    if (screen === undefined) {
      this.hub.emit({ kind: "browser_error_page", url });
      return { url, screen: { elements: [] }, fields: new Map() };
    }
    const fields = new Map<string, FieldState>();
    for (const el of screen.elements)
      if (el.field !== undefined) fields.set(el.id, { ...el.field });
    this.hub.emit({ kind: "navigation_done", url });
    return { url, screen, fields };
  }

  /** Marks a page change, so every old ref goes stale. */
  changed(): void {
    this.generation += 1;
    this.hub.emit({ kind: "page_changed" });
  }

  /** Goes to an address in the active window. A blocked address leaves the page as it was. */
  go(address: string): void {
    const page = this.load(address);
    if (page === null) return;
    if (this.popup !== null) this.popup = page;
    else this.main = page;
    this.changed();
  }

  /** Applies one click effect. */
  apply(effect: FakeEffect): void {
    if ("go" in effect) this.go(effect.go);
    else if ("dialog" in effect) {
      this.dialog = effect;
      this.hub.emit({ kind: "dialog_opened", dialog: effect.dialog });
      this.changed();
    } else if ("popup" in effect) {
      if (!this.allowlist.popups) {
        this.hub.emit({ kind: "browser_blocked", feature: "popup" });
        return;
      }
      const page = this.load(effect.popup);
      if (page === null) return;
      this.popup = page;
      this.hub.emit({ kind: "popup_opened", url: page.url });
      this.changed();
    } else if ("closePopup" in effect) {
      this.popup = null;
      this.hub.emit({ kind: "popup_closed" });
      this.changed();
    } else if ("download" in effect) {
      this.hub.emit({ kind: "browser_blocked", feature: "download" });
    } else {
      this.hub.emit({ kind: "browser_blocked", feature: "upload" });
    }
  }

  /** The dialog's elements (section 7 §9.1). An alert has no Dismiss. */
  dialogElements(d: NativeDialog): SurfaceElement[] {
    const el = (id: string, role: string, name: string, path: string): SurfaceElement => ({
      ref: this.ref(id),
      role,
      roleGroup: role === "button" ? "button_like" : "container",
      clues: { name, path },
      enabled: true,
      box: null,
    });
    const out = [
      el("native-box", "alertdialog", d.message, "native:dialog"),
      el("native-accept", "button", "OK", "native:dialog > accept"),
    ];
    if (d.kind !== "alert")
      out.push(el("native-dismiss", "button", "Cancel", "native:dialog > dismiss"));
    return out;
  }

  /** One page element as the eyes report it. */
  element(page: Page, el: FakeElement): SurfaceElement {
    const prefix = `${page === this.popup ? "window[popup] > " : ""}${
      el.frame === undefined ? "" : `frame[${String(el.frame)}] > `
    }`;
    const out: SurfaceElement = {
      ref: this.ref(el.id),
      role: el.role,
      roleGroup: el.roleGroup,
      clues: { path: `${prefix}${el.role}[${el.id}]` },
      enabled: el.enabled ?? true,
      box: el.box ?? null,
    };
    if (el.name !== undefined) out.clues.name = el.name;
    if (el.label !== undefined) out.clues.label = el.label;
    if (el.text !== undefined) out.clues.text = el.text;
    if (el.tooltip !== undefined) out.tooltip = el.tooltip;
    if (el.href !== undefined) out.href = new URL(el.href, page.url).href;
    if (el.form !== undefined) out.form = el.form;
    if (el.unreadable === true) out.unreadable = true;
    const field = page.fields.get(el.id);
    if (field !== undefined) out.field = { ...field };
    return out;
  }
}

/** The fake's eyes. */
class FakeEyes implements Eyes {
  constructor(private readonly b: FakeBrowser) {}

  observe(): Promise<Outcome<Observation, "page_gone">> {
    const page = this.b.active;
    if (!this.b.open || page === null) return Promise.resolve(fail("page_gone"));
    const d = this.b.dialog?.dialog ?? null;
    return Promise.resolve(
      ok({
        url: page.url,
        page: this.b.popup === null ? "main" : "popup",
        popups: this.b.popup === null ? 0 : 1,
        dialog: d,
        viewport: this.b.viewport,
        // Why: section 7 §9.1, while a box is open only its elements are candidates.
        elements:
          d === null
            ? page.screen.elements.map((el) => this.b.element(page, el))
            : this.b.dialogElements(d),
      }),
    );
  }

  screenshot(masks: readonly ElementRef[]): Promise<Outcome<Png, "page_gone" | "stale_element">> {
    const page = this.b.active;
    if (!this.b.open || page === null) return Promise.resolve(fail("page_gone"));
    const ids = masks.map((m) => this.b.idOf(m));
    if (ids.some((id) => id === null)) return Promise.resolve(fail("stale_element"));
    return Promise.resolve(ok(fakePng({ url: page.url, masks: ids })));
  }

  snapshots(): Promise<Outcome<{ dom: string; a11y: string }, "page_gone">> {
    const page = this.b.active;
    if (!this.b.open || page === null) return Promise.resolve(fail("page_gone"));
    const els = page.screen.elements;
    // Why: raw snapshots hold no field values, like the adapter's (section 3 §7.6, section 4 §2.6).
    const text = (el: FakeElement): string =>
      [el.name ?? el.label, el.text].filter((t) => t !== undefined).join(" ");
    const dom =
      page.screen.dom ??
      `<html><body>${els.map((el) => `<div role="${el.role}">${text(el)}</div>`).join("")}</body></html>`;
    const a11y = page.screen.a11y ?? els.map((el) => `- ${el.role} "${text(el)}"`).join("\n");
    return Promise.resolve(ok({ dom, a11y }));
  }

  crop(el: ElementRef): Promise<Outcome<Png, "stale_element">> {
    const id = this.b.idOf(el);
    return Promise.resolve(id === null ? fail("stale_element") : ok(fakePng({ crop: id })));
  }

  events(signal?: AbortSignal): AsyncIterable<SurfaceEvent> {
    return this.b.hub.subscribe(signal);
  }
}

/** The fake's hands. Only the gate receives them. */
class FakeHands implements Hands {
  constructor(private readonly b: FakeBrowser) {}

  act(a: ResolvedAction): Promise<Outcome<ActResult, "stale_element">> {
    return Promise.resolve(this.#act(a));
  }

  #act(a: ResolvedAction): Outcome<ActResult, "stale_element"> {
    const done = ok<ActResult>({ dispatched: true });
    if (a.type === "navigate") {
      this.b.go(a.url);
      return done;
    }
    if (a.type === "scroll") return done;
    if (a.target === null) return done;
    const id = this.b.idOf(a.target);
    if (id === null) return fail("stale_element");

    const d = this.b.dialog;
    if (d !== null) {
      if (a.type !== "click" || (id !== "native-accept" && id !== "native-dismiss")) {
        return fail("stale_element");
      }
      this.b.dialog = null;
      this.b.hub.emit({ kind: "dialog_closed" });
      this.b.changed();
      const next = id === "native-accept" ? d.accept : d.dismiss;
      if (next !== undefined) this.b.apply(next);
      return done;
    }

    const page = this.b.active;
    const el = page?.screen.elements.find((e) => e.id === id);
    if (page === null || el === undefined) return fail("stale_element");
    if (el.enabled === false) return ok({ dispatched: false });
    const field = page.fields.get(id);

    switch (a.type) {
      case "click":
        if (el.onClick !== undefined) this.b.apply(el.onClick);
        else if (el.href !== undefined) this.b.go(el.href);
        return done;
      case "type":
        if (field === undefined || (field.kind !== "text" && field.kind !== "password")) {
          return ok({ dispatched: false });
        }
        // Why: section 4 §8.6, a secret-filled field keeps no value, only `filled`.
        if (a.text instanceof Secret) page.fields.set(id, { kind: field.kind, filled: true });
        else page.fields.set(id, { kind: field.kind, value: a.text });
        return done;
      case "select":
        if (field?.kind !== "choice") return ok({ dispatched: false });
        page.fields.set(id, { ...field, value: a.option });
        return done;
      case "set_checked":
        if (field?.kind !== "check") return ok({ dispatched: false });
        page.fields.set(id, { ...field, checked: a.checked });
        return done;
      case "press": {
        if (a.key !== "Enter" || el.form === undefined) return done;
        const formId = el.form.id;
        const submit = page.screen.elements.find((e) => e.form?.id === formId && e.form.submits);
        if (submit?.onClick !== undefined) this.b.apply(submit.onClick);
        return done;
      }
    }
  }
}

/**
 * A surface session over a scripted site. `open` loads the origin's start page through the guard,
 * like the Playwright adapter. An origin other than the site's is unreachable.
 */
export class SnapshotSurface implements SurfaceSession {
  #browser: FakeBrowser | null = null;

  constructor(private readonly site: FakeSite) {}

  open(
    cfg: SessionConfig,
  ): Promise<Outcome<{ eyes: Eyes; hands: Hands }, "browser_failed" | "unreachable">> {
    if (cfg.origin !== this.site.origin) return Promise.resolve(fail("unreachable"));
    const b = new FakeBrowser(this.site, cfg.allowlist, cfg.viewport);
    this.#browser = b;
    // Why: a blocked start page leaves a blank window, as in a real browser.
    b.main = b.load("/") ?? { url: "about:blank", screen: { elements: [] }, fields: new Map() };
    return Promise.resolve(ok({ eyes: new FakeEyes(b), hands: new FakeHands(b) }));
  }

  close(): Promise<void> {
    if (this.#browser !== null) {
      this.#browser.open = false;
      this.#browser.hub.end();
    }
    return Promise.resolve();
  }
}

/** An unopened snapshot surface over a scripted site. Only the gate can open it. */
export function snapshotFactory(site: FakeSite): SurfaceFactory {
  return toFactory(new SnapshotSurface(site));
}
