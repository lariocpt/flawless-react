import type * as React from "react";

/** Named like a button, renders an anchor. The convention would get this wrong. */
export const LinkButton: React.FC<{ href: string; children?: React.ReactNode }> = ({
  href,
  children,
}) => <a href={href}>{children}</a>;

export default LinkButton;
