// P1 — D1 item 1 (shipped on this branch's base): a statically disabled
// control with a handler. The emitter must assert toBeDisabled() — the depth
// census records which tier that classifier lands it at.
"use client";

export function P1AlwaysDisabled() {
  function submit() {}
  return (
    <div>
      <p>Checkout summary</p>
      <button type="button" disabled onClick={submit}>
        Pay now
      </button>
    </div>
  );
}
