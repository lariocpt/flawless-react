import type * as React from "react";

const TRADES = ["plumbing", "electrical", "roofing"];

/**
 * Every field type a blind fill has to treat differently, in one form:
 * a checkbox group sharing one name, a hidden input the component owns, a
 * <select>, and one field that really is text. The submit button's copy
 * deliberately matches none of the verbs the old heuristic looked for.
 */
export const CheckboxForm: React.FC<{ onSubmit: () => void }> = ({ onSubmit }) => {
  return (
    <form onSubmit={onSubmit}>
      <input type="hidden" name="csrf" value="tok" />
      <label htmlFor="note">Note</label>
      <input id="note" name="note" type="text" />
      <label htmlFor="tier">Tier</label>
      <select id="tier" name="tier">
        <option value="a">A</option>
        <option value="b">B</option>
      </select>
      {TRADES.map((t) => (
        <label key={t}>
          <input type="checkbox" name="trades" value={t} />
          {t}
        </label>
      ))}
      <button type="submit">Update details</button>
    </form>
  );
};

export default CheckboxForm;
