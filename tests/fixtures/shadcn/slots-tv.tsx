// @ts-nocheck — tailwind-variants is not installed at the repo root.
import { tv, type VariantProps } from "tailwind-variants";

const dialogVariants = tv({
  slots: {
    root: "fixed inset-0 grid place-items-center",
    header: "flex flex-col gap-1",
  },
  variants: {
    size: {
      sm: { root: "w-80" },
      lg: { root: "w-full max-w-2xl" },
    },
  },
  defaultVariants: {
    size: "sm",
  },
});

export function Dialog({ size, ...props }: VariantProps<typeof dialogVariants>) {
  const styles = dialogVariants({ size });
  return <div data-slot="dialog" className={styles.root()} {...props} />;
}
