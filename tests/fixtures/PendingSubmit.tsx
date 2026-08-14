import type * as React from "react";
import { useState } from "react";

/**
 * `pending` is opaque — it comes from a hook the analyser does not model — but
 * `rows.length === 0` is not, and with `rows` starting empty the disjunction is
 * true whatever `pending` holds. Bailing on the first unknown operand made this
 * a 30-second wait for a control that was never going to enable.
 */
export const PendingSubmit: React.FC<{ pending: boolean }> = ({ pending }) => {
  const [rows, setRows] = useState<string[]>([]);
  return (
    <div>
      <button type="button" disabled={pending || rows.length === 0} onClick={() => setRows([])}>
        Send
      </button>
    </div>
  );
};

export default PendingSubmit;
