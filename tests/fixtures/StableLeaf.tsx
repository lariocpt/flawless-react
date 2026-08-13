import type { FC } from "react";

interface StableLeafProps {
  title: string;
  count: number;
}

export const StableLeaf: FC<StableLeafProps> = ({ title, count }) => (
  <p>
    {title}: {count}
  </p>
);
