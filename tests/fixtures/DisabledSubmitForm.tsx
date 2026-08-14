import type * as React from "react";
import { useState } from "react";

/**
 * The submit button exists and is disabled at the props a spec passes:
 * `picked` starts empty, so the disjunction is true whatever `pending` holds.
 * Reporting that as "no submit control in the markup" would send a reader
 * looking for a button that is right there on the next line.
 */
export const DisabledSubmitForm: React.FC<{ pending: boolean; onSubmit: () => void }> = ({
  pending,
  onSubmit,
}) => {
  const [picked] = useState<string[]>([]);
  return (
    <form onSubmit={onSubmit}>
      <label htmlFor="msg">Message</label>
      <textarea id="msg" name="msg" />
      <button type="submit" disabled={pending || picked.length === 0}>
        Start conversation
      </button>
    </form>
  );
};

export default DisabledSubmitForm;
