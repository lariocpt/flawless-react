// @ts-nocheck — class-variance-authority is not installed at the repo root.
import { cva, type VariantProps } from "class-variance-authority";

const SHARED_TONES = { info: "text-blue-600", warn: "text-amber-600" };

const alertVariants = cva("relative w-full rounded-lg border", {
  variants: {
    // Spread options: the full set is not knowable from this file alone.
    tone: { ...SHARED_TONES, error: "text-red-600" },
    density: {
      comfy: "p-4",
      tight: "p-2",
    },
  },
  defaultVariants: {
    tone: "info",
    density: "comfy",
  },
});

export function Alert({ tone, density, ...props }: VariantProps<typeof alertVariants>) {
  return <div data-slot="alert" className={alertVariants({ tone, density })} {...props} />;
}
