// P2 — D1 item 2 (shipped on this branch's base): a useState string initial
// that flows into a host element's ATTRIBUTE, not its children. The emitter
// must assert toHaveAttribute(attr, initial) — the pre-D1a shape asserted
// nothing for attribute flows.
"use client";
import { useState } from "react";

export function P2StateToAttribute() {
  const [placeholder] = useState("Enter your email");
  return (
    <div>
      <label htmlFor="p2-email">Email</label>
      <input id="p2-email" type="email" placeholder={placeholder} />
    </div>
  );
}
