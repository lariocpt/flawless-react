import * as React from "react";
import * as SlotPrimitive from "@radix-ui/react-slot";

/**
 * Radix, but the EAGER half of it: a Slot renders its child (or a span), so an
 * empty container from this component is a broken render, not a closed
 * disclosure. Its floor stays a plain unconditional assertion.
 */
export function SlotButton(props: { children?: React.ReactNode }) {
  return <SlotPrimitive.Root asChild={false}>{props.children}</SlotPrimitive.Root>;
}
