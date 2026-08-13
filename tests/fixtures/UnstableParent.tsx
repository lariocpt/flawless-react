import type { FC, ReactNode } from "react";
import { useState } from "react";
import { StableLeaf } from "./StableLeaf.tsx";

interface CardProps {
  style?: { margin: number };
  onPick?: (n: number) => void;
  items?: number[];
  title?: string;
  user?: string;
  render?: ReactNode;
  count?: number;
  enabled?: boolean;
  variant?: string;
}

const Card: FC<CardProps> = ({ title }) => <section>{title}</section>;

interface UnstableParentProps {
  title: string;
  count: number;
  variant?: string;
}

export const UnstableParent: FC<UnstableParentProps> = ({ title, count, ...rest }) => {
  const [x, setX] = useState(0);
  const user = { name: "u" };
  return (
    <div className="wrap">
      <button type="button" onClick={() => setX(x + 1)}>
        bump
      </button>
      <Card
        style={{ margin: 1 }}
        onPick={() => setX(1)}
        items={[1, 2]}
        title={title}
        user={user.name}
        render={<b>hi</b>}
        count={3}
        enabled
      />
      <Card variant="plain" {...rest} />
      <StableLeaf title={title} count={count} />
    </div>
  );
};
