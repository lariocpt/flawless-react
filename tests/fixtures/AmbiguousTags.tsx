import type * as React from "react";

/**
 * Two <button>s, and the handler-bearing one carries no text a spec could match
 * — its copy comes from the row it renders. `page.locator("button").first()`
 * would resolve to the OTHER button, which is the shape that made VoteCard's
 * spec click a disabled control and wait out the timeout.
 */
export const AmbiguousTags: React.FC<{ rows: Array<{ id: string; label: string }> }> = ({
  rows,
}) => {
  return (
    <div>
      {rows.map((r) => (
        <button key={r.id} type="button" onClick={() => void r.id}>
          {r.label}
        </button>
      ))}
      <button type="button">Done</button>
    </div>
  );
};

export default AmbiguousTags;
