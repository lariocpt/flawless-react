// `flawless-react mcp` — the Model Context Protocol server over stdio.
//
// Transport contract: one JSON-RPC 2.0 message per line on stdin and stdout.
// stdout belongs to the protocol EXCLUSIVELY, so before anything is served
// process.stdout.write is redirected to stderr and protocol frames go out on the
// saved real writer with drain backpressure. Two things make that more than
// hygiene here: the analyser and the scaffolder are libraries that narrate to
// stdout, and the read plane runs IN this process — without the redirect a single
// progress line would corrupt the frame the host is framing its own reads on.
// (Generation is different: it runs in a child, see run.ts, because the suites it
// executes inherit stdout.)
//
// Lifetime contract: the host owns the lifecycle. A signal (SIGINT, SIGTERM) kills
// any live child's process group and then drains the in-flight call, so a server
// that is taken down never leaves a generation — or under `--run-tests` a dev
// server and a browser — holding ports in someone's project. stdin EOF drains
// instead: `printf … | flawless-react mcp` closes the pipe as it writes the batch,
// and the work that batch asked for still finishes (its watchdog still bounds it).
// Closing the pipe is not a cancel.
//
// Calls are SERIALIZED, one in flight, and this is load-bearing rather than
// polite: the read plane runs with the process working directory set to the
// call's `root` (so globs, default excludes and tsconfig resolution behave exactly
// as they do when the same command is typed in that project). Two concurrent
// reads would each chdir out from under the other's glob and return findings for
// the wrong tree. One at a time makes that impossible by construction.

import { VERSION } from "../version.ts";
import {
  INVALID_PARAMS,
  type JsonObject,
  type JsonValue,
  METHOD_NOT_FOUND,
  parseLine,
  type RpcRequest,
  type RpcResponse,
  fail as rpcFail,
  reply as rpcReply,
  SERVER_NOT_INITIALIZED,
  serialize,
} from "./protocol.ts";
import { killedChildCount, killLiveChildren } from "./run.ts";
import { parseMcpCommand, renderMcpHelp } from "./spec.ts";
import { ToolError } from "./support.ts";
import { ALL_TOOLS, invokeTool, toolByName, toolsList } from "./tools.ts";

/**
 * Protocol versions this server answers, newest first.
 *
 * A client asking for one not listed here gets the newest version this dispatch
 * actually implements rather than an echo of what it asked for: agreeing to a
 * revision whose behaviour this file does not implement would be a promise
 * flawless-react cannot keep.
 */
const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

/**
 * The `flawless-react mcp` entry point. `argv` is everything AFTER the
 * subcommand word (cli.ts strips it, the same way it does for `skills`).
 *
 * Help is answered here, on a real stdout, before the redirect below — after the
 * redirect `--help` would print itself onto stderr and the host would see an empty
 * protocol stream.
 */
export async function runMcpCli(argv: readonly string[]): Promise<number> {
  let help = false;
  try {
    help = parseMcpCommand(argv).verb === "help";
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    return 2;
  }
  if (help) {
    process.stdout.write(renderMcpHelp());
    return 0;
  }
  return runMcp();
}

async function runMcp(): Promise<number> {
  const realStdout = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: unknown): boolean => {
    const text =
      typeof chunk === "string"
        ? chunk
        : chunk instanceof Uint8Array
          ? Buffer.from(chunk).toString("utf8")
          : String(chunk);
    return process.stderr.write(text);
  }) as typeof process.stdout.write;

  let initialized = false;
  let exiting = false;

  // One frame out, backpressure honoured: a frame the OS buffer cannot take yet
  // is waited for, not dropped. Exiting on a non-empty write queue truncates the
  // stream, and a truncated frame is a host that hangs waiting for its answer.
  const writeLine = async (message: RpcResponse): Promise<void> => {
    if (realStdout(serialize(message))) return;
    await new Promise<void>((res) => process.stdout.once("drain", () => res()));
  };

  let chain: Promise<void> = Promise.resolve();
  const enqueue = (task: () => Promise<void>): void => {
    chain = chain.then(task, task);
  };

  const handleRequest = async (req: RpcRequest): Promise<RpcResponse | null> => {
    switch (req.method) {
      case "initialize": {
        const requested =
          typeof req.params?.protocolVersion === "string" ? req.params.protocolVersion : "";
        const version = SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
          ? requested
          : (SUPPORTED_PROTOCOL_VERSIONS[0] as string);
        initialized = true;
        return rpcReply(req.id, {
          protocolVersion: version,
          capabilities: { tools: {} },
          serverInfo: { name: "flawless-react", title: "flawless-react", version: VERSION },
          instructions:
            "flawless-react suite generation over MCP, in two planes. Run-plane tools " +
            "(flawless_run, flawless_skills) change a project and execute a flawless-react " +
            "child with --ci, so their exit codes and output are the CLI's own; read-plane " +
            "tools open files and write nothing. Per-call cwd/env never persist — pass them " +
            "on every call. A nonzero exit, a killed timeout and an unparseable example are " +
            "isError results carrying the verbatim output, and every output cap announces " +
            "itself: this server does not report a false pass.",
        });
      }
      case "ping":
        return rpcReply(req.id, {});
      case "tools/list":
        if (!initialized) {
          return rpcFail(req.id, {
            code: SERVER_NOT_INITIALIZED,
            message: `flawless-react mcp: send initialize before ${req.method}`,
          });
        }
        return rpcReply(req.id, toolsList());
      case "tools/call": {
        if (!initialized) {
          return rpcFail(req.id, {
            code: SERVER_NOT_INITIALIZED,
            message: "flawless-react mcp: send initialize before tools/call",
          });
        }
        const name = req.params?.name;
        if (typeof name !== "string") {
          return rpcFail(req.id, { code: INVALID_PARAMS, message: 'tools/call: "name" required' });
        }
        const tool = toolByName(name);
        if (!tool) {
          // Unknown tool is a protocol-level error, per the spec: the tool never
          // existed, so it cannot be the one answering. The list rides along — a
          // host that guessed a name is exactly the caller that needs the eight.
          return rpcFail(req.id, {
            code: INVALID_PARAMS,
            message: `unknown tool "${name}" — one of: ${ALL_TOOLS.map((t) => t.name).join(", ")}`,
          });
        }
        const rawArgs = req.params?.arguments;
        if (rawArgs !== undefined && (typeof rawArgs !== "object" || rawArgs === null)) {
          return rpcFail(req.id, {
            code: INVALID_PARAMS,
            message: "tools/call: arguments must be an object",
          });
        }
        try {
          const result = await invokeTool(tool, (rawArgs ?? {}) as JsonObject);
          // ToolResult is plain data ({content, isError}); the cast is the
          // JsonValue boundary, not a hole — it carries no methods.
          return rpcReply(req.id, result as unknown as JsonValue);
        } catch (err) {
          // Argument misuse and tool failure are a RESULT, not a transport error:
          // the call was understood, and the answer is "no, with the reason".
          // This is the repo's never-a-false-pass rule read at the protocol layer —
          // burying the reason in an error frame the host may only log is how a
          // failed generation starts reading as an inconclusive one.
          const kind = err instanceof ToolError ? "invalid arguments" : "error";
          return rpcReply(req.id, {
            content: [{ type: "text", text: `flawless-react ${kind}: ${(err as Error).message}` }],
            isError: true,
          });
        }
      }
      default:
        return rpcFail(req.id, {
          code: METHOD_NOT_FOUND,
          message: `flawless-react mcp does not implement "${req.method}"`,
        });
    }
  };

  // `kill` splits the two ways a server stops:
  //
  // - A SIGNAL means nobody is left to read and the process is being taken down by
  //   force. Kill FIRST, then drain: the other order spends minutes serving a host
  //   that is already gone, and the child spending them is the one still writing
  //   into the project. The kill makes the drain a formality — the call's own
  //   `proc.exited` is the promise that lands next.
  // - EOF is different, because `printf … | flawless-react mcp` closes stdin the
  //   instant the batch is written. Those in-flight calls ARE the requests that
  //   were made; draining them lets a piped batch finish (a generation killed
  //   halfway would leave half-written specs in the project for no one's
  //   convenience). Closing the pipe is not a cancel — SIGTERM is.
  const shutdown = async (reason: string, opts: { kill: boolean }): Promise<void> => {
    if (exiting) return;
    exiting = true;
    if (opts.kill) killLiveChildren();
    await chain.catch(() => {});
    const killed = killedChildCount();
    process.stderr.write(
      `flawless-react mcp: ${reason}, shutting down${killed ? ` (${killed} child killed)` : ""}\n`,
    );
  };
  // The signal name is passed as the reason rather than taken from the handler
  // argument: this repo's `process.on` overloads resolve to a signal union that
  // a `NodeJS.Signals`-typed parameter does not satisfy. Exiting here, after the
  // drain, is what keeps a killed server from truncating a frame mid-write.
  const onSignal = (signal: string): void => {
    void shutdown(signal, { kill: true }).then(() => process.exit(0));
  };
  process.on("SIGTERM", () => onSignal("SIGTERM"));
  process.on("SIGINT", () => onSignal("SIGINT"));

  const reader = Bun.stdin.stream().getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    while (!exiting) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl = buf.indexOf("\n");
      while (nl !== -1) {
        const line = buf.slice(0, nl).replace(/\r$/, "");
        buf = buf.slice(nl + 1);
        nl = buf.indexOf("\n");
        if (!line.trim()) continue;
        const parsed = parseLine(line);
        if (parsed.kind === "invalid") {
          const response = parsed.response;
          enqueue(async () => void (await writeLine(response)));
        } else if (parsed.kind === "request") {
          const req = parsed.request;
          enqueue(async () => {
            const response = await handleRequest(req);
            if (response) await writeLine(response);
          });
        } else {
          const note = parsed.notification;
          // The handshake's second half and the cancel notice: no frame back.
          // Anything else is SAID to, on stderr, never swallowed silently — a
          // host sending a method this server does not handle should know.
          if (
            note.method !== "notifications/initialized" &&
            note.method !== "notifications/cancelled"
          ) {
            process.stderr.write(`flawless-react mcp: ignoring notification "${note.method}"\n`);
          }
        }
      }
    }
  } catch (err) {
    process.stderr.write(`flawless-react mcp: stdin error: ${(err as Error).message}\n`);
    // A broken transport is not a closed one: nothing more can be read or answered,
    // so an in-flight child is killed rather than left working for a server that
    // cannot report on it.
    await shutdown("stdin error", { kill: true });
    return 1;
  }
  // stdin closed cleanly. Drain rather than kill: a piped batch closes the moment
  // it is written, and the work it asked for is not less real for the pipe being
  // gone. The drain is bounded by each call's own watchdog, so this is not
  // unbounded — and no child outlives it.
  await shutdown("stdin closed", { kill: false });
  return 0;
}
