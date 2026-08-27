// The CLI's flag inventory, as data.
//
// This list used to exist twice: as prose inside cli.ts's HELP literal, and as
// the if-chain in parseArgs. Two copies of the same list is the defect class
// this project keeps finding in its own docs — and the website's CLI reference
// had already drifted from it, documenting 25 flags while --roots, --exclude
// and --no-default-excludes went unmentioned for a whole release.
//
// So: one table. HELP renders from it, `--flags` prints it for consumers that
// cannot import it (the website repo lints its own reference page by running
// the published binary), and tests/docsLint.test.ts checks the shipped prose
// against it. parseArgs keeps its own if-chain — this is an INVENTORY, not a
// second parser, and its `unknown flag` branch is still the runtime guard. The
// two are held together by a test that fails when a flag is added to one and
// not the other.
//
// Kept free of every other import: --help and --flags must answer without
// paying for the TypeScript compiler that core.ts drags in (FR-031).

export interface FlagDoc {
  /** The long form, e.g. "--tasks". */
  name: string;
  /** The short form, e.g. "-h". */
  alias?: string;
  /** The value placeholder as help renders it; absent means a boolean flag. */
  value?: string;
  /** Help text — an array is rendered as continuation lines. */
  summary: string | string[];
}

export const FLAGS: readonly FlagDoc[] = [
  {
    name: "--out",
    value: "<dir>",
    summary: "Output directory (default: ./.flawless)",
  },
  {
    name: "--tasks",
    value: "<csv>",
    summary: [
      "Comma-separated task ids to run (skip the interactive menu).",
      "Available: perf-harness, unit-browser, perf-static, a11y,",
      "react-rules, e2e, load",
    ],
  },
  {
    name: "--roots",
    value: "<mode>",
    summary: [
      "primary (default) analyses each file's main component;",
      "exported emits a tree per exported component, which is what a",
      "whole-app sweep needs (a shadcn card.tsx exports 7 of them).",
    ],
  },
  {
    name: "--exclude",
    value: "<glob>",
    summary: [
      "Skip matching files (repeatable). Appended to the defaults,",
      "which already skip *.flawless.test.*, *.test.*, *.spec.*,",
      "*.stories.*, *.d.ts, node_modules, .next, dist, build,",
      "coverage, flawless/. A non-default --out is NOT excluded.",
    ],
  },
  {
    name: "--no-default-excludes",
    summary: "Drop those defaults (then a glob can match generated specs).",
  },
  {
    name: "--colocate",
    summary: [
      "Emit unit specs beside the analysed sources as",
      "<name>.flawless.test.tsx (existing colocated specs are kept",
      "unless --force). The flawless/ dir keeps config + mocks.",
    ],
  },
  {
    name: "--ci",
    summary: "Shorthand for --no-interactive --json.",
  },
  {
    name: "--no-interactive",
    summary: [
      "Never prompt; require a positional (or --nextjs). Without",
      "--tasks the run does perf-harness alone.",
    ],
  },
  {
    name: "--run-tests",
    summary: "After generating, run the produced test suites.",
  },
  {
    name: "--no-inline-summary",
    summary: "Don't drop <Component>.flawless.json next to each source file.",
  },
  {
    name: "--json",
    summary: "Print machine-readable JSON summary to stdout.",
  },
  {
    name: "--nextjs",
    value: "[<path>]",
    summary: [
      "Treat <path> (or cwd) as a Next.js project: detect router style,",
      "emit MSW handlers + swagger from app/api or pages/api, auto-set the",
      "app resolver from app/layout.tsx or pages/_app.tsx, merge generated",
      "deps into the project's package.json (devDependencies) and place",
      "everything under <nextRoot>/flawless/.",
    ],
  },
  {
    name: "--expo",
    value: "[<path>]",
    summary: [
      "Treat <path> (or cwd) as an Expo project: read its SDK major,",
      "expo-router root, React Compiler and NativeWind settings, and",
      "place everything under <expoRoot>/flawless/. Mutually exclusive",
      "with --nextjs.",
    ],
  },
  {
    name: "--app-resolver",
    value: "<file>",
    summary: [
      "Override the auto-detected Next.js app resolver (alias for --provider",
      "in Next.js mode; the file must default-export a wrapper component).",
    ],
  },
  {
    name: "--swagger-url",
    value: "<url>",
    summary: [
      "Fetch an OpenAPI spec from a live URL (e.g.",
      "http://localhost:3000/api/docs from next-swagger-doc) and prefer it",
      "over static AST inference. In --nextjs mode the default URL above is",
      "tried automatically with a short timeout; pass --swagger-url to",
      "force a specific URL or skip the auto-try via --swagger-url=off.",
    ],
  },
  {
    name: "--depth",
    value: "N",
    summary: "Levels of locally-imported children to follow (default 3)",
  },
  {
    name: "--variants",
    value: "N",
    summary: "Variant rows per component (default 5)",
  },
  {
    name: "--changed",
    value: "[REF]",
    summary: [
      "After generating, run only the specs affected by files",
      "changed since REF (default HEAD) — including e2e routes",
      "whose page renders a changed component",
    ],
  },
  {
    name: "--heaps",
    value: "MODE",
    summary: [
      "V8 heap snapshots in the profile suite:",
      "off | stress (default) | all. A snapshot is tens of MB",
      "and one is taken either side of every scenario",
    ],
  },
  {
    name: "--include-children",
    summary: "Walk children (default true). Pass --include-children=false to skip.",
  },
  {
    name: "--props",
    value: "'<json>'",
    summary: "Override the synthesised default props for the first entry.",
  },
  {
    name: "--provider",
    value: "<file>",
    summary: "Path to a .tsx file default-exporting a Provider wrapper.",
  },
  {
    name: "--api",
    value: "<spec>",
    summary: "Path to an OpenAPI/Swagger spec; scaffolds a mock server.",
  },
  {
    name: "--force",
    summary: [
      "Also regenerate what a re-run keeps: colocated specs,",
      "e2e route specs, the derived provider wrapper.",
      "(A plain re-run already refreshes the out-dir harness.)",
    ],
  },
  {
    name: "--report",
    summary: "Emit scripts/report.mjs to aggregate run output.",
  },
  {
    name: "--help",
    alias: "-h",
    summary: "Show this help.",
  },
  {
    name: "--version",
    alias: "-V",
    summary: "Show version.",
  },
];

/** Every long flag name, for coverage checks and `--flags`. */
export const FLAG_NAMES: readonly string[] = FLAGS.map((f) => f.name);

/**
 * The parse-only surfaces, kept OUT of FLAGS on purpose.
 *
 * They are real and public — the website's CI is built on them — but they are
 * not run options: main() answers them before parseArgs is ever called, so
 * parseArgs rejects them like any other unknown flag, and listing them among
 * the options would put them in the round-trip that proves every FLAGS entry
 * parses. Documented in their own block instead, because a public surface CI
 * depends on should not be undiscoverable.
 */
export const MAINTENANCE_FLAGS: readonly FlagDoc[] = [
  {
    name: "--check",
    value: "'<line>'",
    summary: [
      "Parse documented invocations without running them, and exit",
      "nonzero if any fails. Opens no file and spawns nothing.",
    ],
  },
  {
    name: "--flags",
    summary: "Print the flag inventory above, one per line.",
  },
];

/** `--out <dir>`, `-h, --help` — the left column, as help prints it. */
export function flagLabel(f: FlagDoc): string {
  const long = f.value === undefined ? f.name : `${f.name} ${f.value}`;
  return f.alias === undefined ? long : `${f.alias}, ${long}`;
}

// The description column. Every continuation line in the block aligns here too,
// which is what lets the whole Options section render from the table.
const DESC_COL = 25;

const PRELUDE = `flawless-react — multi-task quality kit for React components

Usage:
  flawless-react <entry-or-glob> [options]
  flawless-react                       (interactive menu)

Positional:
  <entry-or-glob>      A .tsx file path or a glob (e.g. "src/**/*.tsx").
                       Each matched file is analysed as its own entry component.

Options:
`;

function renderBlock(flags: readonly FlagDoc[]): string {
  let out = "";
  for (const f of flags) {
    const lines = typeof f.summary === "string" ? [f.summary] : f.summary;
    out += `  ${flagLabel(f).padEnd(DESC_COL - 2)}${lines[0]}\n`;
    for (const cont of lines.slice(1)) out += `${" ".repeat(DESC_COL)}${cont}\n`;
  }
  return out;
}

/** The `--help` text. The Options block is byte-for-byte what the
 *  hand-maintained literal produced; the Maintenance block is new. */
export function renderHelp(): string {
  return `${PRELUDE}${renderBlock(FLAGS)}
Maintenance (parse-only — these never analyse, generate or run anything):
${renderBlock(MAINTENANCE_FLAGS)}`;
}
