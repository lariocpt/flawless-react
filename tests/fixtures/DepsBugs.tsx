import type { FC } from "react";
import { useEffect, useMemo, useState } from "react";

interface DepsBugsProps {
  userId: string;
  limit: number;
}

export const DepsBugs: FC<DepsBugsProps> = ({ userId, limit }) => {
  const [rows, setRows] = useState<string[]>([]);

  useEffect(() => {
    fetch(`/api/users/${userId}/rows`)
      .then((r) => r.json())
      .then((data: string[]) => setRows(data));
  }, []);

  const visible = useMemo(() => rows.slice(0, 5), [rows, limit]);

  return (
    <ul>
      {visible.map((row) => (
        <li key={row}>{row}</li>
      ))}
    </ul>
  );
};
