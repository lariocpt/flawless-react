// @ts-nocheck — class-variance-authority is not installed at the repo root.
import { cva as classes, type VariantProps } from "class-variance-authority";

const badgeVariants = classes("inline-flex items-center border px-2", {
  variants: {
    tone: {
      neutral: "bg-muted text-foreground",
      danger: "bg-destructive text-destructive-foreground",
    },
    pill: {
      true: "rounded-full",
      false: "rounded-md",
    },
  },
  defaultVariants: {
    tone: "neutral",
    pill: false,
  },
});

export function Badge({ tone, pill, ...props }: VariantProps<typeof badgeVariants>) {
  return <span data-slot="badge" className={badgeVariants({ tone, pill })} {...props} />;
}
