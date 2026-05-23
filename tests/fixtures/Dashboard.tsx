import type { FC } from "react";
import { useMemo } from "react";
import { Card } from "./Card.tsx";
import { Hello } from "./Hello.tsx";

interface DashboardProps {
  title: string;
  count: number;
}

export const Dashboard: FC<DashboardProps> = ({ title, count }) => {
  const items = useMemo(() => Array.from({ length: count }, (_, i) => i), [count]);
  return (
    <main>
      <h1>{title}</h1>
      <Hello name="alice" count={count} active variant="primary" />
      {items.map((i) => (
        <Card key={i} title={`card ${i}`} body="hi" />
      ))}
    </main>
  );
};
