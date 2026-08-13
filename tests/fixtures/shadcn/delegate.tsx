import * as React from "react";
import { Card } from "./card.tsx";

export function Panel(props: React.ComponentProps<typeof Card>) {
  return <Card {...props} />;
}
