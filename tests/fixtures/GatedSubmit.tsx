import type * as React from "react";
import { useState } from "react";
import { logger } from "./log.ts";

/**
 * Two things at once, both decided from the initial render:
 *
 * - `disabled={!choice}` with `useState<string | null>(null)` is disabled the
 *   moment it mounts. Clicking it costs a full Playwright timeout; asserting it
 *   is disabled is true and instant.
 * - the component logs through an imported binding, so "mounts without console
 *   errors" is not a claim its source supports.
 */
export const GatedSubmit: React.FC = () => {
  const [choice, setChoice] = useState<string | null>(null);
  logger.error({ msg: "mounted" });
  return (
    <div>
      <button type="button" onClick={() => setChoice("a")}>
        Pick A
      </button>
      <button type="button" disabled={!choice} onClick={() => setChoice(null)}>
        Cast vote
      </button>
    </div>
  );
};

export default GatedSubmit;
