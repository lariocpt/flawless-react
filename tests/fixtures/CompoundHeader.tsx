// @ts-nocheck — @radix-ui/react-dialog resolves through the stub package the
// emitted-types sweep writes, not through the repo root tsconfig.
import * as DialogPrimitive from "@radix-ui/react-dialog";
import type * as React from "react";

// A shadcn-style compound family in one file: primary is the PART (the file
// is named after it), so both emitted-artefact sweeps exercise the wrapped
// branches — compoundPartSpec in the unit suite and the composed
// COMPOUND_WRAP registry entry in the host.

export function Dialog(props: Record<string, unknown>) {
  return <DialogPrimitive.Root {...props} />;
}

export function DialogContent({ children }: { children?: React.ReactNode }) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay />
      <DialogPrimitive.Content>{children}</DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

export function CompoundHeader({ children }: { children?: React.ReactNode }) {
  return <DialogPrimitive.Title>{children}</DialogPrimitive.Title>;
}
