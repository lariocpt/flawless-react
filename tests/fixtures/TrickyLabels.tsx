import React from "react";

/**
 * Interaction labels that are hostile to the emitters' template-literal titles:
 * a backtick terminates the emitted literal early, and a `${` becomes a live
 * substitution instead of the label text.
 */
export function TrickyLabels({ onPay, onQuote }: { onPay: () => void; onQuote: () => void }) {
  return (
    <div>
      <button type="button" onClick={onQuote}>
        It`s a `quoted` label
      </button>
      <button type="button" aria-label="Pay ${amount} now" onClick={onPay}>
        <span aria-hidden="true" />
      </button>
    </div>
  );
}
