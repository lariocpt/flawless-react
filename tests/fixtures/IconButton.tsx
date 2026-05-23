import type * as React from "react";

interface Props {
  onClose: () => void;
}

export const IconButton: React.FC<Props> = ({ onClose }) => {
  return (
    <button type="button" aria-label="close" onClick={() => onClose()}>
      <span>×</span>
    </button>
  );
};

export default IconButton;
