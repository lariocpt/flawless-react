import { useState } from "react";

function Internal() {
  const [n] = useState(0);
  return <div>{n}</div>;
}

export { Internal as Public };
