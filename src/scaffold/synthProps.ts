import type { PropsShape } from "../types.ts";

export function mergePropsOverride(base: PropsShape, override: PropsShape | undefined): PropsShape {
  if (!override) return base;
  return { ...base, ...override };
}

export function jsonLiteral(value: unknown, indent = 2): string {
  return JSON.stringify(value, null, indent);
}
