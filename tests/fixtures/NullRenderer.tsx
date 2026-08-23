import { useEffect, useRef } from "react";

/**
 * A component with no JSX at all: it exists for its effect and renders nothing.
 * The `return;` inside the effect callback must not count as one of the
 * component's own returns.
 */
export function NullRenderer({ userId }: { userId: string }) {
  const seeded = useRef(false);

  useEffect(() => {
    if (seeded.current) return;
    seeded.current = true;
    console.log(userId);
  }, [userId]);

  return null;
}
