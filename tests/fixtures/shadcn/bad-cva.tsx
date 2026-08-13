// @ts-nocheck — class-variance-authority is not installed at the repo root.
import { cva, type VariantProps } from "class-variance-authority";

const CHIP_CONFIG = {
  variants: {
    tone: { neutral: "bg-muted", danger: "bg-destructive" },
  },
  defaultVariants: { tone: "neutral" },
};

const chipVariants = cva("inline-flex rounded px-1", CHIP_CONFIG);

export function Chip({ tone, ...props }: VariantProps<typeof chipVariants>) {
  return <span data-slot="chip" className={chipVariants({ tone })} {...props} />;
}
