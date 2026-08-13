interface EarlyReturnProps {
  greeting: string | undefined;
}

export function EarlyReturn({ greeting }: EarlyReturnProps) {
  if (!greeting) return null;
  return <p>Hi there</p>;
}
