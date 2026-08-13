interface NoStaticTextProps {
  label: string;
}

export function NoStaticText({ label }: NoStaticTextProps) {
  const body = <p>Hidden copy</p>;
  const node = label.length > 0 ? body : null;
  return node;
}
