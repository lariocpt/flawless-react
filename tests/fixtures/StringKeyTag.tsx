interface StringKeyProps {
  "data-variant": string;
  label: string;
}

export function StringKeyTag(props: StringKeyProps) {
  return <span data-variant={props["data-variant"]}>{props.label}</span>;
}
