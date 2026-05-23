import type { NextjsApiRoute } from "../types.ts";

export function renderMswHandlers(routes: NextjsApiRoute[]): string {
  const lines: string[] = [];
  lines.push(`// MSW request handlers derived from your Next.js API routes.`);
  lines.push(`// Replace the empty response bodies with realistic fixtures, or wire a route to`);
  lines.push(`// inspect the request and respond conditionally. Edit freely — flawless-react will`);
  lines.push(`// not overwrite this file once it exists.`);
  lines.push(``);
  lines.push(`import { http, HttpResponse } from "msw";`);
  lines.push(``);
  lines.push(`export const handlers = [`);
  for (const r of routes) {
    const mswPath = toMswPath(r.path);
    for (const m of r.methods) {
      const verb = m.toLowerCase();
      lines.push(`  http.${verb}(${JSON.stringify(mswPath)}, () => HttpResponse.json({})),`);
    }
  }
  lines.push(`];`);
  lines.push(``);
  return lines.join("\n");
}

function toMswPath(p: string): string {
  // OpenAPI-style {id} → MSW :id.
  return p.replace(/\{([^}]+)\}/g, ":$1");
}

export function renderBrowserSetup(): string {
  return `import { setupWorker } from "msw/browser";
import { handlers } from "./handlers.ts";

export const worker = setupWorker(...handlers);

export async function startMockWorker(): Promise<void> {
  await worker.start({ onUnhandledRequest: "bypass", quiet: true });
}
`;
}

export function renderNodeSetup(): string {
  return `import { setupServer } from "msw/node";
import { handlers } from "./handlers.ts";

export const server = setupServer(...handlers);
`;
}
