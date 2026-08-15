import type * as React from "react";
import { LinkButton } from "./LinkButton.tsx";

/**
 * One <button> and one <LinkButton>. Counting by name says two buttons and
 * skips the test; resolving LinkButton says it renders an <a>, so the single
 * <button> is unambiguous and can be driven.
 */
export const OneRealButton: React.FC = () => (
  <div>
    <LinkButton href="/somewhere">Go</LinkButton>
    <button type="button" onClick={() => undefined} />
  </div>
);

export default OneRealButton;
