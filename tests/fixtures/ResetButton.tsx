import type * as React from "react";

/**
 * The shape of a Next.js error boundary: a callable prop whose name follows no
 * convention. Nothing about `reset` says "function" except where it is used.
 */
export const ResetButton: React.FC<{ error: Error; reset: () => void }> = ({ error, reset }) => {
  return (
    <div>
      <p>{error.message}</p>
      <button type="button" onClick={reset}>
        Try again
      </button>
    </div>
  );
};

export default ResetButton;
