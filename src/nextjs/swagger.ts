import type { NextjsApiRoute } from "../types.ts";

export function buildSwagger(routes: NextjsApiRoute[], projectName: string): unknown {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const r of routes) {
    const ops: Record<string, unknown> = paths[r.path] ?? {};
    for (const m of r.methods) {
      ops[m.toLowerCase()] = {
        summary: `${m} ${r.path}`,
        responses: {
          "200": {
            description: "OK",
            content: {
              "application/json": {
                example: {},
              },
            },
          },
        },
      };
    }
    paths[r.path] = ops;
  }
  return {
    openapi: "3.0.0",
    info: {
      title: `${projectName} — derived from Next.js API routes`,
      version: "0.0.0",
    },
    paths,
  };
}
