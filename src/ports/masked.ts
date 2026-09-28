// The Masked brand. Model ports and the evidence store accept Masked data only.
// Follows design section 9 §2.2 and §5.1, and build plan section 10 §5.3.

/** The brand key. It exists only at compile time. */
declare const maskedBrand: unique symbol;

/**
 * A value the redaction module has masked. Only `src/core/safety/redaction/` can make one.
 * A raw value does not fit, so "forgot to mask" fails to compile (section 9 §5.1).
 */
export type Masked<T> = T & { readonly [maskedBrand]: true };
