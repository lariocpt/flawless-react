import type { FC } from "react";
import { useEffect, useState } from "react";

interface CardProps {
  title: string;
  body: string;
}

export const Card: FC<CardProps> = ({ title, body }) => {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    // simulate side-effect
  }, [open]);
  return (
    <article>
      <header>{title}</header>
      {open ? <p>{body}</p> : null}
      <button type="button" onClick={() => setOpen((v) => !v)}>
        toggle
      </button>
    </article>
  );
};
