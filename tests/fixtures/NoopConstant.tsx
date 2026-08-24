/**
 * A SCREAMING_CASE null-returning arrow is a value constant, not a component
 * — the null-only detection path must refuse to scaffold it.
 */
export const NOOP = () => null;
