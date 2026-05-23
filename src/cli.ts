import path from "node:path";
import { analyse } from "./analyse/index.ts";
import { scaffold } from "./scaffold/index.ts";
import type { CliArgs, PropsShape } from "./types.ts";

const HELP = `finish-him-react — static-analysis-driven React profiling/test-suite generator

Usage:
  finish-him-react <entry.tsx> [options]

Options:
  --out <dir>          Output directory (default: <cwd>/<ComponentName>.profile)
  --depth N            Levels of locally-imported children to follow (default 3)
  --variants N         Variant rows in the test matrix (default 5)
  --include-children   Walk children (default true). Pass --include-children=false to skip.
  --props '<json>'     Override the synthesized default props (merged on top of static parse)
  --provider <file>    Path to a .tsx file that default-exports a Provider wrapper component.
                       The host will wrap every mounted component inside it — use this for
                       Redux, React Query, theming, or any other context-based stores.
  --api <spec>         Path to an OpenAPI/Swagger JSON or YAML file. Scaffolds a standalone
                       Bun mock server (mock/server.ts) with static route handlers generated
                       from the spec's example responses. The host server proxies all
                       non-asset requests to the mock server automatically.
  --force              Overwrite an existing output dir
  --report             Emit scripts/report.mjs to aggregate run output
  -h, --help           Show this help
  -V, --version        Show version
`;

export function parseArgs(argv: string[]): CliArgs {
  let entry: string | undefined;
  let out: string | undefined;
  let depth = 3;
  let variants = 5;
  let includeChildren = true;
  let force = false;
  let report = false;
  let propsOverride: PropsShape | undefined;
  let provider: string | undefined;
  let apiSpec: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === undefined) continue;
    if (a === "--out") {
      const v = argv[++i];
      if (v === undefined) throw new Error("--out requires a value");
      out = v;
    } else if (a.startsWith("--out=")) {
      out = a.slice("--out=".length);
    } else if (a === "--depth") {
      depth = Number(argv[++i] ?? "3");
    } else if (a.startsWith("--depth=")) {
      depth = Number(a.slice("--depth=".length));
    } else if (a === "--variants") {
      variants = Number(argv[++i] ?? "5");
    } else if (a.startsWith("--variants=")) {
      variants = Number(a.slice("--variants=".length));
    } else if (a === "--include-children") {
      includeChildren = true;
    } else if (a.startsWith("--include-children=")) {
      const v = a.slice("--include-children=".length).toLowerCase();
      includeChildren = !(v === "false" || v === "0" || v === "no");
    } else if (a === "--props") {
      const v = argv[++i];
      if (v === undefined) throw new Error("--props requires a JSON value");
      propsOverride = JSON.parse(v) as PropsShape;
    } else if (a.startsWith("--props=")) {
      propsOverride = JSON.parse(a.slice("--props=".length)) as PropsShape;
    } else if (a === "--provider") {
      const v = argv[++i];
      if (v === undefined) throw new Error("--provider requires a file path");
      provider = v;
    } else if (a.startsWith("--provider=")) {
      provider = a.slice("--provider=".length);
    } else if (a === "--api") {
      const v = argv[++i];
      if (v === undefined) throw new Error("--api requires a file path");
      apiSpec = v;
    } else if (a.startsWith("--api=")) {
      apiSpec = a.slice("--api=".length);
    } else if (a === "--force") {
      force = true;
    } else if (a === "--report") {
      report = true;
    } else if (a === "-h" || a === "--help") {
      process.stdout.write(HELP);
      process.exit(0);
    } else if (a === "-V" || a === "--version") {
      process.stdout.write("finish-him-react 0.1.0-dev\n");
      process.exit(0);
    } else if (a.startsWith("--")) {
      throw new Error(`unknown flag: ${a}`);
    } else if (entry === undefined) {
      entry = a;
    } else {
      throw new Error(`unexpected positional: ${a}`);
    }
  }

  if (entry === undefined) {
    throw new Error("missing required entry .tsx path. See --help.");
  }
  if (!Number.isFinite(depth) || depth < 0) throw new Error(`--depth must be >= 0`);
  if (!Number.isFinite(variants) || variants < 0) throw new Error(`--variants must be >= 0`);

  return {
    entry,
    out,
    depth,
    variants,
    includeChildren,
    force,
    report,
    propsOverride,
    provider,
    apiSpec,
  };
}

function defaultOutDir(entry: string, componentName: string): string {
  const cwd = process.cwd();
  void entry;
  return path.join(cwd, `${componentName}.profile`);
}

export async function main(argv: string[]): Promise<void> {
  let args: CliArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    process.exit(2);
  }

  const tree = await analyse({
    entry: args.entry,
    depth: args.depth,
    includeChildren: args.includeChildren,
  });

  if (args.propsOverride) {
    tree.entry.propsShape = { ...tree.entry.propsShape, ...args.propsOverride };
  }

  if (tree.entry.unresolvedProps.length > 0 && !args.propsOverride) {
    process.stderr.write(
      `warning: could not synthesize defaults for props: ${tree.entry.unresolvedProps.join(", ")}\n` +
        `  edit the generated tests' DEFAULTS constant, or re-run with --props '<json>'.\n`,
    );
  }

  const outDir = args.out ?? defaultOutDir(args.entry, tree.entry.componentName);

  const written = await scaffold(tree, {
    outDir,
    variants: args.variants,
    force: args.force,
    report: args.report,
    provider: args.provider,
    apiSpec: args.apiSpec,
  });

  const summary = {
    outDir,
    componentName: tree.entry.componentName,
    children: tree.children.map((c) => c.entry.componentName),
    hooks: tree.entry.hooks,
    props: tree.entry.propsShape,
    filesWritten: written.length,
    nextSteps: [`cd ${outDir}`, "bun install", "bun run test"],
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}
