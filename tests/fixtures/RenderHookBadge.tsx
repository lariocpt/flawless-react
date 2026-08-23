// @ts-nocheck — @base-ui is not a dependency of this repo; the fixture only
// needs the import syntax, which parseFile reads without resolving.
import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";

/**
 * base-ui's useRender pattern (what shadcn's base-ui port emits): the element
 * comes out of a hook call, so the body contains no JSX.
 */
function RenderHookBadge({
  className,
  render,
  ...props
}: useRender.ComponentProps<"span"> & { tone?: "default" | "subtle" }) {
  return useRender({
    defaultTagName: "span",
    props: mergeProps<"span">({ className }, props),
    render,
  });
}

export { RenderHookBadge };
