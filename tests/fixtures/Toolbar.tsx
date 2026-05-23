import type * as React from "react";

interface Props {
  onSave: () => void;
  onCancel: () => void;
  onDelete: () => void;
}

export const Toolbar: React.FC<Props> = ({ onSave, onCancel, onDelete }) => {
  return (
    <div>
      <button type="button" onClick={onSave}>Save</button>
      <button type="button" onClick={onCancel}>Cancel</button>
      <button type="button" onClick={onDelete}>Delete</button>
    </div>
  );
};

export default Toolbar;
