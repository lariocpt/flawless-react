import * as ToastPrimitive from "@radix-ui/react-toast";

/**
 * The same library, mounted open, with a literal string of its own. The copy is
 * unconditional in the source, so an empty container from this component IS a
 * failure: its floor stays a plain assertion, with no stand-down available.
 */
export function ToastBanner() {
  return (
    <ToastPrimitive.Root open>
      <span>Invoice saved</span>
    </ToastPrimitive.Root>
  );
}
