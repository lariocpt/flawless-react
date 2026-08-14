import type * as React from "react";
import { useSessionUser } from "./log.ts";

/**
 * An early return the analyser cannot decide: `useSessionUser()` is opaque, so
 * this may render nothing at all. Its interactions come from the tail return,
 * and a browser spec that drives them blindly waits out the full timeout for a
 * trigger that was never going to exist.
 */
export const GuardedMenu: React.FC = () => {
  const user = useSessionUser();
  if (!user) return null;
  return (
    <div>
      <button type="button" onClick={() => void 0}>
        Open account menu
      </button>
    </div>
  );
};

export default GuardedMenu;
