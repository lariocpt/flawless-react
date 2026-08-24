import type { FC } from "react";

interface TagProps {
  label: string;
  count: number;
}

// The props type lives ONLY in the satisfies target: the parameter is
// contextually typed, so detection must read the FC type argument.
export const SatisfiesTag = ((props) => (
  <span data-count={props.count}>{props.label}</span>
)) satisfies FC<TagProps>;
