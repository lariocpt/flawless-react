import { useEffect } from "react";

/**
 * The object literal sits directly in the component body, so its get
 * accessor's `return label;` lives inside the body's subtree. That return
 * belongs to the accessor, not the component, and must not defeat the
 * all-returns-null detection.
 */
export function GetterEffect({ label }: { label: string }) {
  const snapshot = {
    get title() {
      return label;
    },
  };

  useEffect(() => {
    console.log(snapshot.title);
  }, [snapshot]);

  return null;
}
