// The control lease: who drives the browser (the bot, a human, or nobody), the legal moves
// between those states, and a fresh token for each grant. Follows design section 7 §12 (the
// record, the transitions, the token, human input) and section 4 §3.3 (the gate's first check).
// The gate reads `current()`. A bot action carries `botToken()`. A stale token no longer matches.
import type { Ids } from "../../ports/clock.js";
import { fail, ok, type Outcome } from "../../ports/outcome.js";
import type { LeaseToken } from "../../ports/surface.js";

/** Who holds the lease (section 7 §12.1). */
export type LeaseHolder = "bot" | "human" | "nobody";

/** Why the lease moved (section 3 §6.4, the `lease` reasons). */
export type LeaseReason =
  | "run_start"
  | "awaiting_decision"
  | "decided"
  | "takeover_requested"
  | "claimed"
  | "handed_back"
  | "reverified"
  | "reverify_failed"
  | "run_end";

/** One lease change: the `data` of a `lease` log line (section 3 §6.4). */
export type LeaseChange = {
  from: LeaseHolder;
  to: LeaseHolder;
  reason: LeaseReason;
  staff_id: string | null;
  implicit: boolean;
};

/** What the lease tells the log. `by` is `human` for a claim or a handback, else `engine`. */
export type LeaseSink = (change: LeaseChange, by: "engine" | "human") => void;

/**
 * The `why` block of a `lease` line (section 3 §6.3, §6.4). A person's claim or handback is
 * `human`; every other change is an `engine_rule` whose `ref` is the transition reason.
 */
export function leaseWhy(
  change: LeaseChange,
  by: "engine" | "human",
): { kind: "human" } | { kind: "engine_rule"; ref: LeaseReason } {
  return by === "human" ? { kind: "human" } : { kind: "engine_rule", ref: change.reason };
}

/** An illegal move. Expected trouble, so a value, not a throw (CLAUDE.md). */
export type LeaseFailure = "not_allowed";

/** What human input did to the lease (section 7 §12.4). */
export type HumanInputEffect =
  /** The human already holds the lease. Nothing changes. */
  | { kind: "held" }
  /** The bot held it. The lease went to `nobody` and a takeover is pending. */
  | { kind: "takeover"; wasWaiting: boolean }
  /** Nobody held it, and the replay's staff ID claimed it. */
  | { kind: "implicit_claim"; staff: string }
  /** Nobody held it and there is no staff ID. The takeover waits for `operator claim`. */
  | { kind: "no_claim" };

/** The lease for one run. Held in memory only. */
export class Lease {
  #holder: LeaseHolder = "nobody";
  #staff: string | null = null;
  #waiting = false;
  /** The token of the newest bot grant. It stays after the bot loses the lease, and goes stale. */
  #bot: string | null = null;
  #pending: "unexpected_human_input" | null = null;
  #ended = false;

  constructor(
    private readonly ids: Ids,
    private readonly sink: LeaseSink,
  ) {}

  /** Who holds the lease now. */
  get holder(): LeaseHolder {
    return this.#holder;
  }

  /** The human's staff ID while a human holds the lease. */
  get staffId(): string | null {
    return this.#staff;
  }

  /** True while the bot holds the lease but waits for an approval (section 7 §12.1). */
  get waiting(): boolean {
    return this.#waiting;
  }

  /** True while a takeover that human input opened waits for the engine. A method, not a getter,
   * so TypeScript never caches the answer across an `await`. */
  takeoverPending(): boolean {
    return this.#pending !== null;
  }

  /** The engine takes the pending takeover. Call it once, before opening the request. */
  takePending(): "unexpected_human_input" | null {
    const p = this.#pending;
    this.#pending = null;
    return p;
  }

  /** The token the gate accepts: the bot's grant while the bot holds the lease, else `null`. */
  current(): LeaseToken | null {
    return this.#holder === "bot" && this.#bot !== null ? this.#asToken(this.#bot) : null;
  }

  /** The newest bot token. A bot action carries it. After a takeover it is stale on purpose. */
  botToken(): LeaseToken {
    if (this.#bot === null) throw new Error("Lease.botToken: the run has not started");
    return this.#asToken(this.#bot);
  }

  /** `—` to `bot`: the run starts (section 7 §12.2). */
  start(): Outcome<void, LeaseFailure> {
    return this.#move("nobody", "bot", "run_start", null, false);
  }

  /** `bot` to `bot`, waiting: an approval or start confirmation opens. Keeps the token. */
  awaitDecision(): Outcome<void, LeaseFailure> {
    if (this.#holder !== "bot" || this.#waiting) return fail("not_allowed");
    this.#waiting = true;
    this.sink({ from: "bot", to: "bot", reason: "awaiting_decision", staff_id: null, implicit: false }, "engine");
    return ok(undefined);
  }

  /** `bot`, waiting to `bot`: the decision arrives. Keeps the token. */
  decided(): Outcome<void, LeaseFailure> {
    if (this.#holder !== "bot" || !this.#waiting) return fail("not_allowed");
    this.#waiting = false;
    this.sink({ from: "bot", to: "bot", reason: "decided", staff_id: null, implicit: false }, "engine");
    return ok(undefined);
  }

  /** `bot` to `nobody`: a takeover opens. The bot's token goes stale at once. */
  requestTakeover(): Outcome<void, LeaseFailure> {
    return this.#move("bot", "nobody", "takeover_requested", null, false);
  }

  /** `nobody` to `human`: an operator claims, or human input claims implicitly (section 7 §12.4). */
  claim(staff: string, implicit = false): Outcome<void, LeaseFailure> {
    return this.#move("nobody", "human", "claimed", staff, implicit);
  }

  /** `human` to `nobody`: the operator hands back. Only `reverified` gives the bot the lease. */
  handBack(): Outcome<void, LeaseFailure> {
    return this.#move("human", "nobody", "handed_back", this.#staff, false);
  }

  /** `nobody` to `bot`: reverify passed. A new token. This is the only way back to the bot. */
  reverified(): Outcome<void, LeaseFailure> {
    return this.#move("nobody", "bot", "reverified", null, false);
  }

  /** `nobody` to `nobody`: reverify failed, so the takeover opens again. */
  reverifyFailed(): Outcome<void, LeaseFailure> {
    if (this.#holder !== "nobody" || this.#ended) return fail("not_allowed");
    this.sink({ from: "nobody", to: "nobody", reason: "reverify_failed", staff_id: null, implicit: false }, "engine");
    return ok(undefined);
  }

  /** Any holder to `nobody`: the run ends. Safe to call twice. */
  end(): void {
    if (this.#bot === null || this.#ended) return; // never started, or already ended
    const from = this.#holder;
    this.#holder = "nobody";
    this.#staff = null;
    this.#waiting = false;
    this.#ended = true;
    this.sink({ from, to: "nobody", reason: "run_end", staff_id: null, implicit: false }, "engine");
  }

  /**
   * Human input arrived (section 7 §12.4). While the bot drives, the lease goes to `nobody` and a
   * takeover is pending, so the gate refuses the bot's next action. While nobody holds it, the
   * replay's staff ID claims it implicitly. `implicitStaff` is `null` when there is none.
   */
  humanInput(implicitStaff: string | null): HumanInputEffect {
    if (this.#holder === "human") return { kind: "held" };
    if (this.#holder === "bot") {
      const wasWaiting = this.#waiting;
      this.requestTakeover();
      this.#pending = "unexpected_human_input";
      return { kind: "takeover", wasWaiting };
    }
    if (this.#ended || implicitStaff === null) return { kind: "no_claim" };
    this.claim(implicitStaff, true);
    return { kind: "implicit_claim", staff: implicitStaff };
  }

  /** One checked move. `from` must match, so no `human` to `bot` shortcut exists. */
  #move(
    from: LeaseHolder,
    to: LeaseHolder,
    reason: LeaseReason,
    staff: string | null,
    implicit: boolean,
  ): Outcome<void, LeaseFailure> {
    if (this.#holder !== from || this.#ended) return fail("not_allowed");
    this.#holder = to;
    this.#waiting = false;
    this.#staff = to === "human" ? staff : null;
    // Why a new token for each grant: a stale action from before a takeover must not match
    // (section 7 §12.3).
    const grant = to === "nobody" ? null : this.ids.leaseToken();
    if (to === "bot") this.#bot = grant;
    const by = reason === "claimed" || reason === "handed_back" ? "human" : "engine";
    this.sink({ from, to, reason, staff_id: staff, implicit }, by);
    return ok(undefined);
  }

  /** The one place a token string becomes a `LeaseToken` (an opaque brand with no runtime form). */
  #asToken(raw: string): LeaseToken {
    return raw as unknown as LeaseToken;
  }
}
