import { useEffect } from "react";

/**
 * The only return is `(null)` — the raw AST node is a ParenthesizedExpression,
 * not a NullKeyword, so detection must see through trivial wrappers.
 */
export function ParenNull({ flag }: { flag: boolean }) {
  useEffect(() => {
    console.log(flag);
  }, [flag]);

  return (null);
}
