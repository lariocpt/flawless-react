// P7 — D1 item 6: a variant prop with EIGHT literal options against the
// emitter's five-variant cap. The spec exercises the five-option prefix; the
// three the cap cuts are named in the spec (test.skip "not-analysed") and in
// the report, not dropped silently.
type P7CappedVariantsProps = {
  size: "xs" | "sm" | "md" | "lg" | "xl" | "2xl" | "3xl" | "4xl";
};

// A value table, not cva: the component maps each option to its class through
// a lookup, so no variantClasses reach the emitter and the matrix is the
// component's whole observable surface.
const SIZES: Record<string, string> = {
  xs: "chip chip-xs",
  sm: "chip chip-sm",
  md: "chip chip-md",
  lg: "chip chip-lg",
  xl: "chip chip-xl",
  "2xl": "chip chip-2xl",
  "3xl": "chip chip-3xl",
  "4xl": "chip chip-4xl",
};

// The option-space validation lives at module scope, deliberately NOT in the
// component body: a throw guard in the body flags the render guarded, which
// demotes the variant matrix to mount-only asserts — and the cap story needs
// the root-tag matrix, the shape that also goes red when this throws. A
// union-literal rename carries no runtime of its own; the table is what makes
// the rename falsifiable.
function requireSize(size: string): string {
  const cls = SIZES[size];
  if (cls === undefined) throw new Error(`unknown size: ${size}`);
  return cls;
}

export function P7CappedVariants({ size }: P7CappedVariantsProps) {
  // A local named `className` would trip the className-flow detector, which
  // keys on the identifier `className` inside the JSX initializer; the
  // component does not forward a className prop.
  const cls = requireSize(size);
  return <span className={cls}>{size}</span>;
}
