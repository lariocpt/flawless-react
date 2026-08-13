import * as React from "react";

export function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return <input data-slot="input" type={type} className={className} {...props} />;
}
