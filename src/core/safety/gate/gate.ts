// The action gate: every action crosses it, in a fixed check order. It alone holds the hands.
// Follows design section 4 §3.3 (check order), §3.4 (decisions), §3.5 (per-actor meaning),
// §3.6 (rule IDs), §3.7 (log lines), §6.9 (actions per actor), §7.8 (replay checks 1 to 4),
// §7.9 (helpers), §7.10 (humans), and section 9 §5.2 (only the gate receives hands).
import type { ActResult, Hands, ResolvedAction } from "../../../ports/hands.js";
import { fromFactory } from "../../../ports/hands.js";
import type { Masked } from "../../../ports/masked.js";
import { fail, ok, type Outcome } from "../../../ports/outcome.js";
import type {
  ElementRef,
  Eyes,
  LeaseToken,
  Observation,
  SessionConfig,
  SurfaceElement,
  SurfaceFactory,
} from "../../../ports/surface.js";
import { checkActionType, checkKey } from "../policy/allowlist.js";
import type { EffectivePolicy } from "../policy/merge.js";
import { matchesAny, normalizePath, parsePattern, type PathMatcher } from "../policy/paths.js";
import type { Redactor } from "../redaction/redactor.js";
import {
  classify,
  normalizeWords,
  type ClickInput,
  type RiskClass,
  type RiskInput,
} from "../risk/classify.js";
import type { Actor, RuleId } from "../rules.js";
import {
  SecretInjector,
  secretErrorText,
  secretInText,
  type SecretSources,
} from "../secrets/injector.js";

/** A value to type. An input names its reference and label, so C1 and the log can use them. */
export type TypeValue =
  | { kind: "text"; text: string }
  | { kind: "secret"; name: string }
  | { kind: "input"; ref: string; text: string; label: "pii" | "financial" | "none" };

/** An action someone proposes. `navigate` takes a path or a full address. `read` is the eyes' job. */
export type GateAction =
  | { type: "navigate"; to: string }
  | { type: "click"; target: ElementRef; readinessTimeoutMs?: number }
  | { type: "type"; target: ElementRef; value: TypeValue }
  | { type: "select"; target: ElementRef; option: string }
  | { type: "set_checked"; target: ElementRef; checked: boolean }
  | { type: "press"; key: string; target: ElementRef | null }
  | { type: "scroll"; direction: "up" | "down" };

/** One proposal: who, with which lease, what, and the facts replay knows about it. */
export type Proposal = {
  actor: Actor;
  lease: LeaseToken;
  action: GateAction;
  /** The artifact step or handler action, for the log. */
  step: string | null;
  /** The human-confirmed risk flag, and the words recorded with it (section 4 §7.8, check 4). */
  confirmed?: { risk: RiskClass; words: readonly string[] };
  /** This is the step named in `recovery.commit_point` (section 4 §7.8, check 1). */
  commitPoint?: boolean;
  /** A human said yes to this one action (rule `risk.human_approved`). */
  approval?: { by: string };
};

/** The run facts, frozen at run start (section 4 §2.5). */
export type GateRun = {
  kind: "discovery" | "replay";
  readOnly: boolean;
  /** The capability matches `approvals.force_human` (section 4 §7.8). */
  forceHuman: boolean;
  /** Checked again at the commit point, right now (section 4 §7.8, check 1). */
  authorizationValid: () => boolean;
  /** The artifact's `runs_on.paths`. Null in discovery, where no artifact exists yet. */
  declaredPaths: readonly string[] | null;
};

/** A gate decision (section 4 §3.4). */
export type Decision = "allowed" | "blocked" | "needs_approval" | "observed";

/** What a block means for each actor (section 4 §3.5). The caller acts on it. */
export type OnBlock = "action_blocked" | "takeover_unsafe_state" | "tell_llm" | "none";

/** The gate's answer. `act` is set only when the hands acted. */
export type GateResult = {
  decision: Decision;
  rule: RuleId;
  risk: RiskClass | null;
  onBlock: OnBlock;
  act?: ActResult;
};

/** One `gate` log line's content (section 4 §3.7). Screen text and paths are masked. */
export type GateLine = {
  event: "gate";
  step: string | null;
  by: "gate";
  why: { kind: "policy"; ref: RuleId };
  data: {
    actor: Actor;
    action: GateAction["type"] | "download" | "upload" | "document" | "resource" | "websocket";
    decision: Decision;
    risk?: RiskClass;
    label?: Masked<string>;
    path?: Masked<string>;
  };
};

/** What the gate needs besides the session. */
export type GateDeps = {
  policy: EffectivePolicy;
  redactor: Redactor;
  run: GateRun;
  /** The current control grant (section 7 §12). M07 builds leases; until then a fixed token. */
  lease: () => LeaseToken | null;
  /** Receives every gate line. The log writer adds `seq`, `at`, and `run_id`. */
  log: (line: GateLine) => void;
  /** Declared secrets, their bindings, and the secret port (section 4 §8). */
  secrets: SecretSources;
};

/** A page or frame load the network guard blocked, and who acted last before it (section 4 §6.8). */
export type BlockedLoad = { actor: Actor; path: Masked<string>; rule: RuleId };

/** Failures `gate.act` may return. `secret_unavailable`: the value vanished after the start check. */
export type GateFailure = "stale_element" | "page_gone" | "secret_unavailable";

/** The gate's face to the rest of intyy. */
export interface Gate {
  /** Checks one proposal in the order of section 4 §3.3, then acts only when allowed. */
  act(p: Proposal, signal?: AbortSignal): Promise<Outcome<GateResult, GateFailure>>;
  /** Marks the last action as settled: nothing is in flight (section 4 §7.9, `risk.in_flight`). */
  settled(): void;
  /**
   * The page and frame loads the network guard blocked since the last call, oldest first.
   * The caller acts per actor (section 4 §6.8): a discovery LLM is told, and the run goes on.
   */
  blockedLoads(): BlockedLoad[];
  /** Closes the session. */
  close(): Promise<void>;
}

const ON_BLOCK: Record<Actor, OnBlock> = {
  engine: "action_blocked",
  handler: "takeover_unsafe_state",
  reviewer: "takeover_unsafe_state",
  llm: "tell_llm",
  human: "none",
};

/** Actors each run kind allows. Replay never asks a model; `engine` is a replay step (section 4 §3.5). */
const ACTORS_BY_RUN: Record<GateRun["kind"], readonly Actor[]> = {
  discovery: ["llm", "handler", "human"],
  replay: ["engine", "handler", "reviewer", "human"],
};

const RANK: Record<RiskClass, number> = { idempotent: 0, reversible: 1, irreversible: 2 };

/** Text that looks like a mask or a reference. Typing it would put a mask into the app (§3.6). */
const MASK_TOKEN =
  /\[[a-z]+#\d+\]|\[(?:secret|human_text|pii|financial)\]|\{(?:input|output|secret|system)\.[a-z0-9_]+\}/;

/** The words risk reads from a control: name, visible text, and tooltip (section 4 §7.3). */
function wordsOf(el: SurfaceElement): string[] {
  return [el.clues.name, el.clues.text, el.tooltip].filter((w): w is string => w !== undefined);
}

/** A money value in a field: `$` or `USD`, or two decimals (section 4 §7.5, C1). */
const MONEY_VALUE = /^(?:\$|USD)\s?\d[\d,]*(?:\.\d{1,2})?$|^\d[\d,]*\.\d{2}$/;

/** Parses the declared paths. The artifact loader already checked them; a failure is a bug. */
function compile(patterns: readonly string[]): PathMatcher[] {
  return patterns.map((p) => {
    const m = parsePattern(p);
    if (!m.ok) throw new Error(`artifact holds a bad path pattern: ${p}`);
    return m.value;
  });
}

/** The gate over one session. Only this module turns proposals into hands calls. */
class ActionGate implements Gate {
  #commitSent = false;
  #inFlight = false;
  /** Who acted last. A download or file chooser that follows is logged under this actor. */
  #lastActor: Actor = "engine";
  /** Page and frame loads the guard blocked, not yet collected by the caller. */
  #blocked: BlockedLoad[] = [];
  /** Hosts already logged for a blocked resource: once per host per run (section 4 §6.8). */
  readonly #loggedHosts = new Set<string>();
  /** Forms that received a `financial` input, for C1 (section 4 §7.5). */
  readonly #moneyForms = new Set<string>();
  readonly #declared: PathMatcher[] | null;
  readonly #secrets: SecretInjector;

  constructor(
    private readonly eyes: Eyes,
    private readonly hands: Hands,
    private readonly cfg: SessionConfig,
    private readonly deps: GateDeps,
    private readonly closeSession: () => Promise<void>,
  ) {
    this.#declared = deps.run.declaredPaths === null ? null : compile(deps.run.declaredPaths);
    this.#secrets = new SecretInjector(deps.secrets, deps.policy.paths.case_sensitive);
    void this.#logBrowserBlocks();
  }

  /**
   * Writes a gate line for each blocked download or file chooser (section 4 §6.10), and for each
   * request the network guard cancelled (section 4 §6.8): every page or frame load, and other
   * requests once per host.
   */
  async #logBrowserBlocks(): Promise<void> {
    for await (const e of this.eyes.events()) {
      if (e.kind === "network_blocked") {
        this.#logNetworkBlock(e.url, e.request, e.rule);
        continue;
      }
      if (e.kind !== "browser_blocked" || e.feature === "popup") continue;
      const ref = e.feature === "download" ? "browser.download" : "browser.upload";
      this.deps.log({
        event: "gate",
        step: null,
        by: "gate",
        why: { kind: "policy", ref },
        data: { actor: this.#lastActor, action: e.feature, decision: "blocked" },
      });
    }
  }

  /** Logs one cancelled request, and keeps a page or frame load for the caller. */
  #logNetworkBlock(
    url: string,
    request: "document" | "resource" | "websocket",
    rule: RuleId,
  ): void {
    const u = URL.canParse(url) ? new URL(url) : null;
    if (request !== "document") {
      const host = u === null ? url : u.host;
      if (this.#loggedHosts.has(host)) return;
      this.#loggedHosts.add(host);
    }
    const path = this.deps.redactor.text(u === null ? url : `${u.pathname}${u.search}`);
    this.deps.log({
      event: "gate",
      step: null,
      by: "gate",
      why: { kind: "policy", ref: rule },
      data: { actor: this.#lastActor, action: request, decision: "blocked", path },
    });
    if (request === "document") this.#blocked.push({ actor: this.#lastActor, path, rule });
  }

  blockedLoads(): BlockedLoad[] {
    return this.#blocked.splice(0);
  }

  settled(): void {
    this.#inFlight = false;
  }

  close(): Promise<void> {
    return this.closeSession();
  }

  /** Writes one gate line and returns the result. */
  #decide(
    p: Proposal,
    decision: Decision,
    rule: RuleId,
    risk: RiskClass | null,
    extra: { label?: string; path?: string } = {},
  ): GateResult {
    const data: GateLine["data"] = { actor: p.actor, action: p.action.type, decision };
    if (risk !== null) data.risk = risk;
    if (extra.label !== undefined) data.label = this.deps.redactor.text(extra.label);
    if (extra.path !== undefined) data.path = this.deps.redactor.text(extra.path);
    this.deps.log({
      event: "gate",
      step: p.step,
      by: "gate",
      why: { kind: "policy", ref: rule },
      data,
    });
    return { decision, rule, risk, onBlock: decision === "blocked" ? ON_BLOCK[p.actor] : "none" };
  }

  async act(p: Proposal, signal?: AbortSignal): Promise<Outcome<GateResult, GateFailure>> {
    const { policy, run } = this.deps;
    const a = p.action;
    const block = (
      rule: RuleId,
      risk: RiskClass | null = null,
      extra = {},
    ): Outcome<GateResult, never> => ok(this.#decide(p, "blocked", rule, risk, extra));

    // Check 1: the lease (section 4 §3.3). A human is observed, never gated (§7.10).
    if (p.actor !== "human") {
      const holder = this.deps.lease();
      if (holder === null || holder !== p.lease) return block("lease.not_holder");
    }

    // Check 2: the action type, for this actor and this run.
    if (!ACTORS_BY_RUN[run.kind].includes(p.actor)) return block("allowlist.action");
    const typeRule = checkActionType(p.actor, a.type, policy.actions.types);
    if (typeRule !== null) return block(typeRule);
    if (a.type === "press") {
      const keyRule = checkKey(p.actor, a.key, policy);
      if (keyRule !== null) return block(keyRule);
    }

    const seen = await this.eyes.observe(signal);
    if (!seen.ok) return fail("page_gone");
    const o = seen.value;

    // Check 3: the page. A navigate checks its target; anything else the current page.
    const pageUrl = a.type === "navigate" ? new URL(a.to, this.cfg.origin).href : o.url;
    const page = this.cfg.allowlist.check(pageUrl, "document");
    const path = URL.canParse(pageUrl) ? new URL(pageUrl).pathname : pageUrl;
    if (!page.allowed) return block(page.rule, null, { path });
    if (a.type === "navigate" && (p.actor === "handler" || p.actor === "reviewer")) {
      if (!this.#declaredHas(pageUrl)) return block("helper.path", null, { path });
    }

    const target =
      "target" in a && a.target !== null ? o.elements.find((e) => e.ref === a.target) : undefined;
    if ("target" in a && a.target !== null && target === undefined) return fail("stale_element");

    // Check 4: the value (section 4 §8.5, §6.9).
    let action = a;
    if (a.type === "type") {
      const v = this.#secretValue(a.value);
      if (v === "joined") return block("secret.whole_value");
      action = { ...a, value: v };
      if (v.kind === "text" && MASK_TOKEN.test(v.text)) return block("value.mask_token");
      if (p.actor === "handler" && v.kind === "input") return block("allowlist.action");
      if (p.actor === "reviewer" && v.kind !== "input") return block("allowlist.action");
      if (v.kind === "secret") {
        const rule = this.#secrets.check(v.name, o.url, target?.field);
        if (rule !== null) return block(rule, null, { path });
      } else if (target?.field?.kind === "password") {
        // Why: section 4 §8.5, a password field accepts only a password secret.
        return block("secret.field_kind", null, { path });
      }
    }

    // Check 5: the risk class (section 4 §7).
    if (target !== undefined && o.dialog?.kind === "prompt") {
      // Why: section 4 §6.10, intyy cannot know what text is safe to enter.
      return block("browser.prompt");
    }
    const input = this.#riskInput(a, o, target, page.irreversible);
    // Why: section 4 §7.5 C1, a form that holds a financial input submits money.
    if (a.type === "type" && a.value.kind === "input" && a.value.label === "financial") {
      if (target?.form !== undefined) this.#moneyForms.add(target.form.id);
    }
    const rules = classify(input, policy.risk);
    const label = target === undefined ? undefined : (target.clues.name ?? target.clues.text);
    const extra = { ...(label === undefined ? {} : { label }), path };

    if (p.actor === "human") {
      return ok(this.#decide(p, "observed", "human.observed", rules.risk, extra));
    }

    // Why: section 4 §7.8 check 4, a human's flag holds for the exact words the human saw.
    let risk = rules.risk;
    let unsure = rules.unsure;
    if (p.confirmed !== undefined) {
      const live = target === undefined ? null : wordsOf(target);
      const same = live === null || sameWords(live, p.confirmed.words);
      if (!same) {
        // ponytail: no picture match until M08, so a control with no words is always blocked here.
        if (live.length === 0) return block("risk.live_mismatch", rules.risk, extra);
        if (RANK[rules.risk] > RANK[p.confirmed.risk])
          return block("risk.live_mismatch", rules.risk, extra);
      }
      risk = p.confirmed.risk;
      unsure = false;
    }

    // Helpers (section 4 §7.9).
    if (p.actor === "handler" || p.actor === "reviewer") {
      if (this.#inFlight) return block("risk.in_flight", risk, extra);
      if (risk === "irreversible") return block("risk.actor", risk, extra);
      if (p.actor === "reviewer" && risk !== "idempotent") return block("risk.actor", risk, extra);
      if (p.actor === "handler" && risk === "reversible" && p.confirmed === undefined) {
        return block("risk.actor", risk, extra);
      }
    }

    // Check 6: the decision.
    if (risk === "irreversible") {
      if (run.readOnly) return block("risk.read_only_run", risk, extra);
      // Why: section 4 §7.8 check 3 is a replay check. In discovery a human answers each one (§7.7).
      if (run.kind === "replay" && this.#commitSent)
        return block("risk.second_commit", risk, extra);
      if (p.approval !== undefined) {
        return this.#go(
          p,
          this.#decide(p, "allowed", "risk.human_approved", risk, extra),
          action,
          true,
          signal,
        );
      }
      const authorized =
        p.actor === "engine" &&
        p.commitPoint === true &&
        !run.forceHuman &&
        run.authorizationValid();
      if (authorized) {
        return this.#go(
          p,
          this.#decide(p, "allowed", "risk.authorized", risk, extra),
          action,
          true,
          signal,
        );
      }
      const rule = unsure ? "risk.unsure" : "risk.needs_approval";
      return ok(this.#decide(p, "needs_approval", rule, risk, extra));
    }
    return this.#go(
      p,
      this.#decide(p, "allowed", "risk.allowed", risk, extra),
      action,
      risk !== "idempotent",
      signal,
    );
  }

  /** True when the address is inside the artifact's `runs_on.paths`. Discovery has none. */
  #declaredHas(url: string): boolean {
    if (this.#declared === null) return false;
    const u = new URL(url);
    const cs = this.deps.policy.paths.case_sensitive;
    const n = normalizePath(u.pathname + u.search, cs);
    return n.ok && matchesAny(this.#declared, n.value, cs);
  }

  /** Builds what the risk rules read, from the live screen (section 4 §7.2 to §7.5). */
  #riskInput(
    a: GateAction,
    o: Observation,
    target: SurfaceElement | undefined,
    pageIrreversible: boolean,
  ): RiskInput {
    const click = (el: SurfaceElement): ClickInput => {
      const inForm = el.form;
      const moneyForm =
        inForm !== undefined &&
        inForm.submits &&
        (this.#moneyForms.has(inForm.id) ||
          o.elements.some(
            (e) => e.form?.id === inForm.id && MONEY_VALUE.test((e.field?.value ?? "").trim()),
          ));
      return {
        type: "click",
        control: { role: el.role, roleGroup: el.roleGroup, words: wordsOf(el) },
        link: el.href === undefined ? null : linkVerdict(this.cfg, el.href),
        pageIrreversible,
        submitsMoneyForm: moneyForm,
        // Why: section 4 §7.5 C3, accepting a native box reads its message.
        dialogMessage:
          o.dialog !== null && el.clues.path === "native:dialog > accept" ? o.dialog.message : null,
      };
    };
    switch (a.type) {
      case "navigate":
        return { type: "navigate", irreversiblePath: pageIrreversible };
      case "click":
        return target === undefined ? { type: "scroll" } : click(target);
      case "press": {
        if (a.key !== "Enter") return { type: "press", key: a.key, submit: null };
        const formId = target?.form?.id;
        const submit = o.elements.find(
          (e) => formId !== undefined && e.form?.id === formId && e.form.submits,
        );
        return { type: "press", key: a.key, submit: submit === undefined ? null : click(submit) };
      }
      default:
        return { type: a.type };
    }
  }

  /** Acts, then records what the gate must remember: the commit and anything in flight. */
  async #go(
    p: Proposal,
    result: GateResult,
    a: GateAction,
    nonIdempotent: boolean,
    signal?: AbortSignal,
  ): Promise<Outcome<GateResult, GateFailure>> {
    this.#lastActor = p.actor;
    const acted =
      a.type === "type" && a.value.kind === "secret"
        ? await this.#typeSecret(a, a.value.name, p.lease, p.step, signal)
        : await this.hands.act(this.#resolve(a), p.lease, signal);
    if (!acted.ok) return acted;
    // Why: forward only. A commit that may have gone out counts as sent (section 4 §7.8, check 3).
    if (result.risk === "irreversible" && acted.value.dispatched !== false) this.#commitSent = true;
    if (nonIdempotent && acted.value.dispatched !== false) this.#inFlight = true;
    return ok({ ...result, act: acted.value });
  }

  /**
   * Types a secret. The value is fetched now and dropped after (section 4 §8.5). Any failure,
   * and any thrown error, carries only the fixed text of §8.7.
   */
  async #typeSecret(
    a: Extract<GateAction, { type: "type" }>,
    name: string,
    lease: LeaseToken,
    step: string | null,
    signal?: AbortSignal,
  ): Promise<Outcome<ActResult, GateFailure>> {
    const fixed = secretErrorText(name, step ?? "the target field");
    const value = await this.#secrets.fetch(name, signal);
    if (!value.ok) return value;
    try {
      const acted = await this.hands.act(
        { type: "type", target: a.target, text: value.value },
        lease,
        signal,
      );
      return acted.ok ? acted : fail(acted.failure, fixed);
    } catch {
      // Why: a library error might echo its inputs. Rethrow a bug with the fixed text only.
      throw new Error(fixed);
    }
  }

  /** Reads `{secret.x}` typed as text as secret `x`. Joined secrets come back as `joined`. */
  #secretValue(v: TypeValue): TypeValue | "joined" {
    if (v.kind !== "text") return v;
    const found = secretInText(v.text);
    if (found === "joined") return "joined";
    return found === null ? v : { kind: "secret", name: found.name };
  }

  /** Turns a gated action into what the hands take. */
  #resolve(a: GateAction): ResolvedAction {
    switch (a.type) {
      case "navigate":
        return { type: "navigate", url: new URL(a.to, this.cfg.origin).href };
      case "type":
        // Why: secrets go through #typeSecret, which fetches the value at act time.
        if (a.value.kind === "secret") throw new Error("a secret must go through #typeSecret");
        return { type: "type", target: a.target, text: a.value.text };
      default:
        return a;
    }
  }
}

/** What the allowlist says of a link's target. A malformed address counts as off the list. */
function linkVerdict(
  cfg: SessionConfig,
  href: string,
): { allowed: boolean; irreversible: boolean } {
  const v = cfg.allowlist.check(href, "document");
  return v.allowed
    ? { allowed: true, irreversible: v.irreversible }
    : { allowed: false, irreversible: false };
}

/** True when two word lists hold the same words, after normalizing (section 4 §7.3). */
function sameWords(live: readonly string[], recorded: readonly string[]): boolean {
  const set = (ws: readonly string[]): string =>
    [...new Set(ws.map(normalizeWords).filter((w) => w !== ""))].sort().join("\n");
  return set(live) === set(recorded);
}

/**
 * Opens a surface behind the gate. The caller gets the eyes and the gate; the hands never leave
 * this module (section 9 §5.2). Downloads and file choosers are logged as gate lines (§3.6).
 */
export async function openGate(
  factory: SurfaceFactory,
  cfg: SessionConfig,
  deps: GateDeps,
  signal?: AbortSignal,
): Promise<Outcome<{ eyes: Eyes; gate: Gate }, "browser_failed" | "unreachable">> {
  const session = fromFactory(factory);
  const opened = await session.open(cfg, signal);
  if (!opened.ok) return opened;
  const { eyes, hands } = opened.value;
  return ok({ eyes, gate: new ActionGate(eyes, hands, cfg, deps, () => session.close()) });
}
