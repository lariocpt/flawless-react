// The MCP surface: `flawless-react mcp`.
//
// What these tests refuse to let drift is the honesty of the surface, not its
// pretty shapes:
//
//   * framing — a malformed line answers with -32700, and stdout carries ONLY
//     frames, because the host frames its own reads on that stream;
//   * the tool set the docs promise, checked against the registry rather than
//     against a number someone typed into a README;
//   * argument misuse as an `isError` RESULT (the call was understood; the answer
//     is "no, with the reason"), a nonzero child exit never laundered into a
//     green run, and no read tool writing a byte;
//   * teardown: a call that outlives its deadline, and a host that hangs up
//     mid-call, both end with the child dead rather than orphaned in a project.
//
// The live-server tests spawn the real entry (src/bin.ts) because the stdout
// redirect and the teardown are exactly the parts an in-process harness cannot
// observe.

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { checkLines } from "../src/cli.ts";
import { parseLine } from "../src/mcp/protocol.ts";
import {
  killedChildCount,
  killLiveChildren,
  renderCiRun,
  runFlawlessChild,
} from "../src/mcp/run.ts";
import { renderMcpHelp } from "../src/mcp/spec.ts";
import { ALL_TOOLS, invokeTool, toolByName, toolsList } from "../src/mcp/tools.ts";

const REPO = path.resolve(import.meta.dirname, "..");
const BIN = path.join(REPO, "src/bin.ts");

const TOOL_NAMES = ALL_TOOLS.map((t) => t.name);

interface Frame {
  result?: unknown;
  error?: { code: number; message: string };
}

interface Session {
  /** Every line stdout carried, in order. Parsed by `session`, so purity is
   *  asserted before a single assertion below runs. */
  lines: string[];
  responses: Map<number, Frame>;
  stderr: string;
  code: number;
}

// ---------------------------------------------------------------------------
// A — framing, in the pure layer that decides it
// ---------------------------------------------------------------------------
describe("mcp framing", () => {
  test("a line that is not JSON is a parse error, never silence", () => {
    const parsed = parseLine("tools/list");
    if (parsed.kind !== "invalid") throw new Error(`expected invalid, got ${parsed.kind}`);
    expect(parsed.response.error?.code).toBe(-32700);
    // id:null is the spec's answer for a frame whose id could not be read; a
    // client that never learns its call died is a client that hangs.
    expect(parsed.response.id).toBeNull();
  });

  test("JSON without a method is an invalid request", () => {
    const parsed = parseLine('{"jsonrpc":"2.0","id":1}');
    if (parsed.kind !== "invalid") throw new Error(`expected invalid, got ${parsed.kind}`);
    expect(parsed.response.error?.code).toBe(-32600);
  });

  test("a request and a notification are told apart", () => {
    expect(parseLine('{"jsonrpc":"2.0","id":7,"method":"ping"}').kind).toBe("request");
    expect(parseLine('{"jsonrpc":"2.0","method":"notifications/initialized"}').kind).toBe(
      "notification",
    );
  });
});

// ---------------------------------------------------------------------------
// B — the tool set is the documented tool set
// ---------------------------------------------------------------------------
describe("mcp tool registry", () => {
  test("is the eight the docs and the help text name", () => {
    expect(TOOL_NAMES).toEqual([
      "flawless_run",
      "flawless_skills",
      "flawless_tasks",
      "flawless_reference",
      "flawless_check_docs",
      "flawless_analyse",
      "flawless_findings",
      "flawless_project_status",
    ]);
    expect(new Set(TOOL_NAMES).size).toBe(TOOL_NAMES.length);
  });

  test("every tool publishes an object schema and a description that says what it does", () => {
    const listed = toolsList() as { tools: Array<Record<string, unknown>> };
    expect(listed.tools.length).toBe(ALL_TOOLS.length);
    for (const t of listed.tools) {
      const description = t.description;
      expect(typeof description).toBe("string");
      expect((description as string).length).toBeGreaterThan(40);
      const schema = t.inputSchema as { type?: string; additionalProperties?: unknown };
      expect(schema.type).toBe("object");
      // additionalProperties:false is the promise invokeTool enforces; a tool
      // that relaxed it would start dropping caller arguments on the floor.
      expect(schema.additionalProperties).toBe(false);
    }
  });

  test("the help text, docs/mcp.md and the README name exactly this set", () => {
    const help = renderMcpHelp();
    for (const name of TOOL_NAMES) expect(help).toContain(name);
    expect(help).toMatch(/eight tools/);

    const doc = readFileSync(path.join(REPO, "docs/mcp.md"), "utf8");
    // The table's first column, not every mention: prose may name a tool the
    // table also lists, and that is not drift.
    const tableNames = [...doc.matchAll(/^\| `(flawless_\w+)` \|/gm)].map((m) => m[1]);
    expect(tableNames.sort()).toEqual([...TOOL_NAMES].sort());

    const readme = readFileSync(path.join(REPO, "README.md"), "utf8");
    for (const name of TOOL_NAMES) expect(readme).toContain(name);
  });
});

// ---------------------------------------------------------------------------
// C — argument checking: misuse is an answer, not a silent omission
// ---------------------------------------------------------------------------
describe("mcp argument checking", () => {
  test("an argument the schema does not name is refused, not dropped", async () => {
    // flawless_tasks takes nothing. Ignoring `root` here would be the small
    // version of ignoring `run_tests`: the caller keeps believing the argument
    // did something.
    await expect(invokeTool(mustFind("flawless_tasks"), { root: "/tmp" })).rejects.toThrow(
      /unknown argument "root" for flawless_tasks/,
    );
  });

  test("a missing required argument says which one", async () => {
    await expect(invokeTool(mustFind("flawless_skills"), {})).rejects.toThrow(
      /missing required argument "action"/,
    );
  });

  test("a bad enum member lists the choices instead of guessing one", async () => {
    await expect(invokeTool(mustFind("flawless_run"), { tasks: ["perf-harnest"] })).rejects.toThrow(
      /expected one of perf-harness/,
    );
  });

  test("a valid call still runs", async () => {
    const res = await invokeTool(mustFind("flawless_tasks"), {});
    expect(res.isError).toBeUndefined();
    const body = JSON.parse(textOf(res)) as { task_ids: string[] };
    expect(body.task_ids).toContain("perf-static");
  });
});

// ---------------------------------------------------------------------------
// D — the documented line parses as a subcommand, not as an entry glob
// ---------------------------------------------------------------------------
describe("mcp in the docs lint", () => {
  test("flawless-react mcp is checked as the subcommand it is", () => {
    const ok = checkLines("flawless-react mcp\nflawless-react mcp --help\n");
    expect(ok.checked).toBe(2);
    expect(ok.problems).toEqual([]);
    expect(ok.skipped).toBe(0);
  });

  test("a typo'd mcp argument is a problem, not a passing entry glob", () => {
    // Without the mcp branch in checkLines, `mcp` reads as an entry glob and
    // this line passes FOR THE WRONG REASON — the failure skills/spec.ts exists
    // to prevent, repeating itself one subcommand later.
    const rep = checkLines("flawless-react mcp --port 8080\n");
    expect(rep.checked).toBe(1);
    expect(rep.problems.length).toBe(1);
    expect(mustOne(rep.problems).problem).toMatch(/takes no arguments/);
  });
});

// ---------------------------------------------------------------------------
// E — a live server, over the real entry point
// ---------------------------------------------------------------------------
describe("mcp server over stdio", () => {
  test("pre-initialize calls are refused, and the handshake answers with the tool capability", async () => {
    const s = await session([
      '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
      INIT,
      INITED,
      '{"jsonrpc":"2.0","id":2,"method":"tools/list"}',
      '{"jsonrpc":"2.0","id":3,"method":"ping"}',
    ]);
    expect(s.code).toBe(0);
    expect(errorCode(s, 1)).toBe(-32002);

    const init = result(s, 0) as Record<string, unknown>;
    expect(init.protocolVersion).toBe("2025-06-18");
    expect((init.capabilities as Record<string, unknown>).tools).toBeDefined();
    expect((init.serverInfo as Record<string, unknown>).name).toBe("flawless-react");

    const listed = result(s, 2) as { tools: Array<{ name: string }> };
    expect(listed.tools.map((t) => t.name)).toEqual(TOOL_NAMES);
    expect(result(s, 3)).toEqual({});
    // Four frames for five lines: the handshake notification answers nothing.
    expect(s.lines.length).toBe(4);
  });

  test("an unknown protocol version gets one this server implements", async () => {
    const s = await session([
      '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"1999-01-01"}}',
    ]);
    expect((result(s, 1) as { protocolVersion: string }).protocolVersion).toBe("2025-06-18");
  });

  test("unknown method, unknown tool and malformed frames are protocol errors with reasons", async () => {
    const s = await session([
      INIT,
      INITED,
      '{"jsonrpc":"2.0","id":1,"method":"prompts/list"}',
      '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"flawless_flies"}}',
      '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"flawless_tasks","arguments":"nope"}}',
      "this is not json",
      '{"jsonrpc":"2.0","method":"notifications/unknown_thing"}',
    ]);
    expect(errorCode(s, 1)).toBe(-32601);
    const unknownTool = mustError(s, 2);
    expect(unknownTool.code).toBe(-32602);
    // The list rides along: a host that guessed a name is the caller that needs it.
    expect(unknownTool.message).toContain("flawless_project_status");
    expect(errorCode(s, 3)).toBe(-32602);
    // The parse error answers with id:null; the notification answers nothing,
    // which is what makes it a notification. Five frames: the handshake, three
    // answers, and the parse error.
    expect(s.lines.length).toBe(5);
    expect(s.lines.some((l) => l.includes('"id":null') && l.includes("-32700"))).toBe(true);
    // Unhandled notifications are SAID on stderr, never swallowed silently.
    expect(s.stderr).toContain('ignoring notification "notifications/unknown_thing"');
  });

  test("argument misuse answers as an isError result, with the reason in the text", async () => {
    const s = await session([
      INIT,
      INITED,
      call(1, "flawless_reference", { formt: "json" }),
      call(2, "flawless_skills", {}),
    ]);
    expect(isErrorResult(s, 1)).toBe(true);
    expect(isErrorResult(s, 2)).toBe(true);
    expect(text(s, 1)).toMatch(/invalid arguments/);
    expect(text(s, 1)).toContain('unknown argument "formt"');
    expect(text(s, 2)).toMatch(/missing required argument "action"/);
  });

  test("the read plane answers without writing, and check_docs names a broken example", async () => {
    const dir = await tempProject();
    try {
      const before = snapshot(dir);
      const s = await session([
        INIT,
        INITED,
        call(1, "flawless_analyse", { root: dir, entry: "src/Widget.tsx" }),
        call(2, "flawless_findings", { root: dir, entry: "src/Widget.tsx" }),
        call(3, "flawless_project_status", { root: dir }),
        call(4, "flawless_check_docs", {
          text: "flawless-react src/Widget.tsx --tasks perf-static\n",
        }),
        call(5, "flawless_check_docs", { text: "flawless-react src/Widget.tsx --forse\n" }),
      ]);

      const analysed = json<{
        components?: Array<{ component?: string; prop_names?: string[] }>;
        errors?: unknown[];
      }>(s, 1);
      expect(analysed.errors).toEqual([]);
      expect(mustOne(analysed.components).component).toBe("Widget");

      const findings = json<{ findings?: unknown[] }>(s, 2);
      expect(Array.isArray(findings.findings)).toBe(true);

      const status = json<{ root?: string; mode?: string }>(s, 3);
      // The root is reported resolved, so a caller that sent "." learns which
      // project it actually read.
      expect(status.root).toBe(realpathSync(dir));
      expect(status.mode).toBe("standalone");

      const good = json<{ checked?: number; problems?: unknown[] }>(s, 4);
      expect(good.checked).toBe(1);
      expect(good.problems).toEqual([]);
      expect(isErrorResult(s, 4)).toBe(false);

      // A broken example is broken in prose too: isError, with the CLI's reason.
      expect(isErrorResult(s, 5)).toBe(true);
      expect(text(s, 5)).toContain("--forse");

      // The claim in docs/mcp.md, measured: a read call writes nothing.
      expect(snapshot(dir)).toEqual(before);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 180_000);
});

// ---------------------------------------------------------------------------
// F — the run plane: real child, real exit codes
// ---------------------------------------------------------------------------
describe("mcp run plane", () => {
  test("flawless_run generates a suite, returns the --ci blob and reports exit 0", async () => {
    const dir = await tempProject();
    try {
      const s = await session(
        [
          INIT,
          INITED,
          call(1, "flawless_run", {
            cwd: dir,
            entry: "src/Widget.tsx",
            tasks: ["perf-static"],
          }),
        ],
        300_000,
      );
      expect(isErrorResult(s, 1)).toBe(false);
      const body = text(s, 1);
      expect(body.startsWith("exit 0")).toBe(true);
      const blob = JSON.parse(body.slice(body.indexOf("{"))) as {
        exitCode: number;
        results: Array<{ id: string; ok: boolean }>;
      };
      expect(blob.exitCode).toBe(0);
      expect(blob.results.map((r) => r.id)).toEqual(["perf-static"]);
      expect(blob.results[0]?.ok).toBe(true);
      // The files landed in the CALLER's project, not the server's cwd.
      expect(existsSync(path.join(dir, ".flawless", "reports", "Widget.perf-static.json"))).toBe(
        true,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 300_000);

  test("a child that exits 2 is an error result carrying its own output", async () => {
    const dir = await tempProject();
    try {
      const s = await session(
        [INIT, INITED, call(1, "flawless_run", { cwd: dir, entry: "src/Nothing.tsx" })],
        180_000,
      );
      expect(isErrorResult(s, 1)).toBe(true);
      // The exit code that would have been a false pass is IN the text, and the
      // reason is the CLI's own words, not a paraphrase.
      expect(text(s, 1)).toMatch(/exit 2/);
      expect(text(s, 1).length).toBeGreaterThan(40);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 180_000);

  test("the watchdog kills the child's process group at its deadline", async () => {
    // Measured one layer down on purpose. At the protocol level the watchdog has
    // the documented 1000ms floor, and a warm single-component generation beats
    // that on this machine — a test asserting a timeout there would pass only on
    // a loaded machine. 1ms cannot outlast the child's own startup, so the
    // deadline IS what this call hits, every time.
    //
    // argv[1] is pointed at the real entry: under `bun test` it names this file,
    // and the child would obediently re-run the suite.
    const argv1 = process.argv[1];
    process.argv[1] = BIN;
    try {
      const run = await runFlawlessChild(["--version"], { timeoutMs: 1 });
      expect(run.timedOut).toBe(true);
      // -1, not 0: a killed run must never read as a clean exit.
      expect(run.code).toBe(-1);
      const rendered = renderCiRun(run, 1);
      expect(rendered.isError).toBe(true);
      // The child's verdict is in the caller's words, and the killed group is
      // said out loud rather than left as a bare -1.
      expect(textOf(rendered)).toContain("timed out after 1ms");
      expect(textOf(rendered)).toContain("process group killed");
    } finally {
      if (argv1 !== undefined) process.argv[1] = argv1;
    }
  }, 60_000);

  test("timeout_ms is read and bounded, not accepted and ignored", async () => {
    const dir = await tempProject();
    try {
      const s = await session([
        INIT,
        INITED,
        call(1, "flawless_run", { cwd: dir, entry: "src/Widget.tsx", timeout_ms: 5 }),
      ]);
      expect(isErrorResult(s, 1)).toBe(true);
      expect(text(s, 1)).toMatch(/invalid argument "timeout_ms"/);
      expect(text(s, 1)).toMatch(/integer 1000\.\.14400000/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 180_000);

  test("a piped batch finishes its run even though stdin closed at once", async () => {
    // The transport is a pipe, so `printf … | flawless-react mcp` closes stdin the
    // moment the batch is written. That is a caller, not a hang-up: killing the
    // in-flight generation there answered the batch with `exit -1` and left
    // half-written specs in the project. Cancelling is a signal's job.
    const dir = await tempProject();
    try {
      const s = await session(
        [
          INIT,
          INITED,
          call(1, "flawless_run", {
            cwd: dir,
            entry: "src/Widget.tsx",
            tasks: ["perf-static"],
          }),
        ],
        180_000,
        { hangUpFirst: true },
      );
      expect(s.code).toBe(0);
      expect(isErrorResult(s, 1)).toBe(false);
      expect(text(s, 1).startsWith("exit 0")).toBe(true);
      expect(s.stderr).toContain("stdin closed, shutting down");
      // Drained, not torn down: nothing was killed, so nothing says it was.
      expect(s.stderr).not.toContain("child killed");
      expect(existsSync(path.join(dir, ".flawless", "reports", "Widget.perf-static.json"))).toBe(
        true,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 180_000);

  test("SIGTERM stops the server saying which signal it was", async () => {
    const proc = Bun.spawn(["bun", BIN, "mcp"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      cwd: REPO,
    });
    proc.stdin.write(`${INIT}\n`);
    // Signal only once the server is serving: bun's own startup is a few hundred
    // ms, and a SIGTERM that lands before the handler is installed is answered by
    // the default disposition — a nonzero exit that proves nothing about teardown.
    const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
    const chunk = await Promise.race([reader.read(), Bun.sleep(30_000).then((): null => null)]);
    if (chunk === null) throw new Error("the server never answered initialize");
    if (chunk.done) throw new Error("the server closed stdout before answering initialize");
    // stdin stays OPEN: closed first, it would race the signal, and the test would
    // pass on the EOF note while claiming to prove the signal path.
    proc.kill("SIGTERM");
    expect(await proc.exited).toBe(0);
    const stderr = await new Response(proc.stderr).text();
    expect(stderr).toContain("SIGTERM, shutting down");
  }, 60_000);

  test("teardown kills a live child, including one spawned after the kill pass", async () => {
    // The race the sticky flag closes: a call dequeued AFTER teardown started
    // registers its child a moment too late, and without "registering is killing"
    // that child is orphaned holding a port in someone's project. Measured one
    // layer down because the window is a few microseconds wide at the protocol
    // level — here it is the whole test.
    const argv1 = process.argv[1];
    process.argv[1] = BIN;
    const dir = await tempProject();
    try {
      const before = killedChildCount();
      const inflight = runFlawlessChild(["--version"], { cwd: dir });
      killLiveChildren();
      // Dequeued after the kill pass: it spawns, registers, and dies on arrival.
      const late = runFlawlessChild(["--version"], { cwd: dir });
      const first = await inflight;
      expect(first.timedOut || first.code !== 0).toBe(true);
      expect(killedChildCount()).toBeGreaterThan(before);
      await late;
    } finally {
      if (argv1 !== undefined) process.argv[1] = argv1;
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const INIT =
  '{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"flawless-tests","version":"0"}}}';
const INITED = '{"jsonrpc":"2.0","method":"notifications/initialized"}';
const call = (id: number, name: string, args: Record<string, unknown> = {}) =>
  JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });

function mustFind(name: string) {
  const tool = toolByName(name);
  if (!tool) throw new Error(`no tool named ${name}`);
  return tool;
}

function mustOne<T>(items: T[] | undefined, what = "list"): T {
  const first = items?.[0];
  if (first === undefined || (items?.length ?? 0) !== 1) {
    throw new Error(`expected exactly one ${what}, got ${items?.length}`);
  }
  return first;
}

/** A project small enough to generate against in a test, and empty enough that
 *  a write by a read-only tool is visible. */
async function tempProject(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "flawless-mcp-"));
  await mkdir(path.join(dir, "src"), { recursive: true });
  await writeFile(
    path.join(dir, "src", "Widget.tsx"),
    `import { useState } from "react";
export function Widget({ title, initial = 0 }: { title: string; initial?: number }) {
  const [n, setN] = useState(initial);
  return <button onClick={() => setN(n + 1)}>{title}: {n}</button>;
}
`,
    "utf8",
  );
  await writeFile(path.join(dir, "package.json"), '{"name":"probe","private":true}', "utf8");
  return dir;
}

/**
 * Speak to a real `flawless-react mcp` child: write the frames, wait for the
 * answers, then hang up.
 *
 * A real host holds the pipe open for the length of a call, so this does too — it
 * waits for the frame count the sent frames imply, then closes. `hangUpFirst` is
 * the other way a caller behaves: a shell pipeline closes stdin as it writes, and
 * the batch still has to finish (see the piped-batch test).
 */
async function session(
  frames: string[],
  timeoutMs = 120_000,
  opts: { hangUpFirst?: boolean } = {},
): Promise<Session> {
  const proc = Bun.spawn(["bun", BIN, "mcp"], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    cwd: REPO,
  });
  // One frame back per line that carries an id; a line that is not JSON is
  // answered too, with the parse error. Notifications answer nothing.
  const expected = frames.filter((f) => {
    try {
      const v = JSON.parse(f) as { id?: unknown };
      return typeof v.id !== "undefined";
    } catch {
      return true;
    }
  }).length;

  proc.stdin.write(`${frames.join("\n")}\n`);
  if (opts.hangUpFirst) proc.stdin.end();
  // The stream stays read by this one reader to the end — `new Response()` would
  // find it locked — and only one `read()` is ever outstanding: re-arming while a
  // previous read is still pending would queue it, and the frame it carries would
  // be dropped on the floor. A 250ms tick only says "nothing yet", distinct from
  // `done`, which says the server is gone.
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  const lines: string[] = [];
  let buf = "";
  let eof = false;
  let pending: Promise<void> = Promise.resolve();

  const drain = (value?: Uint8Array): void => {
    buf += decoder.decode(value, { stream: true });
    let nl = buf.indexOf("\n");
    while (nl !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) lines.push(line);
      nl = buf.indexOf("\n");
    }
  };
  const pump = (): void => {
    pending = reader.read().then((res) => {
      if (res.done) {
        eof = true;
        return;
      }
      drain(res.value);
      pump();
    });
  };
  pump();

  // An open session is answered when the frame count is met; a piped batch is
  // answered when the stream ENDS, because the server exits once it has drained.
  const answered = (): boolean => (opts.hangUpFirst ? eof : lines.length >= expected);
  const deadline = Date.now() + timeoutMs;
  while (!answered() && Date.now() < deadline) {
    await Promise.race([pending, Bun.sleep(250)]);
  }
  const timedOutSession = !answered();
  if (!opts.hangUpFirst) proc.stdin.end();
  await pending.catch(() => {});
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  if (timedOutSession) {
    proc.kill("SIGKILL");
    throw new Error(`mcp session did not answer ${expected} frames within ${timeoutMs}ms`);
  }
  const responses = new Map<number, Frame>();
  for (const line of lines) {
    // Purity first: one stray console.log from the analyser would make every
    // assertion below meaningless, so a non-JSON line fails here, loudly.
    let msg: Frame & { id?: number | string | null };
    try {
      msg = JSON.parse(line) as Frame & { id?: number | string | null };
    } catch {
      throw new Error(`stdout carried a non-frame: ${line.slice(0, 160)}`);
    }
    if (msg.result === undefined && msg.error === undefined) {
      throw new Error(`frame with neither result nor error: ${line.slice(0, 120)}`);
    }
    if (typeof msg.id === "number") responses.set(msg.id, msg);
  }
  return { lines, responses, stderr, code };
}

function frame(s: Session, id: number): Frame {
  const msg = s.responses.get(id);
  if (!msg) throw new Error(`no frame for id ${id}; stdout was:\n${s.lines.join("\n")}`);
  return msg;
}

function result(s: Session, id: number): unknown {
  const msg = frame(s, id);
  if (msg.error) throw new Error(`id ${id} errored: ${msg.error.message}`);
  return msg.result;
}

function mustError(s: Session, id: number): { code: number; message: string } {
  const err = frame(s, id).error;
  if (!err) throw new Error(`id ${id} did not error`);
  return err;
}

function errorCode(s: Session, id: number): number {
  return mustError(s, id).code;
}

function text(s: Session, id: number): string {
  const res = result(s, id) as { content?: Array<{ type: string; text: string }> };
  const first = res.content?.[0];
  if (!first) throw new Error(`id ${id} carried no content`);
  return first.text;
}

function json<T>(s: Session, id: number): T {
  return JSON.parse(text(s, id)) as T;
}

function isErrorResult(s: Session, id: number): boolean {
  return (result(s, id) as { isError?: boolean }).isError === true;
}

function textOf(res: { content: Array<{ text: string }>; isError?: boolean }): string {
  const first = res.content[0];
  if (!first) throw new Error("tool result carried no content");
  return first.text;
}

/** Name → size + mtime for every file under a directory: cheap, and enough to
 *  catch a write a tool claimed it would not make. */
function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        walk(full);
        continue;
      }
      const st = statSync(full);
      out[path.relative(root, full)] = `${st.size}:${st.mtimeMs}`;
    }
  };
  walk(root);
  return out;
}
