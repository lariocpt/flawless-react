import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { outDirRel, underOutDir } from "../emitPaths.ts";
import { findRouterRoot, pageFileToRoute } from "../nextjs/routes.ts";
import type { ComponentTree, RunContext, Task, TaskResult } from "../types.ts";
import { ensureParamDefaults } from "./e2eRoutes.ts";
import { runExpoLoad } from "./loadExpo.ts";

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
    // The wave-3/5/6 shape: one TaskId, a sibling engine per platform. An Expo
    // app has no server-rendered page routes to GET, so the native engine emits
    // API pipes only — from the endpoints the screens reach through the app's
    // fetch wrapper (ComponentInfo.apiCalls). B-16 wave 7.
    if (ctx.expo) return runExpoLoad(ctx);
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
    // Fallback for default Next.js mode where the entry glob is components/**,
    // so ctx.trees contains no page files. Discover pages directly so load
    // pipes still emit route targets.
    let trees = ctx.trees;
    const hasPage = trees.some((t) =>
      pageFileToRoute(t.entry.filePath, ctx.nextjs.router, routerRoot),
    );
    if (!hasPage) {
      const pageGlob = new Bun.Glob("**/page.{tsx,jsx,ts,js}");
      for await (const file of pageGlob.scan({ cwd: routerRoot, absolute: true })) {
        const route = pageFileToRoute(file, ctx.nextjs.router, routerRoot);
        if (!route) continue;
        const tree: ComponentTree = {
          entry: {
            componentName: "Page",
            filePath: file,
            importSpecifier: "",
            propsShape: {},
            variants: [],
            hooks: [],
            unresolvedProps: [],
          },
          children: [],
        };
        trees = [...trees, tree];
      }
    }
    const targets = collectTargets(trees, ctx.nextjs.router, routerRoot);

    // Every id these pipes reference gets a slot in params.json, including the
    // API-route ones the e2e task never sees (/api/buildings/[buildingId] beside
    // the page's /dashboard/buildings/[id]). Without the slot there is nowhere
    // to put the value, and the pipe silently requests a malformed URL.
    const paramsPath = path.join(ctx.outDir, "e2e", "params.json");
    const needed = [...new Set(targets.flatMap((t) => t.params))].sort();
    if (await ensureParamDefaults(paramsPath, needed)) written.push(paramsPath);

    // Which ids the user has actually filled in. A pipe whose parameters are
    // blank does not measure the route, it measures the app's 404 handler —
    // GET /invite/ with an empty token answered 500 on every one of 500
    // requests and was reported as the route failing. Silence is worse than a
    // comment: this way the file itself says which id is missing.
    const filled = await readFilledParams(paramsPath);

    const pipesPath = path.join(loadDir, "routes.pipes");
    let keptPipes = false;
    let pipesText: string;
    if (!existsSync(pipesPath)) {
      pipesText = renderPipes(targets, ctx.outDir, ctx.nextjs.root, filled);
      await Bun.write(pipesPath, pipesText);
      written.push(pipesPath);
    } else if (ctx.force) {
      // Merged, not overwritten. A tuned rate, a hand-added POST flow and a pipe
      // you commented out yourself cannot be recovered if lost, and --force is
      // the only way to turn a gated pipe back on — so it has to do both.
      pipesText = mergePipes(
        await Bun.file(pipesPath).text(),
        targets,
        ctx.outDir,
        ctx.nextjs.root,
        filled,
      );
      await Bun.write(pipesPath, pipesText);
      written.push(pipesPath);
    } else {
      pipesText = await Bun.file(pipesPath).text();
      keptPipes = true;
    }

    // Write-once, like the e2e global-setup stub: a hand-written module that
    // knows the app is better than this one, and a regeneration must never take
    // it. Absent, it IS written — so a suite that predates the guard gets it,
    // which a write-once file only manages because "absent" is the common case.
    const setupPath = path.join(loadDir, "routes.setup.ts");
    if (!existsSync(setupPath)) {
      await Bun.write(setupPath, renderLoadSetup(targets, outDirRel(ctx.outDir, ctx.nextjs.root)));
      written.push(setupPath);
    }

    const envPath = path.join(loadDir, "env.sh");
    await Bun.write(envPath, loadEnvScript(outDirRel(ctx.outDir, ctx.nextjs.root)));
    written.push(envPath);

    // Regenerated under --force, unlike routes.pipes beside it: this README is
    // generated prose with nothing of yours in it, so protecting it forever only
    // means existing installs never learn what a later version worked out — such
    // as that LOAD_BASE has to be a production build.
    const readmePath = path.join(loadDir, "README.md");
    if (!existsSync(readmePath) || ctx.force) {
      await Bun.write(readmePath, loadReadme());
      written.push(readmePath);
    }

    const crustPresent = Bun.which("crust") !== null || hasLocalCrust(ctx.nextjs.root);
    const tally = countPipes(pipesText);
    return {
      id: "load",
      ok: true,
      outputs: written,
      findings: [],
      summary: keptPipes
        ? `kept existing load/routes.pipes (--force to merge in ${targets.length} target(s))`
        : `load pipes for ${targets.length} target(s) — ${describeTally(tally, filled, targets)}${
            crustPresent ? " — run with bun run flawless:load" : " — crust not found on PATH"
          }`,
    };
  },
};

export interface PipeTally {
  live: number;
  gated: number;
  userCommented: number;
}

/**
 * What the file on disk actually measures, which is not `targets.length`.
 *
 * A gated pipe measures nothing, so counting it as a covered target is the same
 * mistake REPORT.md exists to prevent — this string is what lands in its Tasks
 * table.
 */
export function countPipes(text: string): PipeTally {
  const tally: PipeTally = { live: 0, gated: 0, userCommented: 0 };
  for (const item of parsePipes(text).body) {
    if (item.kind !== "pipe") continue;
    if (item.state === "live") tally.live += 1;
    else if (item.state === "gated") tally.gated += 1;
    else tally.userCommented += 1;
  }
  return tally;
}

export function describeTally(
  tally: PipeTally,
  filled: Set<string>,
  targets: LoadTarget[],
): string {
  const parts = [`${tally.live} live`];
  if (tally.gated > 0) {
    const ids = [...new Set(targets.flatMap((t) => missingParams(t, filled)))].sort();
    parts.push(`${tally.gated} commented out pending ids (${ids.join(", ")})`);
  }
  if (tally.userCommented > 0) parts.push(`${tally.userCommented} commented out by you`);
  return parts.join(", ");
}

export interface LoadTarget {
  name: string;
  /** URL path with $VARS for dynamic segments. */
  urlPath: string;
  /**
   * The dynamic segments this target needs, in the casing the source used.
   *
   * $LOAD_BUILDINGID cannot be turned back into `buildingId` — the shouting is
   * lossy — and params.json is keyed by the source name. Deriving the key from
   * the variable added a second, lowercased slot beside every existing one.
   */
  params: string[];
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

export function collectTargets(
  trees: ComponentTree[],
  router: "app" | "pages",
  routerRoot: string,
): LoadTarget[] {
  const out: LoadTarget[] = [];
  const seen = new Set<string>();
  const usedNames = new Set<string>();
  const add = (name: string, urlPath: string, params: string[]): void => {
    if (seen.has(urlPath)) return;
    seen.add(urlPath);
    // Two distinct routes can want the same name: slugify turns every dynamic
    // segment into a bare `x`, so /api/a/[p]/b and /api/a/[q]/b both arrive as
    // `api-a-x-b`. They would then share one last-*.json — each overwriting the
    // other's numbers — and the merge, which keys on this name, would treat the
    // second route as an update of the first and never emit a pipe for it.
    //
    // The first claimant keeps the plain name, so regenerating an existing suite
    // does not rename anything already on disk.
    let unique = name;
    for (let n = 2; usedNames.has(unique); n++) unique = `${name}-${n}`;
    usedNames.add(unique);
    out.push({ name: unique, urlPath, params });
  };

  for (const tree of trees) {
    const route = pageFileToRoute(tree.entry.filePath, router, routerRoot);
    if (route) {
      let p = route.urlPath;
      for (const param of route.params) {
        p = p.replace(`[...${param}]`, `$LOAD_${param.toUpperCase()}`);
        p = p.replace(`[${param}]`, `$LOAD_${param.toUpperCase()}`);
      }
      add(route.specStem, p, route.params);
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
        add(slugify(p), p, f.holes);
      }
      for (const c of t.children) walk(c);
    };
    walk(tree);
  }
  return out;
}

export function slugify(p: string): string {
  return (
    p
      .replace(/\$LOAD_[A-Z0-9_]+/g, "x")
      .replace(/[^a-zA-Z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "root"
  );
}

/**
 * The ids in e2e/params.json that hold a value.
 *
 * Written by the e2e task earlier in the same run, and merge-preserving across
 * runs, so by the time load renders its pipes this is exactly the set of
 * fixtures the user has supplied.
 */
export async function readFilledParams(paramsPath: string): Promise<Set<string>> {
  const out = new Set<string>();
  if (!existsSync(paramsPath)) return out;
  try {
    const parsed = (await Bun.file(paramsPath).json()) as {
      defaults?: Record<string, string>;
      routes?: Record<string, Record<string, string>>;
    };
    for (const [k, v] of Object.entries(parsed.defaults ?? {})) {
      if (typeof v === "string" && v !== "") out.add(k.toUpperCase());
    }
    for (const route of Object.values(parsed.routes ?? {})) {
      for (const [k, v] of Object.entries(route)) {
        if (typeof v === "string" && v !== "") out.add(k.toUpperCase());
      }
    }
  } catch {
    // Unreadable params.json: emit every pipe and let the run report the truth,
    // rather than commenting out the whole file over a parse error.
  }
  return out;
}

/** First line of a header this tool wrote — the signal that it may be refreshed. */
const HEADER_MARKER = "# flawless-react load pipes — generated from the analysed component tree.";
/** Prefix of the gate comment, which identifies a pipe as commented out BY the tool. */
const GATE_MARKER = "# TODO(flawless): no value for ";

/**
 * The ids a target needs that nothing has supplied.
 *
 * Compared in upper case, reported in the source's: `filled` is keyed by the
 * shouting form the pipe uses, but the fix a reader has to make is in
 * params.json, which is keyed by the name as written.
 */
export function missingParams(t: LoadTarget, filled: Set<string>): string[] {
  return t.params.filter((p) => !filled.has(p.toUpperCase()));
}

function renderPipeBody(t: LoadTarget, rel: string): string {
  const statsOut = `${rel}/load/last-${t.name}.json`;
  const baseline = `${rel}/load/baseline-${t.name}.json`;
  return (
    `load 10s 50/s | parallel 16 | GET $LOAD_BASE${t.urlPath} -H "$LOAD_AUTH" --timeout 2s | expect 200 ` +
    `| stats --out ${statsOut} ` +
    `| assert (async s => { const b = Bun.file("${baseline}"); return !(await b.exists()) || s.p95 < 2 * (await b.json()).summary.p95 })`
  );
}

/**
 * The routes the setup module can probe: static ones only.
 *
 * params.length === 0 also means urlPath carries no $VARS, so it is the literal
 * route path. A dynamic route is excluded because an unfilled id would read as
 * an auth failure; "/" because it redirects by design in most apps and would
 * fail before the user has had a chance to record where to.
 */
function guardTargets(targets: LoadTarget[]): LoadTarget[] {
  return targets.filter((t) => t.params.length === 0 && t.urlPath !== "/");
}

/**
 * The setup module crust imports before a single pipe runs.
 *
 * An expiring $LOAD_AUTH is THE failure mode of this plane, and it is silent.
 * crust follows redirects, so a dead session turns every route into the login
 * page answering 200: `expect 200` passes, `stats` reports healthy percentiles,
 * and the file goes green having measured a login form. Reproduced on a real
 * app — 20/20 status 200, p50 19.7ms, exit 0, every request served /login.
 *
 * Nothing downstream can see it. In load mode (`parallel N`) crust's record is
 * {status, ms, url} and that url is the REQUESTED one, byte-identical whether
 * the session is live or dead. Only a plain fetch shows where a request landed.
 *
 * A setup module rather than guard lines in routes.pipes: it fails once, before
 * anything is measured, instead of N times among the results — and the first
 * app to hit this had already been fixed BY HAND exactly this way, which is
 * where the shape comes from.
 *
 * Every static route is probed, not one. Nothing in the analysis says which
 * routes need a session, and an earlier cut of this picked a single static
 * route, drew /forgot-password on the dogfood app, and would have passed with a
 * dead cookie — a check that cannot fail. Dynamic routes are skipped: an
 * unfilled id would read as an auth failure.
 *
 * WRITE-ONCE. A hand-written module that knows the app (an authenticated
 * /api/me answering 401 is a sharper signal than a redirect) is strictly better
 * than this one, and no regeneration may overwrite it. Absent, it is written —
 * so suites that predate it do get the guard.
 */
export function renderLoadSetup(targets: LoadTarget[], rel: string): string {
  const routes = guardTargets(targets).map((t) => t.urlPath);
  return `// Setup module for routes.pipes. test-pipes imports the sibling
// <name>.setup.ts and awaits its default export before any line runs.
//
// Why: crust follows redirects, so an expired LOAD_AUTH turns every route into
// a login page answering 200 — "expect 200" passes, stats reports healthy
// percentiles, and the whole file goes green having measured a login form.
// Nothing downstream can see it: a load-mode record carries the REQUESTED url,
// not the landed one. So the check has to happen here, before any measurement.
//
// This file is written once and never regenerated. Replace it with a check that
// knows your app if you have a better signal — an authenticated endpoint
// answering 401 is sharper than a redirect — and nothing will overwrite yours.

/** Static routes only: a dynamic one with an unfilled id would look like an auth failure. */
const ROUTES: string[] = ${JSON.stringify(routes)};
/** Every route the pipes target, so "no ids" can be told from "no dynamic routes". */
const TOTAL_ROUTES = ${targets.length};

export default async () => {
	const base = process.env.LOAD_BASE;
	const auth = process.env.LOAD_AUTH;
	if (!base || !auth) {
		throw new Error(
			"routes.setup: LOAD_BASE and LOAD_AUTH are required — run via \`crust --env-file ${underOutDir(rel, "load/.env.load")}\` or export them",
		);
	}
	const sep = auth.indexOf(":");
	if (sep < 0) {
		throw new Error(\`routes.setup: LOAD_AUTH must be a header line, e.g. "cookie: session=…" — got \${auth}\`);
	}
	const headers = { [auth.slice(0, sep).trim()]: auth.slice(sep + 1).trim() };

	const paramsFile = Bun.file("${underOutDir(rel, "e2e/params.json")}");
	if (!(await paramsFile.exists())) {
		throw new Error(
			"routes.setup: ${underOutDir(rel, "e2e/params.json")} not found — its ids are what these pipes target",
		);
	}
	const params = (await paramsFile.json()) as {
		defaults?: Record<string, string>;
		routes?: Record<string, Record<string, string>>;
		landing?: Record<string, string>;
	};

	// LOAD_<PARAM> ids, seeded here rather than by sourcing env.sh. That shim is a
	// bash/zsh-portability script whose own comments record two incidents where it
	// exported NOTHING silently — the pipes then ran against URLs with empty path
	// segments and measured the 404 handler while reporting the application. This
	// has one failure mode, and it is loud.
	const merged: Record<string, string> = { ...(params.defaults ?? {}) };
	for (const route of Object.values(params.routes ?? {})) {
		for (const [k, v] of Object.entries(route)) if (v !== "") merged[k] = v;
	}
	let exported = 0;
	for (const [k, v] of Object.entries(merged)) {
		if (v === "") continue;
		process.env[\`LOAD_\${k.toUpperCase()}\`] = v;
		exported++;
	}
	if (exported === 0 && ROUTES.length < TOTAL_ROUTES) {
		throw new Error(
			"routes.setup: no ids in ${underOutDir(rel, "e2e/params.json")} — every dynamic route below would request a URL with an empty segment and measure the 404 handler",
		);
	}

	// The same landing map the e2e specs use, so a route that redirects by design
	// is recorded once rather than in two places that drift.
	const landing: Record<string, string> = params.landing ?? {};

	for (const route of ROUTES) {
		const res = await fetch(new URL(route, base), { headers });
		const landed = new URL(res.url).pathname;
		const want = landing[route] ?? route;
		if (!landed.startsWith(want)) {
			throw new Error(
				\`routes.setup: \${route} landed on \${landed} (status \${res.status}). Either LOAD_AUTH no longer \` +
				\`authenticates, or this route redirects by design — record the destination under "landing" in \` +
				\`${underOutDir(rel, "e2e/params.json")}. Every measurement below would be of \${landed}, not \${route}.\`,
			);
		}
	}
};
`;
}

function gateComment(missing: string[], rel: string): string {
  return (
    `${GATE_MARKER}${missing.map((m) => `LOAD_${m.toUpperCase()}`).join(", ")}. ` +
    `Fill ${missing.map((m) => `"${m}"`).join(", ")} in ${rel}/e2e/params.json`
  );
}

function pipesHeader(rel: string): string[] {
  return [
    HEADER_MARKER,
    "# Env contract (export before running, or provide a crust setup module):",
    "#   LOAD_BASE  — e.g. http://localhost:3001. Point this at a PRODUCTION build",
    "#                (bun run build && bun run start), not at next dev: the dev",
    "#                server compiles routes on demand, so a load run against it",
    "#                measures the compiler rather than the app.",
    '#   LOAD_AUTH  — a header line, e.g. "cookie: session=<value>" for a cookie',
    '#                session, or "authorization: Bearer <token>" for a token one.',
    '#                Use "accept: */*" if the route needs no auth.',
    "#   LOAD_<PARAM> — one per dynamic segment below (e.g. LOAD_ID, LOAD_BUILDINGID).",
    `#                If you filled ${underOutDir(rel, "e2e/params.json")} for the e2e task, those`,
    `#                are the same ids — source ${underOutDir(rel, "load/env.sh")} to reuse them`,
    "#                instead of keeping a second copy that drifts.",
    "# Baseline gating: copy a good last-*.json to baseline-*.json; runs then fail",
    "# when p95 degrades beyond 2x baseline. One assert per threshold.",
    "# This header is regenerated by --force. Everything below it is merged, not",
    "# replaced: an edited pipe, a pipe you commented out and a flow you added by",
    "# hand all survive. Keep your own notes below this line.",
    "# TODO(flawless): tune rate/duration to your app; add POST flows deliberately.",
  ];
}

export function renderPipes(
  targets: LoadTarget[],
  outDir: string,
  nextRoot: string,
  filled: Set<string>,
): string {
  const rel = outDirRel(outDir, nextRoot);
  const entries = targets.map((t) => {
    const body = renderPipeBody(t, rel);
    const missing = missingParams(t, filled);
    if (missing.length === 0) return body;
    // Commented out rather than dropped: the route is still visible, and filling
    // the id in e2e/params.json plus a --force regeneration turns it back on.
    return `${gateComment(missing, rel)}\n# ${body}`;
  });
  return `${pipesHeader(rel).join("\n")}\n\n${entries.join("\n\n")}\n`;
}

type PipeState = "live" | "gated" | "userCommented";

type BodyItem =
  | { kind: "raw"; line: string }
  | { kind: "pipe"; state: PipeState; name?: string; todo?: string; body: string };

interface ParsedPipes {
  header: string[];
  body: BodyItem[];
}

/**
 * A pipe's stable identity: the `<name>` in `stats --out .../last-<name>.json`.
 *
 * Not the URL — that changes when a param is renamed — and not the line number,
 * which changes whenever anything above it does.
 */
function pipeName(body: string): string | undefined {
  const out = /--out\s+(\S+)/.exec(body);
  if (!out?.[1]) return undefined;
  const base = out[1].split("/").pop() ?? "";
  return /^last-(.+)\.json$/.exec(base)?.[1];
}

/**
 * Split routes.pipes into the header, the pipes it declares, and everything
 * else — which is preserved verbatim and in place, because a note you wrote and
 * a POST flow you added by hand are indistinguishable from each other to a
 * line-oriented parser, and both are yours.
 */
export function parsePipes(text: string): ParsedPipes {
  const lines = text.split("\n");
  const header: string[] = [];
  let i = 0;
  if (lines[0] !== undefined && lines[0].startsWith("#")) {
    while (i < lines.length && lines[i]?.startsWith("#")) header.push(lines[i++] as string);
  }

  const body: BodyItem[] = [];
  for (; i < lines.length; i++) {
    const line = lines[i] as string;
    const next = lines[i + 1];
    if (line.startsWith(GATE_MARKER) && next?.startsWith("# load ")) {
      const pipe = next.slice(2);
      body.push({ kind: "pipe", state: "gated", name: pipeName(pipe), todo: line, body: pipe });
      i++;
    } else if (line.startsWith("load ")) {
      body.push({ kind: "pipe", state: "live", name: pipeName(line), body: line });
    } else if (line.startsWith("# load ")) {
      const pipe = line.slice(2);
      body.push({ kind: "pipe", state: "userCommented", name: pipeName(pipe), body: pipe });
    } else {
      body.push({ kind: "raw", line });
    }
  }
  return { header, body };
}

function renderParsed(parsed: ParsedPipes): string {
  const out = [...parsed.header];
  for (const item of parsed.body) {
    if (item.kind === "raw") {
      out.push(item.line);
      continue;
    }
    if (item.state === "live") out.push(item.body);
    else if (item.state === "gated") out.push(item.todo as string, `# ${item.body}`);
    else out.push(`# ${item.body}`);
  }
  return out.join("\n");
}

/**
 * Fold this run's targets into the routes.pipes already on disk.
 *
 * Only ever toggles a pipe's comment state — the body is never rewritten, so a
 * rate you tuned survives being gated and un-gated. Nothing is pruned: a stale
 * generated pipe and a flow you added by hand look the same from here, and
 * losing the second to tidy up the first is not a trade worth making.
 */
export function mergePipes(
  existing: string,
  targets: LoadTarget[],
  outDir: string,
  nextRoot: string,
  filled: Set<string>,
): string {
  const rel = outDirRel(outDir, nextRoot);
  const parsed = parsePipes(existing);

  const byName = new Map<string, Extract<BodyItem, { kind: "pipe" }>>();
  for (const item of parsed.body) {
    if (item.kind === "pipe" && item.name !== undefined && !byName.has(item.name)) {
      byName.set(item.name, item);
    }
  }

  const fresh: BodyItem[] = [];
  for (const t of targets) {
    const missing = missingParams(t, filled);
    const found = byName.get(t.name);
    if (!found) {
      fresh.push({
        kind: "pipe",
        state: missing.length === 0 ? "live" : "gated",
        name: t.name,
        todo: missing.length === 0 ? undefined : gateComment(missing, rel),
        body: renderPipeBody(t, rel),
      });
      continue;
    }
    // A pipe you commented out yourself was a decision; the tool does not undo it.
    if (found.state === "userCommented") continue;
    if (missing.length === 0) {
      found.state = "live";
      found.todo = undefined;
    } else {
      // Re-stated rather than left alone: filling one of two ids should leave a
      // TODO naming only the one still missing.
      found.state = "gated";
      found.todo = gateComment(missing, rel);
    }
  }

  // The header is generated prose, so a run that recognises its own marker
  // refreshes it. Notes belong below it, where they are preserved.
  if (parsed.header[0] === HEADER_MARKER) parsed.header = pipesHeader(rel);

  // Normalise the trailing blank run before appending, so repeated --force runs
  // do not accumulate empty lines at the end of the file.
  while (
    parsed.body.at(-1)?.kind === "raw" &&
    (parsed.body.at(-1) as { line: string }).line === ""
  ) {
    parsed.body.pop();
  }
  for (const item of fresh) parsed.body.push({ kind: "raw", line: "" }, item);
  parsed.body.push({ kind: "raw", line: "" });

  return renderParsed(parsed);
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

\`routes.pipes\` is yours after generation. \`--force\` merges this run's routes
into it rather than replacing it: a rate you tuned, a pipe you commented out and
a POST flow you added by hand all survive, and a pipe that was gated on a missing
id turns back on once you fill that id in \`../e2e/params.json\`.

This README is not yours — it is regenerated by \`--force\`, so that a later
version of flawless-react can tell you something it worked out after your suite
was generated. Put your own notes in \`routes.pipes\`, below its header.
`;
}

/**
 * Exports LOAD_<PARAM> from the ids already filled in for the e2e task.
 *
 * The load pipes and the e2e specs need the same seeded ids. Two hand-maintained
 * copies of the same eight UUIDs drift on the first change, and the drift is
 * silent — a load run against a stale id just reports a 404 rate.
 */
export function loadEnvScript(rel: string): string {
  return `#!/usr/bin/env bash
# source ${underOutDir(rel, "load/env.sh")}
#
# Exports LOAD_<PARAM> for every id in ${underOutDir(rel, "e2e/params.json")}, so the load
# pipes and the e2e specs cannot disagree about which records they target.
# Do not edit: this file is regenerated on every run. Set LOAD_BASE and
# LOAD_AUTH in your shell (or a .env you source alongside this); see README.md.
set -a
# Locate params.json without depending on which shell sourced this file. The
# shebang above does NOT apply to a sourced script, so \${BASH_SOURCE[0]} is
# empty under zsh — dirname then returned ".", the lookup missed, and every
# LOAD_<PARAM> silently went unset. The pipes still ran, requesting URLs with
# empty path segments: 22 of 33 measured the 404 handler and reported the app.
_self=""
if [ -n "\${BASH_SOURCE:-}" ]; then
  _self="\${BASH_SOURCE[0]}"
elif [ -n "\${ZSH_VERSION:-}" ]; then
  # Hidden behind eval so bash never parses zsh-only syntax.
  eval '_self="\${(%):-%x}"'
fi
if [ -n "$_self" ] && [ -d "$(dirname "$_self")/../e2e" ]; then
  _params="$(cd "$(dirname "$_self")/../e2e" && pwd)/params.json"
else
  # Fall back to the working directory the pipes themselves assume: their
  # --out ${underOutDir(rel, "load/last-*.json")} paths are relative to the project root.
  # This has to track the real out dir — hardcoded "flawless", a run with
  # --out qa left the one fallback that exists for this case resolving to a
  # directory that was never created, so it silently exported nothing.
  _params="$PWD/${underOutDir(rel, "e2e/params.json")}"
fi
if ! command -v jq >/dev/null 2>&1; then
  # Without this the only signal is the shell's own "jq: command not found",
  # which does not say what it costs: the pipes still run, requesting URLs with
  # empty path segments, and report the 404 handler's numbers as the app's.
  echo "flawless: jq not found — no LOAD_<PARAM> exported. The pipes would request URLs with empty path segments and measure your 404 handler. Install jq, or export the ids yourself." >&2
elif [ -f "$_params" ]; then
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
