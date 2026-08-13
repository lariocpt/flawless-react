import type { FC } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";

interface EffectsDemoProps {
  id: string;
  label: string;
  user: { id: string };
}

export const EffectsDemo: FC<EffectsDemoProps> = ({ id, label, user }) => {
  const [data, setData] = useState<string[]>([]);
  const [n, setN] = useState(0);
  // Deliberately missing the `data` dep: reads data.length but only lists [n].
  const total = useMemo(() => n + data.length, [n]);

  useEffect(() => {
    const h = () => setN((v) => v + 1);
    fetch(`/api/items/${id}`)
      .then((res) => res.json())
      .then((items: string[]) => setData(items));
    window.addEventListener("resize", h);
    return () => window.removeEventListener("resize", h);
  }, [id]);

  // @ts-expect-error deps array intentionally omitted for the extractor to flag
  const refresh = useCallback(() => setData([]));

  useEffect(() => {
    setN(user.id.length);
  }, [user.id]);

  return (
    <section>
      <h2>{label}</h2>
      <p>{total}</p>
      <ul>
        {data.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
      <button type="button" onClick={refresh}>
        refresh
      </button>
    </section>
  );
};
