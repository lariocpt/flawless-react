import type * as React from "react";

/**
 * Two mutually exclusive branches give the same `name` to different controls.
 * Neither is provably rendered — the condition is a prop nothing resolves — so
 * `[name="visibleTo"]` picks out no single control, and the generated fill
 * called selectOption on what turned out to be a hidden input.
 */
export const BranchedField: React.FC<{ canPostInternal: boolean; onSubmit: () => void }> = ({
  canPostInternal,
  onSubmit,
}) => {
  return (
    <form onSubmit={onSubmit}>
      <label htmlFor="body">Body</label>
      <textarea id="body" name="body" />
      {canPostInternal ? (
        <select name="visibleTo" defaultValue="all">
          <option value="all">All</option>
          <option value="some">Some</option>
        </select>
      ) : (
        <input type="hidden" name="visibleTo" value="all" />
      )}
      <button type="submit">Post update</button>
    </form>
  );
};

export default BranchedField;
