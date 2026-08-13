import type { FC } from "react";
import { useEffect, useReducer, useRef, useState } from "react";

interface StatefulPanelProps {
  title: string;
}

type PanelAction = { type: "toggle" };

function panelReducer(state: boolean, _action: PanelAction): boolean {
  return !state;
}

const List: FC<{ items: string[] }> = ({ items }) => (
  <ul>
    {items.map((item) => (
      <li key={item}>{item}</li>
    ))}
  </ul>
);

export function StatefulPanel({ title }: StatefulPanelProps) {
  const [count, setCount] = useState(0);
  const [items, setItems] = useState<string[]>([]);
  const [expanded, dispatch] = useReducer(panelReducer, false);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    timerRef.current = window.setInterval(() => setCount((c) => c + 1), 1000);
    return () => {
      if (timerRef.current !== null) window.clearInterval(timerRef.current);
    };
  }, []);

  const handleAdd = () => {
    setItems([...items, `item-${items.length}`]);
  };

  if (count < 0) {
    setCount(0);
  }

  return (
    <section>
      <header>{title}</header>
      <span>{count}</span>
      <button type="button" onClick={handleAdd}>
        Add item
      </button>
      <button type="button" onClick={() => dispatch({ type: "toggle" })}>
        Toggle
      </button>
      {expanded ? <List items={items} /> : null}
    </section>
  );
}
