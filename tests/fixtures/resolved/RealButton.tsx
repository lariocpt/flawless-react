import type * as React from "react";

/** The ordinary case: a wrapper that really does render a <button>. */
export const RealButton: React.FC<React.ComponentProps<"button">> = (props) => (
  <button type="button" {...props} />
);

export default RealButton;
