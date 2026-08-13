import * as React from "react";

export function SearchInput({
  type,
  ...props
}: React.ComponentProps<"input"> & { type?: "search" }) {
  return <input data-slot="search-input" type={type} {...props} />;
}
