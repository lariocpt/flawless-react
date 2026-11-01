import type { NextjsApiRoute } from "../types.ts";

export function renderMswHandlers(routes: NextjsApiRoute[]): string {
  const lines: string[] = [];
  lines.push(`// MSW request handlers derived from your Next.js API routes.`);
  lines.push(
    `// Bodies come from the live OpenAPI spec when available (examples > schema defaults);`,
  );
  lines.push(`// otherwise an empty object. Edit freely — a re-run keeps your edits; it`);
  lines.push(`// regenerates this file only when the API spec changed and the file is still`);
  lines.push(`// untouched, or under --force. No stamp (hand-written or pre-stamp)? Always`);
  lines.push(`// kept — delete it to regenerate.`);
  lines.push(``);
  lines.push(`import { http, HttpResponse } from "msw";`);
  lines.push(``);
  lines.push(`export const handlers = [`);
  for (const r of routes) {
    const mswPath = toMswPath(r.path);
    for (const m of r.methods) {
      const verb = m.toLowerCase();
      const body = r.responseBodies?.[m.toUpperCase()] ?? r.responseBodies?.[m] ?? {};
      const bodyLiteral = JSON.stringify(body);
      lines.push(
        `  http.${verb}(${JSON.stringify(mswPath)}, () => HttpResponse.json(${bodyLiteral})),`,
      );
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
import { handlers } from "./handlers";

export const worker = setupWorker(...handlers);

export async function startMockWorker(): Promise<void> {
  await worker.start({ onUnhandledRequest: "bypass", quiet: true });
}
`;
}

export function renderNodeSetup(): string {
  return `import { setupServer } from "msw/node";
import { handlers } from "./handlers";

export const server = setupServer(...handlers);
`;
}
