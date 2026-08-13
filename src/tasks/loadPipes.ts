import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { pageFileToRoute } from "../nextjs/routes.ts";
import type { ComponentTree, RunContext, Task, TaskResult } from "../types.ts";

/**
 * Emit-only crust load pipes: page routes plus the API routes the analysed
 * components actually fetch. Mirrors the CI-gate conventions from crust's
 * docs — one assert per threshold, baseline comparison via stats --out.
 * Works without crust on PATH (files are emitted; running them needs crust).
 */
export const loadPipes: Task = {
  id: "load",
  label: "Generate crust load pipes",
  description: "Load-test pipes for analysed routes + their API calls (crust)",
  needsTree: true,
  async run(ctx: RunContext): Promise<TaskResult> {
    if (!ctx.nextjs) {
      return {
        id: "load",
        ok: false,
        outputs: [],
        findings: [],
        summary: "load task requires --nextjs mode",
        error: "not a Next.js run",
      };
    }

    const loadDir = path.join(ctx.outDir, "load");
    await mkdir(loadDir, { recursive: true });
    const written: string[] = [];

    const routerRoot = findRouterRoot(ctx.nextjs.root);
    const targets = collectTargets(ctx.trees, ctx.nextjs.router, routerRoot);

    const pipesPath = path.join(loadDir, "routes.pipes");
    if (!existsSync(pipesPath) || ctx.force) {
      await Bun.write(pipesPath, renderPipes(targets, ctx.outDir, ctx.nextjs.root));
      written.push(pipesPath);
    }

    const readmePath = path.join(loadDir, "README.md");
    if (!existsSync(readmePath)) {
      await Bun.write(readmePath, loadReadme());
      written.push(readmePath);
    }

    const crustPresent = Bun.which("crust") !== null;
    return {
      id: "load",
      ok: true,
      outputs: written,
      findings: [],
      summary: crustPresent
        ? `load pipes for ${targets.length} target(s) — run with bun run flawless:load`
        : `load pipes for ${targets.length} target(s) — crust not found on PATH; install it to run them`,
    };
  },
};

interface LoadTarget {
  name: string;
  /** URL path with $VARS for dynamic segments. */
  urlPath: string;
}

function findRouterRoot(nextRoot: string): string {
  for (const rel of ["app", "src/app", "pages", "src/pages"]) {
    const abs = path.join(nextRoot, rel);
    if (existsSync(abs)) return abs;
  }
  return nextRoot;
}

function collectTargets(
  trees: ComponentTree[],
  router: "app" | "pages",
  routerRoot: string,
): LoadTarget[] {
  const out: LoadTarget[] = [];
  const seen = new Set<string>();
  const add = (name: string, urlPath: string): void => {
    if (seen.has(urlPath)) return;
    seen.add(urlPath);
    out.push({ name, urlPath });
  };

  for (const tree of trees) {
    const route = pageFileToRoute(tree.entry.filePath, router, routerRoot);
    if (route) {
      let p = route.urlPath;
      for (const param of route.params) {
        p = p.replace(`[...${param}]`, `$LOAD_${param.toUpperCase()}`);
        p = p.replace(`[${param}]`, `$LOAD_${param.toUpperCase()}`);
      }
      add(route.specStem, p);
    }
    // API routes the UI actually calls (GET only — load-testing mutations by
    // default would write junk into the target DB).
    const walk = (t: ComponentTree): void => {
      for (const f of t.entry.fetchCalls ?? []) {
        if (f.method !== "GET") continue;
        let p = f.urlTemplate;
        for (const hole of f.holes) {
          p = p.replace(`:${hole}`, `$LOAD_${hole.toUpperCase()}`);
        }
        add(slugify(p), p);
      }
      for (const c of t.children) walk(c);
    };
    walk(tree);
  }
  return out;
}

function slugify(p: string): string {
  return (
    p
      .replace(/\$LOAD_[A-Z0-9_]+/g, "x")
      .replace(/[^a-zA-Z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "root"
  );
}

function renderPipes(targets: LoadTarget[], outDir: string, nextRoot: string): string {
  const rel = path.relative(nextRoot, outDir).split(path.sep).join("/");
  const lines = targets.map((t) => {
    const statsOut = `${rel}/load/last-${t.name}.json`;
    const baseline = `${rel}/load/baseline-${t.name}.json`;
    return (
      `load 10s 50/s | parallel 16 | GET $LOAD_BASE${t.urlPath} -H "$LOAD_AUTH" --timeout 2s | expect 200 ` +
      `| stats --out ${statsOut} ` +
      `| assert (async s => { const b = Bun.file("${baseline}"); return !(await b.exists()) || s.p95 < 2 * (await b.json()).summary.p95 })`
    );
  });
  return `# flawless-react load pipes — generated from the analysed component tree.
# Env contract (export before running, or provide a crust setup module):
#   LOAD_BASE  — e.g. http://localhost:3001
#   LOAD_AUTH  — e.g. "authorization: Bearer <token>" (use "accept: */*" if none needed)
#   LOAD_<PARAM> — one per dynamic segment below (e.g. LOAD_ID, LOAD_BUILDINGID)
# Baseline gating: copy a good last-*.json to baseline-*.json; runs then fail
# when p95 degrades beyond 2x baseline. One assert per threshold.
# TODO(flawless): tune rate/duration to your app; add POST flows deliberately.

${lines.join("\n\n")}
`;
}

function loadReadme(): string {
  return `# flawless-react load pipes

Generated crust pipelines targeting the analysed pages and the GET API routes
their components fetch. Mutating endpoints are deliberately excluded — add
them by hand when you have a safe target environment.

Run: \`bun run flawless:load\` (crust must be installed — see the repo's crust
setup or https://github.com/lariocpt/crust).

Baselines: after a good run, copy \`last-<name>.json\` to \`baseline-<name>.json\`.
Subsequent runs fail when p95 exceeds 2x the baseline.

This file and routes.pipes are yours after generation — flawless-react will
not overwrite them (regenerate with --force).
`;
}
