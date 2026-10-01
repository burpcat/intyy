// The opaque Secret value. It never prints its value.
// Follows design section 9 §5.1 (secrets) and section 4 §8.

/** Every way a Secret can print gives this text. */
const HIDDEN = "[secret]";

/** Node's hook for `util.inspect` and `console.log`. A registered symbol, so no `node:util` import. */
const inspectHook = Symbol.for("nodejs.util.inspect.custom");

/**
 * A secret value, such as a password. It prints as `[secret]` everywhere:
 * `String()`, templates, `JSON.stringify`, `console.log`, and error text.
 */
export class Secret {
  // Why: a `#` field is private at run time too. Spreads, `Object.keys`, and inspect never see it.
  readonly #value: string;

  /** Wraps a raw value. Only the secret adapters and fakes call this. */
  constructor(value: string) {
    this.#value = value;
  }

  /**
   * Returns the raw value. Only the hands adapter, the keyed-hash function, the redactor, and
   * the kvfcu harness adapter and fake (`oracle`, section 8 §6.5), and the canary marker
   * resolver (`core/evidence/markers.ts`, updates file §12) may call this
   * (section 9 §5.1; docs/decisions.md, M03, M06). Never log, store, or print the result.
   */
  static open(secret: Secret): string {
    return secret.#value;
  }

  /** Hides the value in strings and templates. */
  toString(): string {
    return HIDDEN;
  }

  /** Hides the value in `JSON.stringify`. */
  toJSON(): string {
    return HIDDEN;
  }

  /** Hides the value in `util.inspect` and `console.log`. */
  [inspectHook](): string {
    return HIDDEN;
  }
}
