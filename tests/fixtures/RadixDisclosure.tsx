import * as React from "react";
import * as ToastPrimitive from "@radix-ui/react-toast";

/**
 * The shadcn `Toast` shape invoify tripped the browser smoke on: the wrapper's
 * whole output is a Radix primitive that owns open state, and Radix hands back
 * NOTHING until something opens it. The mount is clean; the container is empty.
 */
export function ClosedToast(props: { children?: React.ReactNode }) {
  return (
    <ToastPrimitive.Root>
      <ToastPrimitive.Description>{props.children}</ToastPrimitive.Description>
    </ToastPrimitive.Root>
  );
}
