// P7 — D1 item 6 (not yet shipped): a variant prop with EIGHT literal options
// against the emitter's five-variant cap. The spec exercises a silent prefix
// of the options; the three it never sees appear nowhere in the emitted spec.
type P7CappedVariantsProps = {
  size: "xs" | "sm" | "md" | "lg" | "xl" | "2xl" | "3xl" | "4xl";
};

export function P7CappedVariants({ size }: P7CappedVariantsProps) {
  // A local named `className` would trip the className-flow detector, which
  // keys on the identifier `className` inside the JSX initializer; the
  // component does not forward a className prop.
  const cls = `chip chip-${size}`;
  return <span className={cls}>{size}</span>;
}
