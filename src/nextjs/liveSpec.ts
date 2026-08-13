import { extractRoutes } from "../scaffold/openapi.ts";
import type { NextjsApiRoute } from "../types.ts";

const DEFAULT_URL = "http://localhost:3000/api/docs";
const FETCH_TIMEOUT_MS = 1500;

export interface LiveSpecResult {
  ok: boolean;
  url: string;
  routes: NextjsApiRoute[] | undefined;
  rawSpec: unknown;
  error?: string;
}

export async function fetchLiveSwagger(explicitUrl: string | undefined): Promise<LiveSpecResult> {
  const url = explicitUrl ?? DEFAULT_URL;
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(url, { signal: ctl.signal, headers: { accept: "application/json" } });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      return { ok: false, url, routes: undefined, rawSpec: undefined, error: `HTTP ${res.status}` };
    }
    const ct = res.headers.get("content-type") ?? "";
    if (!ct.includes("application/json")) {
      return {
        ok: false,
        url,
        routes: undefined,
        rawSpec: undefined,
        error: `unexpected content-type: ${ct}`,
      };
    }
    const spec = (await res.json()) as Parameters<typeof extractRoutes>[0];
    const mockRoutes = extractRoutes(spec);
    const grouped = new Map<string, NextjsApiRoute>();
    for (const r of mockRoutes) {
      const key = r.path;
      const existing = grouped.get(key);
      if (existing) {
        if (!existing.methods.includes(r.method)) existing.methods.push(r.method);
        existing.responseBodies ??= {};
        existing.responseBodies[r.method] = r.body;
      } else {
        grouped.set(key, {
          path: key,
          methods: [r.method],
          file: "",
          responseBodies: { [r.method]: r.body },
        });
      }
    }
    return { ok: true, url, routes: [...grouped.values()], rawSpec: spec };
  } catch (err) {
    return { ok: false, url, routes: undefined, rawSpec: undefined, error: (err as Error).message };
  }
}
