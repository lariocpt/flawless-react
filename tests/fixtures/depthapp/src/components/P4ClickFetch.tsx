// P4 — D1 item 3 (not yet shipped): a fetch fired from an onClick handler,
// not an effect. The emitter still filters fetches to inEffect, so this
// component's spec carries no fetch test at all; the click itself is a
// canary. The rejection is swallowed so a sandboxed run of the suite cannot
// die on an unhandled rejection.
"use client";

export function P4ClickFetch() {
  function ask() {
    void fetch("/api/items").catch(() => undefined);
  }
  return (
    <div>
      <button type="button" onClick={ask}>
        Load items
      </button>
    </div>
  );
}
