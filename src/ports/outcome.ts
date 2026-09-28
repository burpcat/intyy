// The answer every port returns: a value, or an expected failure. Bugs throw instead.
// Follows design section 9 §2.3 and §5.1.

/** A port's answer. Expected trouble is a value. Bugs throw. `detail` is masked text. */
export type Outcome<T, F extends string> = Ok<T> | Fail<F>;

/** The success half of an {@link Outcome}. */
export type Ok<T> = { ok: true; value: T };

/** The failure half of an {@link Outcome}. `failure` is one of the port's listed failure names. */
export type Fail<F extends string> = { ok: false; failure: F; detail?: string };

/** Makes a success. Use `ok(undefined)` for a port that returns nothing. */
export function ok<T>(value: T): Ok<T> {
  return { ok: true, value };
}

/** Makes an expected failure. `detail` must already be masked. */
export function fail<F extends string>(failure: F, detail?: string): Fail<F> {
  // Why: exactOptionalPropertyTypes forbids `detail: undefined`, so leave the key out.
  return detail === undefined ? { ok: false, failure } : { ok: false, failure, detail };
}
