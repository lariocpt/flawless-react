// @ts-nocheck — "@/lib/my-types" does not exist. That is the point: a
// project-local `ComponentProps` must not be mistaken for React's.
import type { ComponentProps } from "@/lib/my-types";

export function FakeCard({ className, ...props }: ComponentProps<"button">) {
  return <button data-slot="fake-card" className={className} {...props} />;
}
