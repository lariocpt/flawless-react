// The tool registry: one list, ordered the way `tools/list` should present it.
//
// Why the composition lives here and not in server.ts: the tool set is a claim
// about the product (docs/mcp.md and the README both name these eight), and
// tests/mcp.test.ts asserts that claim against THIS array. A registry the server
// assembled inline would be reachable only by speaking JSON-RPC at a live child,
// which is a heavier way to learn a name drifted than importing a constant.
//
// Order is the documentation order — the two tools that change something first,
// then the reference trio, then the three that read a project — so a host that
// lists tools in arrival order shows the same story the docs tell.

import { ANALYSIS_TOOLS } from "./analysisTools.ts";
import { INFO_TOOLS } from "./infoTools.ts";
import type { JsonObject, JsonValue } from "./protocol.ts";
import { RUN_TOOLS } from "./runTools.ts";
import { type ToolDef, ToolError, type ToolResult } from "./support.ts";

export const ALL_TOOLS: ToolDef[] = [...RUN_TOOLS, ...INFO_TOOLS, ...ANALYSIS_TOOLS];

/** The `tools/list` result body, in the shape MCP prescribes. */
export function toolsList(): JsonValue {
  return {
    tools: ALL_TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  };
}

export function toolByName(name: string): ToolDef | undefined {
  return ALL_TOOLS.find((t) => t.name === name);
}

/**
 * Run one tool after checking its arguments against the schema it publishes.
 *
 * The check belongs HERE, on the one path every call takes, and not inside each
 * tool: a schema is the contract a host codes against, so a key the schema does
 * not name must not be silently dropped on the floor. `{"run_test": true}` typoed
 * into `flawless_run` would otherwise return an exit 0 for a run that never
 * executed a suite — a false pass reached through the protocol. Checking centrally
 * is also what lets a tool that genuinely takes no arguments (`flawless_tasks`,
 * `flawless_reference`) stay a one-line `run()` and still refuse junk.
 *
 * Keys, presence and shape only. Value semantics — a task id that exists, a heap
 * mode in the closed set, an integer inside its range — stay with the argument
 * readers in support.ts, whose rejections name the allowed set; duplicating that
 * here would put a second, drift-prone copy of each contract in the way.
 */
export async function invokeTool(tool: ToolDef, args: JsonObject): Promise<ToolResult> {
  const props = tool.inputSchema.properties;
  const allowed =
    props !== undefined && typeof props === "object" && props !== null
      ? Object.keys(props as JsonObject)
      : [];
  const strict = tool.inputSchema.additionalProperties === false;
  const required = Array.isArray(tool.inputSchema.required) ? tool.inputSchema.required : [];

  for (const name of required) {
    if (typeof name !== "string") continue;
    if (args[name] === undefined || args[name] === null) {
      throw new ToolError(`missing required argument "${name}"`);
    }
  }
  for (const key of Object.keys(args)) {
    if (strict && !allowed.includes(key)) {
      throw new ToolError(
        `unknown argument "${key}" for ${tool.name} — allowed: ${allowed.length ? allowed.join(", ") : "none"}`,
      );
    }
  }
  return tool.run(args);
}
