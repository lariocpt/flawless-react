import * as React from "react";

interface LabelledButtonProps extends React.ComponentProps<"button"> {
  label: string;
  size?: "sm" | "lg";
  /** Narrows the host's `type` union — an own member that really conflicts. */
  type?: "submit";
}

export function LabelledButton({ label, size, ...props }: LabelledButtonProps) {
  return (
    <button data-size={size} {...props}>
      {label}
    </button>
  );
}
