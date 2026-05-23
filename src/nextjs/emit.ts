import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { NextjsContext } from "../types.ts";
import { renderBrowserSetup, renderMswHandlers, renderNodeSetup } from "./mswHandlers.ts";
import { buildSwagger } from "./swagger.ts";

export interface EmitNextjsResult {
  written: string[];
  swaggerPath: string;
  handlersPath: string;
}

export interface EmitNextjsOptions {
  /** When present, written verbatim to swagger.json instead of buildSwagger(routes). */
  liveSpec?: unknown;
}

export async function emitNextjsMocks(
  ctx: NextjsContext,
  outDir: string,
  opts: EmitNextjsOptions = {},
): Promise<EmitNextjsResult> {
  const mocksDir = path.join(outDir, "mocks");
  await mkdir(mocksDir, { recursive: true });

  const swaggerPath = path.join(outDir, "swagger.json");
  const handlersPath = path.join(mocksDir, "handlers.ts");
  const browserPath = path.join(mocksDir, "browser.ts");
  const nodePath = path.join(mocksDir, "node.ts");
  const readmePath = path.join(mocksDir, "README.md");

  const written: string[] = [];

  const swagger = opts.liveSpec ?? buildSwagger(ctx.apiRoutes, path.basename(ctx.root));
  await Bun.write(swaggerPath, `${JSON.stringify(swagger, null, 2)}\n`);
  written.push(swaggerPath);

  if (!existsSync(handlersPath)) {
    // Don't clobber user edits — handlers are a starting point.
    await Bun.write(handlersPath, renderMswHandlers(ctx.apiRoutes));
    written.push(handlersPath);
  }

  if (!existsSync(browserPath)) {
    await Bun.write(browserPath, renderBrowserSetup());
    written.push(browserPath);
  }

  if (!existsSync(nodePath)) {
    await Bun.write(nodePath, renderNodeSetup());
    written.push(nodePath);
  }

  if (!existsSync(readmePath)) {
    await Bun.write(readmePath, renderMocksReadme(ctx));
    written.push(readmePath);
  }

  return { written, swaggerPath, handlersPath };
}

function renderMocksReadme(ctx: NextjsContext): string {
  return `# MSW mocks

Derived from your Next.js \`${ctx.router}\` router's \`api/\` directory at scaffold time.

- \`handlers.ts\` — one MSW handler per HTTP method × API route. **Edit freely** — once this file exists, flawless-react won't overwrite it.
- \`browser.ts\` — \`setupWorker(...handlers)\` for the Bun host bundle (catches client-side \`fetch\`).
- \`node.ts\` — \`setupServer(...handlers)\` for Vitest (jsdom) and any Node-side fetch (RSC, server actions).
- \`../swagger.json\` — human-readable OpenAPI doc derived from your routes. Regenerated every run.

## How the layers wire up

1. **Vitest unit tests** — \`setupServer\` from \`node.ts\` runs in \`flawless/setup.ts\`; any \`fetch\` called from a component renders against your mock responses.
2. **Playwright browser specs + perf harness** — \`host/main.tsx\` calls \`startMockWorker()\` from \`browser.ts\` before mounting; the service worker intercepts \`fetch\` from the page.
3. **Next.js SSR / server components / server actions** — when you run against a real Next dev server, configure your Next instrumentation to import \`./node.ts\` to intercept server-side fetches too.

## Adding realistic data

Replace \`HttpResponse.json({})\` in a handler with a real fixture:

\`\`\`ts
http.get("/api/users", () =>
  HttpResponse.json([{ id: 1, name: "Alice" }, { id: 2, name: "Bob" }])
),
\`\`\`

For conditional responses, inspect the request:

\`\`\`ts
http.get("/api/users/:id", ({ params }) => {
  if (params.id === "999") return new HttpResponse(null, { status: 404 });
  return HttpResponse.json({ id: Number(params.id), name: "Alice" });
}),
\`\`\`
`;
}
