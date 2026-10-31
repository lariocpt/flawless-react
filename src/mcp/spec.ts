// The `flawless-react mcp` subcommand's grammar and help, in one importless
// module — the same reason `skills/spec.ts` and `docLine.ts` exist.
//
// main() dispatches on it, and `--check` has to parse the `flawless-react mcp`
// lines in the README, the skills and the website, or a renamed subcommand
// survives in documentation. Without this file that line would fall through to
// parseArgs, read `mcp` as an entry glob, and PASS FOR THE WRONG REASON — the
// failure mode skills/spec.ts exists to prevent. And `--help`/`--check` must
// answer without importing core.ts and the TypeScript compiler behind it
// (FR-031), so the server's own module cannot be the source of its help text.
//
// The tool names below are prose here, not a second registry: tests/mcp.test.ts
// asserts this text and ALL_TOOLS name the same set, so the drift is a red test
// rather than a stale help screen.

export const MCP_SUBCOMMAND = "mcp";

/** True when argv is an MCP-server invocation rather than a generation run. */
export function isMcpArgv(argv: readonly string[]): boolean {
  return argv[0] === MCP_SUBCOMMAND;
}

export interface McpCommand {
  /** "serve" speaks the protocol on stdio; "help" prints the help and exits. */
  verb: "serve" | "help";
}

/**
 * Parse the arguments AFTER the `mcp` word (main() strips the subcommand).
 *
 * It takes no options, and says so rather than ignoring them: a host config
 * carrying a typo'd flag would otherwise start a server that quietly did not
 * honour it. The transport is fixed — stdio, one JSON-RPC 2.0 message per line —
 * because it is the only one an MCP host configures without a plugin.
 */
export function parseMcpCommand(argv: readonly string[]): McpCommand {
  const first = argv[0];
  if (first === undefined) return { verb: "serve" };
  if (first === "help" || first === "-h" || first === "--help") return { verb: "help" };
  throw new Error(
    `'mcp' takes no arguments — it serves JSON-RPC 2.0 on stdin/stdout. Got '${first}'. ` +
      `Run 'flawless-react mcp --help' for the host configuration.`,
  );
}

const USAGE = `flawless-react mcp — Model Context Protocol server over stdio

  Speaks JSON-RPC 2.0, one message per line, on stdin and stdout. There is no
  menu and no prompt: stdin belongs to the protocol, and anything a run prints
  is captured per call so it can never mix with a frame.

  Configure it in an MCP host (OpenCode, Claude Code, Codex, Cursor, ...):

    { "mcpServers": { "flawless-react": { "command": "flawless-react", "args": ["mcp"] } } }

  tools/list returns eight tools:

    flawless_run             generate or refresh a suite (every CLI option), returning
                             the --ci JSON blob and the child's exit code
    flawless_skills          the embedded agent skills: status, or install
    flawless_tasks           the task registry — ids, what each does, which run under --expo
    flawless_reference       flag inventory, task ids, skill names, version
    flawless_analyse         a component's analysed facts — props, hooks, state, guards,
                             unresolved types — writing nothing
    flawless_findings        the static perf and correctness rules over a file or glob,
                             as file:line findings, writing nothing
    flawless_project_status  Next.js / Expo detection plus what suite already exists
    flawless_check_docs      parse documented flawless-react invocations, the way this
                             repo's own docs lint does

  Two planes, and the difference shows up in what a call costs. The run plane
  spawns a flawless-react CHILD per call: the CLI's real exit codes, a killable
  process group, per-call cwd and env, nothing kept between calls. The read plane
  runs in this process, opens no other tool, spawns nothing and writes no files.

  A nonzero exit is ALWAYS an isError result carrying the child's own output, and
  every cap is announced. This tool does not report a false pass, over MCP included.

Options:
  -h, --help   Show this help instead of serving.
`;

/** The `mcp --help` text. */
export function renderMcpHelp(): string {
  return USAGE;
}
