import type { FC } from "react";
import { useState } from "react";

interface SetInRenderProps {
  x: boolean;
}

export const SetInRender: FC<SetInRenderProps> = ({ x }) => {
  const [count, setCount] = useState(0);
  const [flag, setFlag] = useState(false);

  setCount(1);

  if (x) {
    setFlag(true);
  }

  return <p>{count > 0 && flag ? "on" : "off"}</p>;
};
