# MCP server

`flawless-react mcp` is the same tool with a different front door: it speaks the
[Model Context Protocol](https://modelcontextprotocol.io) over stdio, so a coding
agent can generate a suite, read the analyser's answer and check its own documented
commands without anyone pasting terminal output into a chat.

It is one JSON-RPC 2.0 message per line on stdin and stdout. stdout belongs to the
protocol exclusively — the CLI's own console output is redirected to stderr before
anything is served, and every generation runs in a child process whose output is
captured per call. Nothing a run prints can corrupt a response frame.

```bash
# The server itself. stdin and stdout are the transport; diagnostics go to stderr.
flawless-react mcp
flawless-react mcp --help
```

Configure it in a host that speaks MCP (OpenCode, Claude Code, Codex, Cursor):

```json
{
  "mcpServers": {
    "flawless-react": { "command": "flawless-react", "args": ["mcp"] }
  }
}
```

It takes no options, and says so rather than ignoring them: a host config carrying a
typo'd flag would otherwise start a server that quietly did not honour it.

## Two planes, and why the difference matters

**The run plane spawns a `flawless-react` child per call** (`--ci`, JSON on stdout).
That is not ceremony. The generated suites are executed by a runner that inherits
stdout, so an in-process run would write vitest's own report into the middle of a
JSON-RPC frame. A child also gets its own cwd and env per call, is killable as a
process group at the timeout deadline, and returns the CLI's real exit codes — the
contract every other caller of this tool already depends on. Nothing is held between
calls, so a server that has been up all day cannot leak a suite's state into the next
project.

**The read plane runs in this process**: it opens files, parses TypeScript and
returns data. It spawns nothing and writes nothing, which is the point — an agent
asking "what is this component" should not be able to change it. Read calls run with
the process working directory set to the call's `root` and restored afterwards
(calls are serialized, so this is deterministic); that is what makes a tool answer
match what the same glob typed in that project would produce, default excludes
included.

## Tools

**The run plane — two tools, and these are the ones that write.**

| Tool | Returns | Writes |
| --- | --- | --- |
| `flawless_run` | the child's exit line plus the `--ci` blob: `exitCode`, `outDir`, `results`, `keptScripts`, optional `testRun` and `errors` | the suite, and in framework mode the target's `package.json` scripts |
| `flawless_skills` | `skills list` / `skills install` output | on `install` only: `.agents/skills/<name>/SKILL.md` plus the `.claude/skills` link |

**The read plane — six tools, none of which write anything.**

| Tool | Returns |
| --- | --- |
| `flawless_tasks` | every task id, what it emits, whether it runs under Expo |
| `flawless_reference` | every flag with its value form and summary, task ids, skill names, version |
| `flawless_analyse` | props and where each is used, hooks, state, fetches, render guards, unresolved types, the child tree |
| `flawless_findings` | the static engine's findings as file:line records, plus spec-quality gaps |
| `flawless_project_status` | framework detection, existing suite and reports, expected vs declared scripts, `TODO(flawless)` count, skill status |
| `flawless_check_docs` | `{checked, skipped, problems}` for documented invocations in a text |

Read it from the binary instead of trusting this table:

```bash
flawless-react mcp --help
```

## Arguments worth knowing

- **`root`** (read tools) / **`cwd`** (run tools): every path argument resolves
  against it, so one agent can drive two repositories without the second call
  reading the first one's files.
- **`tasks`**, **`nextjs`**, **`expo`**, **`force`**, **`run_tests`**, **`out`**,
  **`changed`**, **`roots`**, **`heaps`**, **`depth`**, **`props`**: the CLI's own
  options, named the same way. Omit `tasks` and the run does `perf-harness` alone,
  which is the documented non-interactive default.
- **`env`**: extra environment variables for that one call —
  `FLAWLESS_E2E_BASEURL` and `FLAWLESS_E2E_ID` for an e2e run, `LOAD_BASE` and
  `LOAD_AUTH` for a load pipe.
- **`max_entries`** and **`max_findings`** bound the read tools (a glob over an app is
  hundreds of files, each a TypeScript parse). Hitting a cap is reported as
  `entries_skipped` / a `note`, never as a silent cut.
- **Unknown arguments are rejected**, not ignored. A caller that typos `run_tests` as
  `runTests` would otherwise get a green report for a run that never executed the
  suites.

## Failures are failures

A nonzero exit from the child is an `isError` result carrying that child's own output,
with the JSON parsed out when it is there and the raw stream when the CLI died before
emitting one. Truncation announces itself with the real total. `flawless_check_docs`
returns `isError` when a documented invocation does not parse — a broken example is a
broken example, even in prose.

Two ways the server stops, deliberately different. A **signal** (SIGINT, SIGTERM)
kills the live child's process group before the server exits — even when a
shutdown is already draining — so a server taken down never leaves a generation,
or under `run_tests` a dev server and browsers, holding ports in your project.
The signalled server then gives the in-flight call at most 5 s to settle and
exits anyway, writing `drain bound reached, in-flight call abandoned` to stderr
when it cuts one loose: a host that sent a signal is a host that is leaving.
**Closing stdin** does not cancel: `printf … | flawless-react mcp` closes the
pipe as it writes the batch, and the work that batch asked for still runs to
completion under its own watchdog, so a half-killed generation does not leave
half-written specs behind. Cancel with a signal, not by hanging up.

The exit contract clients may rely on, each kept honest by a permanent test:

- **The process exits when stdin closes and the batch has drained** — measured
  2–42 ms from the last answer frame to exit, for an idle server and one that
  just finished a `flawless_run`.
- **A signal always ends the process.** Live children are killed first; the
  in-flight call gets at most 5 s; an abandoned call is named on stderr.
- **A kept-open stdin is an open session.** The server answers calls until you
  close stdin or signal it — it does not exit after a response, because MCP is
  a session and the next call is normal.
- **A call never outlives its watchdog by more than 4 s.** If the generation's
  direct child exits but a straggler in its process group still holds the
  output pipe open, the group is killed and the result says the output may be
  cut short — a call that never answers is worse than an answer that names
  its own gap.

Three things this surface deliberately does not claim:

- **`flawless_findings` is the static engine only.** The `a11y` task needs a real
  browser (axe) and `react-rules` needs Biome over the project; neither runs in a
  read call. Zero findings is not an accessible, lint-clean component.
- **A run that executes suites needs their prerequisites.** `run_tests` with the
  `e2e` task needs a dev server; the load pipes need a seeded database. Each fails
  with its own named prerequisite rather than reporting a pass.
- **`--force` regenerates a suite wholesale.** Hand-written assertions that live only
  in generated files are gone. `flawless_project_status` first, and read its
  `inventory.todo_markers`.

## Example

A call and its answer, framed as the host sends them. The answer is this tool's real
output shape, trimmed to the fields an agent reads first — an untrimmed answer carries
every field the analyser has, for every component the glob reached, and says so when a
cap cut the list:

```json
{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"flawless_analyse","arguments":{"root":"/srv/app","entry":"src/app/dashboard/page.tsx"}}}
```

```json
{"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"{\n  \"root\": \"/srv/app\",\n  \"files_read\": 2,\n  \"components\": [\n    {\n      \"component\": \"DashboardPage\",\n      \"file\": \"src/app/dashboard/page.tsx\",\n      \"export_kind\": \"default\",\n      \"render_mode\": \"rsc\",\n      \"is_async\": true,\n      \"prop_names\": [],\n      \"prop_usage\": [],\n      \"hooks\": [],\n      \"state\": [],\n      \"fetches\": [\n        {\n          \"method\": \"GET\",\n          \"url\": \"/api/metrics\",\n          \"in_effect\": false,\n          \"line\": 14\n        }\n      ],\n      \"unresolved_props\": [],\n      \"children\": [\n        {\n          \"component\": \"MetricCard\",\n          \"file\": \"src/components/MetricCard.tsx\",\n          \"render_mode\": \"client\",\n          \"props\": 3\n        }\n      ],\n      \"descendants\": 1\n    }\n  ],\n  \"errors\": []\n}"}]}}
```

`flawless_run` answers in text rather than one JSON document: the child's exit
line first (`exit 0`, or the timeout notice when its process group was killed),
then the parsed `--ci` blob under a `result (--ci --json)` marker, then the child's
own diagnostics under a `stderr` marker. When the CLI died before printing a blob,
the raw stream is there in its place — not an empty success — and an output the cap
cut says so with the real totals.
