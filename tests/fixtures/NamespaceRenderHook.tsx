// @ts-nocheck — @base-ui is not a dependency of this repo; the fixture only
// needs the import syntax, which parseFile reads without resolving.
import * as UR from "@base-ui/react/use-render";

/**
 * Namespace-import spelling of the useRender pattern: the hook is reached as
 * UR.useRender, so no bare identifier ties the call to the import.
 */
function NamespaceBadge({ render, ...props }: UR.useRender.ComponentProps<"span">) {
  return UR.useRender({
    defaultTagName: "span",
    props,
    render,
  });
}

export { NamespaceBadge };
