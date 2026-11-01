// The run plane of the MCP surface: every tool that GENERATES, INSTALLS or runs
// suites spawns a flawless-react CHILD process per call.
//
// Why a child is structural, not cosmetic: core.ts's test runner spawns the
// generated Playwright/Vitest suites with `stdout: "inherit"` unless the run is
// quiet, and the scaffold narrates progress to stdout. In-process execution
// would write raw bytes into the protocol's stdout and corrupt JSON-RPC — the
// one failure an MCP server cannot survive, because the host reads the stream
// for framing. The child boundary also buys the three things a long generation
// job actually needs: the CLI's real exit-code contract (0/1/2, including the
// `exitCode` inside the --ci blob), a killable process group for a suite that
// hangs, and per-call cwd/env with nothing kept between calls.
//
// Honest-failure contract (the repo's first design rule, ported to MCP): a
// nonzero child exit or a killed timeout is an isError result carrying the
// child's own output — never a success that measured nothing. Output caps are
// always announced, never silent.

import path from "node:path";
import type { JsonObject, JsonValue } from "./protocol.ts";
import { capText, fail, ok, optInt, optStr, optStrMap, type ToolResult } from "./support.ts";

/** Interpreter names. When `process.execPath` is one of these, the CLI was
 *  started as `bun <script>`, and re-invoking means naming the script again. */
const RUNTIMES = new Set(["bun", "bunx", "node", "nodejs", "deno"]);

/**
 * How to re-invoke THIS flawless-react from inside itself.
 *
 * Measured on Bun 1.4 for all three shipped shapes (a probe, not an assumption —
 * the compiled binary reports argv differently and a wrong guess here means every
 * run tool spawns the wrong thing):
 *
 *   `bun src/cli.ts mcp`        execPath=<bun>  argv[1]=<abs>/src/cli.ts
 *   `bin/flawless-react mcp`    execPath=<bun>  argv[1]=<abs>/bin/flawless-react
 *                               (the npm shim is extensionless, so an extension
 *                               test on argv[1] — the obvious heuristic — picks
 *                               the WRONG branch here)
 *   compiled binary             execPath=<the binary>  argv[0]="bun"
 *                               argv[1]=Bun.main="/$bunfs/root/flawless-react"
 *
 * So: the virtual-fs path proves we are the binary itself; otherwise a runtime
 * execPath proves we must re-name the script.
 */
export function flawlessSpawnArgv(): string[] {
  const script = process.argv[1] ?? "";
  if (script.startsWith("/$bunfs/")) return [process.execPath];
  if (RUNTIMES.has(path.basename(process.execPath))) {
    if (!script) {
      throw new Error(
        "flawless-mcp: cannot re-invoke flawless-react — no script path in argv[1] and " +
          `execPath is the runtime (${process.execPath}). Start the server as a compiled ` +
          "binary or as `bun src/cli.ts mcp`.",
      );
    }
    return [process.execPath, script];
  }
  return [process.execPath];
}

export interface ChildRun {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** The direct child exited but its output pipes stayed open — a straggler
   *  in its process group (a dev server a test runner leaked) had inherited
   *  the write ends. The group was killed and the drain cut short; the text
   *  carried is what arrived and may be incomplete. Absent on every clean
   *  run, and announced in the rendered result when set. */
  pipesCut?: boolean;
}

/** Generation over a whole app's glob is analysis + file writing; with
 *  `run_tests` it is Playwright and Vitest on top. Ten minutes is the default
 *  because that is what a component-level run costs, and the timeout is a
 *  watchdog with a named deadline, not a budget the tool silently enforces. */
export const DEFAULT_TIMEOUT_MS = 600_000;
export const TIMEOUT_MIN = 1_000;
export const TIMEOUT_MAX = 4 * 3_600_000;

export interface ChildOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}

/** How long the child's stdout/stderr pipes are given to close on their own
 *  after the direct child exits — and again for the group kill that forces
 *  them closed. Two seconds is generous for "the writer is gone and the
 *  kernel is closing the pipe", and short enough that a straggler cannot
 *  hold a tool call (or the server's shutdown chain) hostage. */
const PIPE_DRAIN_GRACE_MS = 2_000;

/** Read a pipe to the end, accumulating into `sink` as bytes arrive. Unlike
 *  `new Response(stream).text()`, the text read SO FAR survives an abandoned
 *  read — which is the whole point when the drain is cut short. */
async function readPipe(stream: ReadableStream<Uint8Array>, sink: { text: string }): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    sink.text += decoder.decode(value, { stream: true });
  }
}

/** Did the promise settle within `ms`? A false means "not yet", never "no". */
async function settles(promise: Promise<unknown>, ms: number): Promise<boolean> {
  return await Promise.race([promise.then(() => true), Bun.sleep(ms).then(() => false)]);
}

/**
 * Children this process spawned and has not reaped.
 *
 * The registry exists for one moment: the host closes stdin or sends SIGTERM
 * while a generation is mid-flight. Without it the child — and under `--run-tests`
 * its dev server and browsers — outlives the server that started it, holding
 * ports in a project whose agent has already gone.
 */
const LIVE = new Set<ReturnType<typeof Bun.spawn>>();

/**
 * Set once the server has begun teardown.
 *
 * It closes the one race the registry would otherwise leave: a call already
 * dequeued when stdin closed spawns its child a moment AFTER the kill pass, and
 * that child — a generation, or under `--run-tests` a dev server and browsers —
 * would then be orphaned with nobody left to reap it. After teardown, registering
 * is killing.
 */
let TEARDOWN = false;

/** Kills performed because the server is going away — not watchdog timeouts, which
 *  are the caller's own deadline, not teardown. The stderr note quotes this. */
let KILLED_TOTAL = 0;

function killGroup(proc: ReturnType<typeof Bun.spawn>): void {
  try {
    process.kill(-proc.pid, "SIGKILL");
  } catch {
    try {
      proc.kill("SIGKILL");
    } catch {
      // Already dead. The registry entry is dropped either way.
    }
  }
}

/** Register a live child, or kill it on arrival if teardown already happened. */
function track(proc: ReturnType<typeof Bun.spawn>): void {
  LIVE.add(proc);
  if (TEARDOWN) {
    KILLED_TOTAL++;
    killGroup(proc);
  }
}

/** SIGKILL every live child's process group. Sticky: children spawned afterwards
 *  are killed as they appear, so a call that was dequeued after teardown started
 *  cannot orphan its child. */
export function killLiveChildren(): void {
  TEARDOWN = true;
  KILLED_TOTAL += LIVE.size;
  for (const proc of LIVE) killGroup(proc);
  LIVE.clear();
}

/** How many children teardown has killed, late kills included. */
export function killedChildCount(): number {
  return KILLED_TOTAL;
}

/**
 * Run `flawless-react <args…>` to completion, or kill its whole process group at
 * the deadline.
 *
 * Children are spawned detached so the kill reaches the grandchildren — a suite
 * under `--run-tests` is a dev server plus browsers plus workers, and killing
 * only the CLI would orphan exactly the processes that hold ports.
 */
export async function runFlawlessChild(args: string[], opts: ChildOptions = {}): Promise<ChildRun> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([...flawlessSpawnArgv(), ...args], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      detached: true,
      ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
      ...(opts.env !== undefined ? { env: { ...process.env, ...opts.env } } : {}),
    });
  } catch (err) {
    // A bad cwd is Bun.spawn throwing ENOENT before anything ran. Name the
    // argument at fault rather than the syscall.
    const message = (err as Error).message;
    if (opts.cwd !== undefined && message.includes(opts.cwd)) {
      throw new Error(`invalid "cwd": ${message}`);
    }
    throw err;
  }
  track(proc);
  let timedOut = false;
  const killer = setTimeout(() => {
    timedOut = true;
    killGroup(proc);
  }, timeoutMs);
  // No race needed: the watchdog KILLS the child, so `proc.exited` is the one
  // promise that always lands — with or without the deadline.
  const out = { text: "" };
  const err = { text: "" };
  const readOut = readPipe(proc.stdout as ReadableStream<Uint8Array>, out);
  const readErr = readPipe(proc.stderr as ReadableStream<Uint8Array>, err);
  await proc.exited;
  LIVE.delete(proc);
  clearTimeout(killer);
  // The child is gone; its pipes should close with it. A straggler in its
  // process group — a dev server a test runner leaked — inherits the write
  // ends and would hold these reads open forever, and nothing bounds that any
  // more: the watchdog was just cleared, and the child it would kill is
  // already dead. An unbounded read here is worse than a slow tool call: the
  // response frame is never written, the server's shutdown chain never
  // settles, and even SIGTERM cannot make the server exit. So: a grace for
  // the pipes to close on their own, then the group kill — which is exactly
  // the straggler's execution order — and a second grace for it to land. If
  // even that fails (a straggler that re-detached into its own group), return
  // with the partial text and say so; an answer that names its own gap beats
  // a call that never answers.
  let pipesCut = false;
  if (
    !(await settles(readOut, PIPE_DRAIN_GRACE_MS)) ||
    !(await settles(readErr, PIPE_DRAIN_GRACE_MS))
  ) {
    pipesCut = true;
    killGroup(proc);
    await settles(readOut, PIPE_DRAIN_GRACE_MS);
    await settles(readErr, PIPE_DRAIN_GRACE_MS);
  }
  return {
    code: timedOut ? -1 : (proc.exitCode ?? -1),
    stdout: out.text,
    stderr: err.text,
    timedOut,
    pipesCut,
  };
}

/** A stream, capped and labelled; empty streams say so rather than vanishing. */
function stream(label: string, text: string): string | null {
  const capped = capText(text);
  const body = capped.text.replace(/\n+$/, "");
  if (!body.trim()) return null;
  return `--- ${label}${capped.truncated ? " (truncated, see marker)" : ""} ---\n${body}`;
}

/** Announced, never silent — the honest-failure rule read on the drain side. */
const PIPE_CUT_NOTE =
  "note: the child exited but a straggler in its process group held the output pipe " +
  "open; the group was killed and the output may be cut short";

/** Nonzero exit and timeouts are isError; the child's verdict is the verdict. */
export function renderRun(run: ChildRun, timeoutMs: number): ToolResult {
  const parts = [
    run.timedOut
      ? `timed out after ${timeoutMs}ms — process group killed (exit reported as -1)`
      : `exit ${run.code}`,
  ];
  if (run.pipesCut) parts.push(PIPE_CUT_NOTE);
  const out = stream("stdout", run.stdout);
  const err = stream("stderr", run.stderr);
  if (out) parts.push(out);
  if (err) parts.push(err);
  if (!out && !err) parts.push("(no output)");
  return run.timedOut || run.code !== 0 ? fail(parts.join("\n")) : ok(parts.join("\n"));
}

/**
 * A `--ci` child run rendered as a tool result: the JSON blob parsed and
 * re-emitted (the caller gets structure, not a string it has to un-nest from a
 * text field), with the child's stderr diagnostics kept beside it.
 *
 * The parse is allowed to fail, and says so when it does: `--ci`'s contract is
 * that a successful run prints exactly one JSON document, but a usage error
 * exits 2 with its reason on stderr and nothing on stdout, and reporting THAT as
 * "no JSON" would bury the actual message. So an unparseable stdout falls back
 * to the raw streams rather than to a guess.
 */
export function renderCiRun(run: ChildRun, timeoutMs: number): ToolResult {
  const head = run.timedOut
    ? `timed out after ${timeoutMs}ms — process group killed (exit reported as -1)`
    : `exit ${run.code}`;
  const blob = parseCiBlob(run.stdout);
  const parts = [head];
  if (run.pipesCut) parts.push(PIPE_CUT_NOTE);
  if (blob !== null) {
    parts.push(`--- result (--ci --json) ---\n${JSON.stringify(blob, null, 2)}`);
  } else {
    const out = stream("stdout (not a JSON blob)", run.stdout);
    if (out) parts.push(out);
  }
  const err = stream("stderr", run.stderr);
  if (err) parts.push(err);
  if (blob === null && !err) parts.push("(no output)");
  return run.timedOut || run.code !== 0 ? fail(parts.join("\n")) : ok(parts.join("\n"));
}

/** The blob, or null when stdout is not one. Trailing text after the document is
 *  a contract break, so it is reported as unparseable rather than ignored. */
function parseCiBlob(stdout: string): JsonValue | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as JsonValue;
  } catch {
    return null;
  }
}

/**
 * Per-call cwd/env/watchdog, read through the same validating accessors every
 * other argument uses — a timeout of `"60000"` (a string, from a host that
 * stringifies) is rejected by name rather than silently dropped, leaving the
 * caller with a run that had no watchdog at all.
 */
export function callOpts(args: JsonObject): ChildOptions {
  const timeoutMs = optInt(args, "timeout_ms", TIMEOUT_MIN, TIMEOUT_MAX);
  const cwd = optStr(args, "cwd");
  const env = optStrMap(args, "env");
  return {
    ...(cwd !== undefined ? { cwd } : {}),
    ...(env !== undefined ? { env } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  };
}
