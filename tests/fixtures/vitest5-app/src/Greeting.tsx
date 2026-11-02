import { label } from "./label";

export function Greeting({ name }: { name: string }) {
  return <h1>{label(name)}</h1>;
}
