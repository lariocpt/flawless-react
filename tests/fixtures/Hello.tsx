import type { FC } from "react";
import { useState } from "react";

interface HelloProps {
  name: string;
  count: number;
  active: boolean;
  variant: "primary" | "secondary";
}

export const Hello: FC<HelloProps> = ({ name, count, active, variant }) => {
  const [clicks, setClicks] = useState(0);
  return (
    <div data-variant={variant} data-active={active}>
      <span>{name}</span>
      <span>{count}</span>
      <span>{clicks}</span>
      <button type="button" onClick={() => setClicks((c) => c + 1)}>
        bump
      </button>
    </div>
  );
};
