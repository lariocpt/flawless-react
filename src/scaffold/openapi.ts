import type { MockRoute } from "../types.ts";

interface OpenApiSpec {
  openapi?: string;
  swagger?: string;
  paths?: Record<string, Record<string, OperationObject> | undefined>;
  components?: { schemas?: Record<string, unknown> };
  [k: string]: unknown;
}

interface OperationObject {
  responses?: Record<string, ResponseObject | undefined>;
  [k: string]: unknown;
}

interface ResponseObject {
  content?: Record<string, MediaTypeObject | undefined>;
  [k: string]: unknown;
}

interface MediaTypeObject {
  schema?: unknown;
  example?: unknown;
  examples?: Record<string, { value?: unknown } | undefined>;
}

const HTTP_METHODS = ["get", "post", "put", "patch", "delete", "options", "head"] as const;

export async function loadApiSpec(filePath: string): Promise<OpenApiSpec> {
  const file = Bun.file(filePath);
  if (!(await file.exists())) {
    throw new Error(`--api: spec not found at ${filePath}`);
  }
  const text = await file.text();
  const trimmed = text.trimStart();
  const looksJson = trimmed.startsWith("{") || trimmed.startsWith("[");
  let parsed: unknown;
  try {
    parsed = looksJson ? JSON.parse(text) : parseYaml(text);
  } catch (err) {
    throw new Error(`--api: failed to parse ${filePath}: ${(err as Error).message}`);
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`--api: ${filePath} did not parse to an object`);
  }
  const spec = parsed as OpenApiSpec;
  if (!spec.paths || typeof spec.paths !== "object") {
    throw new Error(`--api: ${filePath} has no 'paths' object`);
  }
  return spec;
}

function parseYaml(text: string): unknown {
  const yaml = (Bun as unknown as { YAML?: { parse: (s: string) => unknown } }).YAML;
  if (!yaml) {
    throw new Error(
      "YAML parsing requires Bun >= 1.2 (Bun.YAML.parse not found). Convert your spec to JSON first.",
    );
  }
  return yaml.parse(text);
}

export function extractRoutes(spec: OpenApiSpec): MockRoute[] {
  const out: MockRoute[] = [];
  for (const [pathTpl, methods] of Object.entries(spec.paths ?? {})) {
    if (!methods) continue;
    for (const method of HTTP_METHODS) {
      const op = methods[method];
      if (!op) continue;
      const picked = pickResponse(op);
      const body = synthesizeBody(picked.media, spec);
      out.push({
        method: method.toUpperCase(),
        path: pathTpl,
        status: picked.status,
        body,
      });
    }
  }
  return out;
}

function pickResponse(op: OperationObject): { status: number; media: MediaTypeObject | null } {
  const responses = op.responses ?? {};
  const keys = Object.keys(responses);
  const order: string[] = ["200", "201"];
  for (const k of keys) if (/^2\d\d$/.test(k) && !order.includes(k)) order.push(k);
  order.push("default");
  for (const k of keys) if (!order.includes(k)) order.push(k);
  for (const k of order) {
    const r = responses[k];
    if (!r) continue;
    return { status: parseStatus(k), media: pickMedia(r) };
  }
  return { status: 200, media: null };
}

function parseStatus(key: string): number {
  if (key === "default") return 200;
  const n = parseInt(key, 10);
  return Number.isFinite(n) ? n : 200;
}

function pickMedia(res: ResponseObject): MediaTypeObject | null {
  const content = res.content;
  if (!content) return null;
  if (content["application/json"]) return content["application/json"];
  for (const v of Object.values(content)) if (v) return v;
  return null;
}

function synthesizeBody(media: MediaTypeObject | null, spec: OpenApiSpec): unknown {
  if (!media) return null;
  if ("example" in media && media.example !== undefined) return media.example;
  if (media.examples) {
    for (const ex of Object.values(media.examples)) {
      if (ex && "value" in ex) return ex.value;
    }
  }
  if (media.schema !== undefined) return generateFromSchema(media.schema, spec, new Set());
  return null;
}

function generateFromSchema(schema: unknown, spec: OpenApiSpec, visited: Set<string>): unknown {
  if (!schema || typeof schema !== "object") return null;
  const s = schema as Record<string, unknown>;

  if (typeof s.$ref === "string") {
    if (visited.has(s.$ref)) return null;
    const resolved = resolveRef(s.$ref, spec);
    if (!resolved) return null;
    const next = new Set(visited);
    next.add(s.$ref);
    return generateFromSchema(resolved, spec, next);
  }

  if ("example" in s && s.example !== undefined) return s.example;
  if (Array.isArray(s.enum) && s.enum.length > 0) return s.enum[0];

  if (Array.isArray(s.allOf)) {
    const merged: Record<string, unknown> = {};
    for (const branch of s.allOf) {
      const value = generateFromSchema(branch, spec, visited);
      if (value && typeof value === "object" && !Array.isArray(value)) Object.assign(merged, value);
    }
    return merged;
  }

  switch (s.type) {
    case "array":
      return [generateFromSchema(s.items, spec, visited)].filter((v) => v !== null);
    case "object": {
      const obj: Record<string, unknown> = {};
      const props = s.properties as Record<string, unknown> | undefined;
      if (props) {
        for (const [k, v] of Object.entries(props)) obj[k] = generateFromSchema(v, spec, visited);
      }
      return obj;
    }
    case "string":
      return s.format === "date-time" ? new Date(0).toISOString() : "";
    case "integer":
    case "number":
      return 0;
    case "boolean":
      return false;
    case "null":
      return null;
    default:
      return null;
  }
}

function resolveRef(ref: string, spec: OpenApiSpec): unknown {
  if (!ref.startsWith("#/")) return null;
  const parts = ref.slice(2).split("/");
  let cur: unknown = spec;
  for (const p of parts) {
    if (!cur || typeof cur !== "object") return null;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}
