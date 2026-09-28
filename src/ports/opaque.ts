// A placeholder brand for port types that a later milestone defines.
// Follows docs/decisions.md (M01): later types are opaque placeholders until their milestone.

/** The brand key. It exists only at compile time. */
declare const opaqueBrand: unique symbol;

/**
 * A type that a later milestone defines. Nothing can make one until then, so no code can
 * depend on its shape by accident. Example: `Opaque<"Observation">`.
 */
export type Opaque<Name extends string> = { readonly [opaqueBrand]: Name };
