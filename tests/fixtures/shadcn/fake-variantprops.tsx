// @ts-nocheck — "@/lib/types" does not exist and cva is not installed. The cva
// call below is genuine; only `VariantProps` comes from somewhere else, so the
// analyser must refuse the whole type even though the table is right there.
import { cva } from "class-variance-authority";
import type { VariantProps } from "@/lib/types";

const toastVariants = cva("pointer-events-auto flex w-full", {
  variants: {
    tone: {
      info: "bg-background text-foreground",
      error: "bg-destructive text-destructive-foreground",
    },
  },
  defaultVariants: {
    tone: "info",
  },
});

export function Toast({ tone, ...props }: VariantProps<typeof toastVariants>) {
  return <div data-slot="toast" className={toastVariants({ tone })} {...props} />;
}
