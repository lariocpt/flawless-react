import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { findRouterRoot, pageFileToRoute } from "../nextjs/routes.ts";
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
    let keptPipes = false;
    if (!existsSync(pipesPath) || ctx.force) {
      await Bun.write(pipesPath, renderPipes(targets, ctx.outDir, ctx.nextjs.root));
      written.push(pipesPath);
    } else {
      keptPipes = true;
    }

    const envPath = path.join(loadDir, "env.sh");
    await Bun.write(envPath, loadEnvScript());
    written.push(envPath);

    const readmePath = path.join(loadDir, "README.md");
    if (!existsSync(readmePath)) {
      await Bun.write(readmePath, loadReadme());
      written.push(readmePath);
    }

    const crustPresent = Bun.which("crust") !== null || hasLocalCrust(ctx.nextjs.root);
    return {
      id: "load",
      ok: true,
      outputs: written,
      findings: [],
      summary: keptPipes
        ? `kept existing load/routes.pipes (--force to regenerate for ${targets.length} target(s))`
        : crustPresent
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

/** crust installed as a project dependency (bun run resolves node_modules/.bin). */
function hasLocalCrust(fromDir: string): boolean {
  let dir = path.resolve(fromDir);
  for (;;) {
    if (existsSync(path.join(dir, "node_modules", ".bin", "crust"))) return true;
    const parent = path.dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
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
#   LOAD_BASE  — e.g. http://localhost:3001. Point this at a PRODUCTION build
#                (bun run build && bun run start), not at next dev: the dev
#                server compiles routes on demand, so a load run against it
#                measures the compiler rather than the app.
#   LOAD_AUTH  — a header line, e.g. "cookie: session=<value>" for a cookie
#                session, or "authorization: Bearer <token>" for a token one.
#                Use "accept: */*" if the route needs no auth.
#   LOAD_<PARAM> — one per dynamic segment below (e.g. LOAD_ID, LOAD_BUILDINGID).
#                If you filled flawless/e2e/params.json for the e2e task, those
#                are the same ids — source flawless/load/env.sh to reuse them
#                instead of keeping a second copy that drifts.
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

Point \`LOAD_BASE\` at a PRODUCTION build — \`bun run build && bun run start\` —
not at \`next dev\`. The dev server compiles routes on demand, so the first
request to each one measures the compiler and every later one measures a warm
cache; neither is the number you want. Source \`env.sh\` for the ids, and set
\`LOAD_AUTH\` to a header line (\`cookie: session=…\`). Check that the header
actually authenticates before trusting a run: an unauthenticated request to a
dashboard route redirects to the login page, which answers 200, so the pipes
pass while measuring nothing.

Baselines: after a good run, copy \`last-<name>.json\` to \`baseline-<name>.json\`.
Subsequent runs fail when p95 exceeds 2x the baseline.

This file and routes.pipes are yours after generation — flawless-react will
not overwrite them (regenerate with --force).
`;
}

/**
 * Exports LOAD_<PARAM> from the ids already filled in for the e2e task.
 *
 * The load pipes and the e2e specs need the same seeded ids. Two hand-maintained
 * copies of the same eight UUIDs drift on the first change, and the drift is
 * silent — a load run against a stale id just reports a 404 rate.
 */
function loadEnvScript(): string {
  return `#!/usr/bin/env bash
# source flawless/load/env.sh
#
# Exports LOAD_<PARAM> for every id in flawless/e2e/params.json, so the load
# pipes and the e2e specs cannot disagree about which records they target.
# LOAD_BASE and LOAD_AUTH are yours to set; see README.md.
set -a
_params="$(cd "$(dirname "\${BASH_SOURCE[0]}")/../e2e" && pwd)/params.json"
if [ -f "$_params" ]; then
  while IFS="=" read -r _k _v; do
    [ -n "$_k" ] && [ -n "$_v" ] && export "LOAD_$(echo "$_k" | tr '[:lower:]' '[:upper:]')=$_v"
  done < <(
    # Defaults first, then per-route overrides — but only the ones actually
    # filled in. Every route entry starts as "", and an unfiltered merge would
    # let those blanks overwrite a default that IS set.
    jq -r '(.defaults // {}) + (reduce (.routes // {} | to_entries[]) as $r
             ({}; . + ($r.value | with_entries(select(.value != "")))))
           | to_entries[] | select(.value != "") | "\\(.key)=\\(.value)"' "$_params"
  )
else
  echo "flawless: no e2e/params.json — set LOAD_<PARAM> yourself" >&2
fi
set +a
`;
}
