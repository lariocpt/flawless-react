// N2 — the refusal control: a COMPUTED aria-label. The attribute value is a
// template literal, not a string literal, so the analyser never records it
// and the emitter must not assert any aria-label for this button; the
// locator falls to the role/text rung ("Save") instead.
"use client";

export function N2ComputedAriaLabel({ count }: { count: number }) {
  function save() {}
  return (
    <div>
      <button aria-label={`Save ${count} items`} onClick={save}>
        Save
      </button>
    </div>
  );
}
