import type React from "react";
import { useEffect } from "react";

type User = { name: string };

interface Props {
  title: string;
  user: User;
  onSave: () => void;
  filter: string;
}

const Avatar: React.FC<{ name: string }> = ({ name }) => <span>{name}</span>;

export const UsageDemo: React.FC<Props> = ({ title, user, onSave, filter }) => {
  useEffect(() => {
    console.debug("filter changed");
  }, [filter]);

  if (filter) {
    return <p>filtering</p>;
  }

  return (
    <div>
      <h1>{title}</h1>
      <Avatar name={user.name} />
      <button type="button" onClick={onSave}>
        Save
      </button>
    </div>
  );
};
