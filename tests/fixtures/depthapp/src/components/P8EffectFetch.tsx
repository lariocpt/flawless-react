// P8 — D2a (PLAN-02 items 1–2, shipped on feat/d2a-content-witness): a
// mount-effect fetch whose OpenAPI fixture value ("flawless-depthapp-p8",
// openapi.json) is rendered as text. The parent fetches the payload into
// state and hands it to Greeting, which renders {data.greeting} — the shape
// contentWitness (src/scaffold-tests/templates.ts) requires: a field the
// subtree provably renders as text (propUsage jsx-child), not a read of a
// local state variable. The success scenario therefore asserts the
// fixture's value on screen (T3 — the D0 ruler reads a quoted flawless-
// sentinel text query as T3); the other three fetch-state tests still end
// in TODO(flawless) — D3 owns the loading indicator and the error-state
// UI, and the empty branch's copy has no harvested literal to witness.
"use client";
import { useEffect, useState } from "react";

export function P8EffectFetch() {
  const [data, setData] = useState<{ greeting: string } | null>(null);
  useEffect(() => {
    void fetch("/api/items")
      .then((r) => r.json())
      .then((d: { greeting: string }) => setData(d))
      .catch(() => setData(null));
  }, []);
  if (data === null) {
    return <p>Loading…</p>;
  }
  return <Greeting data={data} />;
}

function Greeting({ data }: { data: { greeting: string } }) {
  return <p>{data.greeting}</p>;
}
