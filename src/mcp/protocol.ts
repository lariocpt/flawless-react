// JSON-RPC 2.0 message layer for the MCP stdio transport.
//
// The wire contract (MCP stdio): one JSON message per line, `\n` delimited, no
// embedded newlines inside a message. This is the whole protocol surface
// flawless-react needs — hand-rolled because the shipped artifact is a compiled
// Bun binary whose bundle stays dependency-free, so the official SDK is not an
// option inside it (the same rule that keeps src/ free of imports in
// cliFlags.ts and docLine.ts).
//
// Honest framing: a line that is not valid JSON gets a -32700 response with
// id:null, exactly as JSON-RPC prescribes, and the connection keeps serving.
// Dropping it silently would let a partially-written message vanish without the
// client ever learning its call was never parsed — the false pass, in the one
// place where a pass is a frame the host is about to trust.

export type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };
export type JsonObject = { [k: string]: JsonValue };

export interface RpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: JsonObject;
}

export interface RpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: JsonObject;
}

/** parseLine's discriminated result: a frame is EITHER a parsed message OR the
 *  -32700/-32600 response the server owes the client — never a bag of optional
 *  fields the dispatcher has to guess through. */
export type ParsedLine =
  | { kind: "request"; request: RpcRequest }
  | { kind: "notification"; notification: RpcNotification }
  | { kind: "invalid"; response: RpcResponse };

export interface RpcError {
  code: number;
  message: string;
  data?: JsonValue;
}

export interface RpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: JsonValue;
  error?: RpcError;
}

// The standard JSON-RPC codes MCP hosts expect, plus the one MCP reserves for
// "the server understood and refuses" (used here for the not-initialized guard).
export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
export const INTERNAL_ERROR = -32603;
export const SERVER_NOT_INITIALIZED = -32002;

export function isRequest(v: unknown): v is RpcRequest {
  const o = v as Partial<RpcRequest> | null;
  return (
    typeof v === "object" &&
    o !== null &&
    o.jsonrpc === "2.0" &&
    typeof o.method === "string" &&
    (typeof o.id === "number" || typeof o.id === "string")
  );
}

export function isNotification(v: unknown): v is RpcNotification {
  const o = v as (Partial<RpcNotification> & { id?: unknown }) | null;
  return (
    typeof v === "object" &&
    o !== null &&
    o.jsonrpc === "2.0" &&
    typeof o.method === "string" &&
    o.id === undefined
  );
}

export function reply(id: number | string | null, result: JsonValue): RpcResponse {
  return { jsonrpc: "2.0", id, result };
}

export function fail(id: number | string | null, error: RpcError): RpcResponse {
  return { jsonrpc: "2.0", id, error };
}

/**
 * Parse one framed line into a discriminated result.
 *
 * A frame that is not valid JSON, or JSON without a string method, gets the
 * prescribed error response (id:null) rather than silent loss: the client must
 * learn its call was never understood.
 */
export function parseLine(line: string): ParsedLine {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return {
      kind: "invalid",
      response: fail(null, { code: PARSE_ERROR, message: "parse error: line is not valid JSON" }),
    };
  }
  if (isRequest(value)) return { kind: "request", request: value };
  if (isNotification(value)) return { kind: "notification", notification: value };
  return {
    kind: "invalid",
    response: fail(null, {
      code: INVALID_REQUEST,
      message: "expected a JSON-RPC 2.0 request or notification with a string method",
    }),
  };
}

export function serialize(message: RpcResponse): string {
  // JSON.stringify NEVER emits a raw newline, so one message is always one line
  // — the only framing rule this transport has.
  return `${JSON.stringify(message)}\n`;
}

// Reserved for genuine dispatch bugs; every handler path currently in server.ts
// has a defined answer, so nothing reaches it yet. Kept exported-and-void rather
// than deleted: the next method added needs the code, and a handler that has no
// answer owes -32603, not a thrown stack.
void INTERNAL_ERROR;
