// Shared plumbing for the MCP tool surface: result shapes, argument accessors
// that fail loudly, and output caps that are always ANNOUNCED.
//
// Why the readers reject instead of coercing: an agent that typos `run_tests` as
// `runTests` would otherwise get a run that silently skipped the suites and
// reported it green — the exact false pass this repo scores itself on removing.
// Same reasoning as parseArgs' `unknown flag` branch: an option that did nothing
// is worse than a refusal, because the caller keeps believing it took effect.
//
// Why the caps announce themselves: a silent cut turns "the last 256KB of a 4MB
// run log" into "the whole run log", and the reader has no way to tell.

import path from "node:path";
import type { JsonObject, JsonValue } from "./protocol.ts";

export interface ToolContent {
  type: "text";
  text: string;
}

export interface ToolResult {
  content: ToolContent[];
  isError?: boolean;
}

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: JsonObject;
  run(args: JsonObject): Promise<ToolResult>;
}

/** Argument misuse and honest failures. The server turns these into an `isError`
 *  tool result (MCP's contract for "the tool ran and said no"); protocol-layer
 *  misuse (unknown tool, malformed params) stays a JSON-RPC error, per spec. */
export class ToolError extends Error {}

export function ok(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

export function fail(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

/** A structured answer. Tool content is a text channel, so the JSON IS the
 *  payload — every read-plane tool returns it this way rather than inventing a
 *  prose shape the caller would have to regex. */
export function okJson(value: JsonValue): ToolResult {
  return ok(JSON.stringify(value, null, 2));
}

/** Per-stream cap on captured child output. Tail-kept, because the tail of a run
 *  is where the failure is, and the marker states the total. */
export const OUTPUT_CAP = 256 * 1024;

export function capText(s: string, cap = OUTPUT_CAP): { text: string; truncated: boolean } {
  if (s.length <= cap) return { text: s, truncated: false };
  return {
    text:
      `… flawless-mcp: output truncated, showing last ${cap} of ${s.length} chars …\n` +
      s.slice(-cap),
    truncated: true,
  };
}

/**
 * How many entry files a read-plane tool analyses in one call, and its ceiling.
 *
 * A glob over a whole app is hundreds of files and each one is a TypeScript
 * parse, so an unbounded read tool is a request that cannot be answered. The
 * default is a generous sample; hitting the cap is REPORTED (`entries_skipped`)
 * rather than quietly narrowed — "findings for 50 components" must never read as
 * "this app has 50 components".
 */
export const DEFAULT_MAX_ENTRIES = 50;
export const MAX_ENTRIES_LIMIT = 500;

// ------------------------------------------------------------ arg reading ----

function bad(name: string, want: string, got: unknown): never {
  const shown = typeof got === "string" ? JSON.stringify(got) : String(got);
  throw new ToolError(`invalid argument "${name}": expected ${want}, got ${shown}`);
}

/** Required string, non-empty after trimming. */
export function reqStr(args: JsonObject, name: string): string {
  const v = args[name];
  if (typeof v !== "string" || !v.trim()) bad(name, "non-empty string", v);
  return v as string;
}

export function optStr(args: JsonObject, name: string): string | undefined {
  const v = args[name];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string" || !v.trim()) bad(name, "non-empty string", v);
  return v as string;
}

export function optInt(
  args: JsonObject,
  name: string,
  min: number,
  max: number,
): number | undefined {
  const v = args[name];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) {
    bad(name, `integer ${min}..${max}`, v);
  }
  return v as number;
}

export function optBool(args: JsonObject, name: string): boolean | undefined {
  const v = args[name];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "boolean") bad(name, "boolean", v);
  return v as boolean;
}

/** One value from a closed set. The rejection lists the choices, because a
 *  caller that has never seen the schema is exactly the one that needs them. */
export function optEnum<X extends string>(
  args: JsonObject,
  name: string,
  choices: readonly X[],
): X | undefined {
  const v = args[name];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string" || !choices.includes(v as X)) {
    bad(name, `one of: ${choices.join(", ")}`, v);
  }
  return v as X;
}

export function reqEnum<X extends string>(
  args: JsonObject,
  name: string,
  choices: readonly X[],
): X {
  const v = optEnum(args, name, choices);
  if (v === undefined) throw new ToolError(`missing required argument "${name}"`);
  return v;
}

/** A string array whose members must all belong to a closed set (task ids,
 *  severities). Members are checked one by one so the rejection names the bad
 *  one instead of the whole array. */
export function optEnumArray<X extends string>(
  args: JsonObject,
  name: string,
  choices: readonly X[],
): X[] | undefined {
  const v = args[name];
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v)) bad(name, `array of: ${choices.join(", ")}`, v);
  return (v as unknown[]).map((item) => {
    if (typeof item !== "string" || !choices.includes(item as X)) {
      throw new ToolError(
        `invalid "${name}" member: expected one of ${choices.join(", ")}, got ${JSON.stringify(item)}`,
      );
    }
    return item as X;
  });
}

export function optStrArray(args: JsonObject, name: string): string[] | undefined {
  const v = args[name];
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) bad(name, "array of strings", v);
  return v as string[];
}

/** Flat string map (env vars). Rejects non-string values loudly: stringifying
 *  `{…}` into "[object Object]" would poison a run whose failure the caller
 *  then cannot explain. */
export function optStrMap(args: JsonObject, name: string): Record<string, string> | undefined {
  const v = args[name];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "object" || Array.isArray(v)) bad(name, "object of string values", v);
  const out: Record<string, string> = {};
  for (const [k, item] of Object.entries(v as JsonObject)) {
    if (typeof item !== "string") {
      throw new ToolError(`invalid "${name}.${k}": expected string, got ${String(item)}`);
    }
    out[k] = item;
  }
  return out;
}

/**
 * A JSON object, returned as JSON text — used once, for `flawless_reference`,
 * where the point is that the caller parses it.
 *
 * Kept out of the flags mapping on purpose: the value the CLI receives for
 * `--props` is JSON text, and re-serialising a parsed copy would put a second,
 * drift-prone copy of that contract between the agent and parsePropsJson.
 */
export function optJsonText(args: JsonObject, name: string): string | undefined {
  const v = args[name];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "object") bad(name, "JSON object", v);
  return JSON.stringify(v);
}

/**
 * String OR true — the shape `nextjs`/`expo` take, mirroring the flags' own
 * optional value (`--nextjs` alone means the current directory, `--nextjs <p>`
 * names a root). A bare `true` is accepted so a caller that read the schema as
 * "boolean" is not refused for expressing the same intent.
 */
export function optStrOrTrue(args: JsonObject, name: string): string | true | undefined {
  const v = args[name];
  if (v === undefined || v === null) return undefined;
  if (v === true) return true;
  if (typeof v !== "string" || !v.trim()) bad(name, "path string or true", v);
  return v as string;
}

/**
 * Unknown keys are rejected, not ignored, and required keys are checked first.
 *
 * The schema already says `additionalProperties: false`, but a host is free to
 * send what it likes, and a server that quietly drops `{"run_test": true}` has
 * just reported a green suite for a run that never executed one.
 */
export function requireKeys(
  args: JsonObject,
  allowed: readonly string[],
  required: readonly string[] = [],
): void {
  for (const name of required) {
    if (args[name] === undefined || args[name] === null) {
      throw new ToolError(`missing required argument "${name}"`);
    }
  }
  for (const key of Object.keys(args)) {
    if (!allowed.includes(key)) {
      throw new ToolError(`unknown argument "${key}" — allowed: ${allowed.join(", ")}`);
    }
  }
}

// ------------------------------------------------------------- path roots ----

/**
 * The project directory a call operates on, absolute.
 *
 * Every path argument is resolved against this instead of the server changing
 * its own working directory: one agent driving two repositories must be able to
 * point calls at different roots without the second call silently reading the
 * first one's files.
 */
export function rootArg(args: JsonObject): string {
  return path.resolve(optStr(args, "root") ?? ".");
}

/** Resolve a caller-supplied path against the call's root. */
export function resolveIn(root: string, p: string): string {
  return path.isAbsolute(p) ? path.normalize(p) : path.resolve(root, p);
}

/** A path made relative to the call's root, so output is stable across machines
 *  and the caller is not asked to read absolute filesystem noise. */
export function relativeTo(root: string, p: string): string {
  const rel = path.relative(root, p);
  return rel && !rel.startsWith("..") ? rel : p;
}
