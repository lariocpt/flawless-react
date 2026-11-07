// P9 — D3 (not yet shipped): a literal setter call that changes rendered
// copy. The post-click text ("Visited") is never asserted — the emitter has
// no text witness for the transition; only the pre-click copy is a static
// witness, and the click test ends in its TODO tail.
"use client";
import { useState } from "react";

export function P9SetterTransition() {
  const [count, setCount] = useState(0);
  function recordVisit() {
    setCount(1);
  }
  return (
    <div>
      <span>{count === 0 ? "No visits" : "Visited"}</span>
      <button type="button" onClick={recordVisit}>
        Record visit
      </button>
    </div>
  );
}
