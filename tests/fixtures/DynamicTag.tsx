import type * as React from "react";

interface Props {
  as: keyof JSX.IntrinsicElements;
  onPress: () => void;
}

export const DynamicTag: React.FC<Props> = ({ as, onPress }) => {
  const Tag = as as unknown as React.ElementType;
  return <Tag onClick={onPress}>tap</Tag>;
};

export default DynamicTag;
