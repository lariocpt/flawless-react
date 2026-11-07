// P5 — D1 item 4 (not yet shipped): two render branches keyed on a PROP
// predicate. The inversion is consumed only by the RSC spec; on the client
// plane the flipped branch's witness never reaches the emitted suite, so the
// "No items yet" text is absent from P5's spec.
"use client";

export function P5PropPredicate({ empty }: { empty?: boolean }) {
  if (empty) {
    return <p>No items yet</p>;
  }
  return <p>3 items in stock</p>;
}
