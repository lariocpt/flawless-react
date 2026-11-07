// P8 — D2 (not yet shipped): a mount-effect fetch whose OpenAPI fixture value
// ("Hello from the API", openapi.json) is rendered as text. The four
// fetch-state tests exist but end in TODO(flawless): the rendered greeting is
// never asserted anywhere in the spec.
"use client";
import { useEffect, useState } from "react";

export function P8EffectFetch() {
  const [greeting, setGreeting] = useState<string | null>(null);
  useEffect(() => {
    void fetch("/api/items")
      .then((r) => r.json())
      .then((data: { greeting: string }) => setGreeting(data.greeting))
      .catch(() => setGreeting(null));
  }, []);
  if (greeting === null) {
    return <p>Loading…</p>;
  }
  return <p>{greeting}</p>;
}
