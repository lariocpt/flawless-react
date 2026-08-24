// @ts-nocheck — @base-ui is not a dependency of this repo; the fixture only
// needs the import syntax, which parseFile reads without resolving.
import { useRender } from "@base-ui/react/use-render";

/**
 * The render-hook call sits inside a ternary rather than directly under
 * `return`: one branch comes out of the hook, the other renders nothing.
 */
function TernaryBadge({
  visible,
  render,
  ...props
}: useRender.ComponentProps<"span"> & { visible?: boolean }) {
  return visible ? useRender({ defaultTagName: "span", props, render }) : null;
}

export { TernaryBadge };
