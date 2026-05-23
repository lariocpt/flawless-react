import type * as React from "react";

interface Props {
  title: string;
  href: string;
  onOpen: () => void;
}

export const LinkCard: React.FC<Props> = ({ title, href, onOpen }) => {
  return (
    <a href={href} onClick={onOpen}>
      {title}
    </a>
  );
};

export default LinkCard;
