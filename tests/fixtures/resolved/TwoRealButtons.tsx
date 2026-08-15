import type * as React from "react";
import { RealButton } from "./RealButton.tsx";

/** VoteCard's shape: a mapped <button> beside a wrapper that renders one too. */
export const TwoRealButtons: React.FC<{ rows: string[] }> = ({ rows }) => (
  <div>
    {rows.map((r) => (
      <button key={r} type="button" onClick={() => undefined} />
    ))}
    <RealButton>Cast vote</RealButton>
  </div>
);

export default TwoRealButtons;
