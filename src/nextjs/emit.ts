import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { classifyStamped, hashBody, stamp } from "../scaffold-tests/stamp.ts";
import type { NextjsApiRoute, NextjsContext } from "../types.ts";
import { renderBrowserSetup, renderMswHandlers, renderNodeSetup } from "./mswHandlers.ts";
import { buildSwagger } from "./swagger.ts";

export interface EmitNextjsResult {
  written: string[];
  swaggerPath: string;
  handlersPath: string;
  /** What happened to handlers.ts this run, phrased for the run summary. */
  handlersReport: string;
  /** `http.*` handlers in the handlers.ts now on disk — a kept file counts as-is. */
  handlersEmitted: number;
  /** Paths in the swagger.json this run wrote. */
  specPaths: number;
}

export interface EmitNextjsOptions {
  /** When present, written verbatim to swagger.json instead of buildSwagger(routes). */
  liveSpec?: unknown;
  /**
   * Refresh the generated files here that hold nothing of the user's.
   *
   * handlers.ts is regenerated under --force even when hand-edited — that is
   * the escape hatch its kept-reports name. Without --force it is only
   * rewritten when the spec changed and the file still matches its generated
   * stamp (see emitHandlers). browser.ts, node.ts and the README are
   * boilerplate, and freezing them meant an existing suite could never
   * receive a later version's fix.
   */
  force?: boolean;
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
  const swaggerText = `${JSON.stringify(swagger, null, 2)}\n`;
  await Bun.write(swaggerPath, swaggerText);
  written.push(swaggerPath);

  const handlers = await emitHandlers(
    handlersPath,
    ctx.apiRoutes,
    hashBody(swaggerText),
    opts.force === true,
  );
  if (handlers.written) written.push(handlersPath);

  if (!existsSync(browserPath) || opts.force) {
    await Bun.write(browserPath, renderBrowserSetup());
    written.push(browserPath);
  }

  if (!existsSync(nodePath) || opts.force) {
    await Bun.write(nodePath, renderNodeSetup());
    written.push(nodePath);
  }

  if (!existsSync(readmePath) || opts.force) {
    await Bun.write(readmePath, renderMocksReadme(ctx));
    written.push(readmePath);
  }

  const onDisk = await readFile(handlersPath, "utf8");
  return {
    written,
    swaggerPath,
    handlersPath,
    handlersReport: handlers.report,
    handlersEmitted: (onDisk.match(/http\.\w+\(/g) ?? []).length,
    specPaths: countSpecPaths(swagger),
  };
}

/**
 * The spec digest line sits BELOW the provenance stamp, inside the hashed body.
 * That placement is the compatibility contract: STAMP_RE is untouched, so a
 * file stamped by 0.3.1 still classifies exactly as it used to; the host's
 * formatter cannot lose a comment; and restampGenerated re-hashes the stamp
 * line after formatting while preserving everything below it.
 */
const SPEC_DIGEST_RE = /^\/\/ @flawless-spec sha256:([0-9a-f]{16})/m;

/**
 * The handlers.ts write-once rule, upgraded from "file exists" to provenance.
 *
 * "File exists" was a trap: `--api` refreshed swagger.json but never the
 * handlers generated from the old AST walk, so a project that ran once before
 * it had a real spec kept a useless catch-all stub forever, silently. The
 * contract now — and every branch except "created" and "regenerated" leaves
 * the file byte-identical:
 *
 * - absent                        → created
 * - --force                       → regenerated (the named escape hatch)
 * - stamp mismatch (hand-edited)  → kept; --force or delete to regenerate
 * - no stamp at all (0.3.1 file, hand-written, or stamp deleted) → kept, always
 * - untouched, same spec digest   → kept
 * - untouched, spec digest moved  → regenerated from a newer spec
 * - untouched, stamped before spec digests existed → kept (digest unknowable)
 */
async function emitHandlers(
  handlersPath: string,
  routes: NextjsApiRoute[],
  specDigest: string,
  force: boolean,
): Promise<{ written: boolean; report: string }> {
  const render = () =>
    stamp(`// @flawless-spec sha256:${specDigest}\n${renderMswHandlers(routes)}`);
  if (!existsSync(handlersPath)) {
    await Bun.write(handlersPath, render());
    return { written: true, report: "created" };
  }
  if (force) {
    await Bun.write(handlersPath, render());
    return { written: true, report: "regenerated (--force)" };
  }
  const text = await readFile(handlersPath, "utf8");
  switch (classifyStamped(text)) {
    case "stampless":
      return {
        written: false,
        report:
          "kept (no provenance stamp — hand-written or from before stamping) — regenerate with --force or delete it",
      };
    case "edited":
      return {
        written: false,
        report: "kept (hand-edited) — regenerate with --force or delete it",
      };
    default: {
      const digest = text.match(SPEC_DIGEST_RE)?.[1];
      if (digest === undefined) {
        return {
          written: false,
          report:
            "kept (stamped before spec digests existed) — regenerate with --force or delete it",
        };
      }
      if (digest !== specDigest) {
        await Bun.write(handlersPath, render());
        return { written: true, report: "regenerated from a newer spec" };
      }
      return { written: false, report: "kept" };
    }
  }
}

function countSpecPaths(swagger: unknown): number {
  const paths = (swagger as { paths?: unknown } | null)?.paths;
  return typeof paths === "object" && paths !== null ? Object.keys(paths).length : 0;
}

function renderMocksReadme(ctx: NextjsContext): string {
  return `# MSW mocks

Derived from your Next.js \`${ctx.router}\` router's \`api/\` directory at scaffold time.

- \`handlers.ts\` — one MSW handler per HTTP method × API route. **Edit freely** — a re-run keeps your edits: it regenerates this file only when the API spec changed and the file still matches its generated stamp, or when you pass \`--force\`. A file with no provenance stamp (hand-written or from an older version) is always kept — delete it to regenerate.
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
