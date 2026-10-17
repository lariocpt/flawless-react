// bun-types declares `*.txt`, `*.toml`, `*.yaml`, `*.json5` … but not `*.md`, so
// the `with { type: "text" }` imports in data.ts — which embed the agent skills
// into the compiled binary — would have no type.
declare module "*.md" {
  const content: string;
  export default content;
}
