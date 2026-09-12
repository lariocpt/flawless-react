import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { outDirRel, underOutDir } from "../emitPaths.ts";
import type { ComponentTree, ExpoContext, RunContext, TaskResult } from "../types.ts";
import { ensureParamDefaults } from "./e2eRoutes.ts";
import {
  countPipes,
  describeTally,
  type LoadTarget,
  loadEnvScript,
  mergePipes,
  readFilledParams,
  renderPipes,
  slugify,
} from "./loadPipes.ts";

/**
 * API-only crust load pipes for an Expo app — B-16 wave 7, the sibling of
 * loadPipes.ts (one TaskId, one engine per platform).
 *
 * An Expo app has no server-rendered page routes to GET, so the page-route half
 * of the Next flavour drops away and the pipes are the GET endpoints the screens
 * reach through the app's fetch wrapper (ComponentInfo.apiCalls, harvested one
 * hop at analysis time). Everything downstream is shared verbatim — the pipe
 * body, the merge-kept routes.pipes, params.json, env.sh — because none of it is
 * platform-specific. Only two things differ and both are here: what a target IS
 * (an api endpoint, not a page), and how the auth probe knows the session is
 * dead (a 401 from the API, not a redirect to a login page).
 */
export async function runExpoLoad(ctx: RunContext): Promise<TaskResult> {
  const expo = ctx.expo as ExpoContext;
  const loadDir = path.join(ctx.outDir, "load");
  await mkdir(loadDir, { recursive: true });
  const written: string[] = [];

  const targets = collectExpoTargets(ctx.trees);
  const rel = outDirRel(ctx.outDir, expo.root);

  // A run that harvested nothing is reported as such, not as an empty success:
  // 0 endpoints on an app that makes API calls means the harvest could not see
  // through its client, which the reader needs to know.
  if (targets.length === 0) {
    return {
      id: "load",
      ok: true,
      outputs: [],
      findings: [],
      summary:
        "load: no GET endpoints harvested — the screens reach no api function whose body " +
        "calls a fetch wrapper with a literal path (calls mediated by a store, or a non-literal URL, are not traced)",
    };
  }

  const paramsPath = path.join(ctx.outDir, "e2e", "params.json");
  const needed = [...new Set(targets.flatMap((t) => t.params))].sort();
  if (await ensureParamDefaults(paramsPath, needed)) written.push(paramsPath);
  const filled = await readFilledParams(paramsPath);

  const pipesPath = path.join(loadDir, "routes.pipes");
  let keptPipes = false;
  let pipesText: string;
  if (!existsSync(pipesPath)) {
    pipesText = renderPipes(targets, ctx.outDir, expo.root, filled);
    await Bun.write(pipesPath, pipesText);
    written.push(pipesPath);
  } else if (ctx.force) {
    pipesText = mergePipes(
      await Bun.file(pipesPath).text(),
      targets,
      ctx.outDir,
      expo.root,
      filled,
    );
    await Bun.write(pipesPath, pipesText);
    written.push(pipesPath);
  } else {
    pipesText = await Bun.file(pipesPath).text();
    keptPipes = true;
  }

  const setupPath = path.join(loadDir, "routes.setup.ts");
  if (!existsSync(setupPath)) {
    await Bun.write(setupPath, renderExpoLoadSetup(targets, rel));
    written.push(setupPath);
  }

  const envPath = path.join(loadDir, "env.sh");
  await Bun.write(envPath, loadEnvScript(rel));
  written.push(envPath);

  const readmePath = path.join(loadDir, "README.md");
  if (!existsSync(readmePath) || ctx.force) {
    await Bun.write(readmePath, expoLoadReadme());
    written.push(readmePath);
  }

  const crustPresent = Bun.which("crust") !== null;
  const tally = countPipes(pipesText);
  return {
    id: "load",
    ok: true,
    outputs: written,
    findings: [],
    summary: keptPipes
      ? `kept existing load/routes.pipes (--force to merge in ${targets.length} API target(s))`
      : `load pipes for ${targets.length} API endpoint(s) — ${describeTally(tally, filled, targets)}${
          crustPresent ? " — run with bun run flawless:load" : " — crust not found on PATH"
        }`,
  };
}

/**
 * The GET endpoints the screens hit, as load targets. Mutations are excluded by
 * default (load-testing a POST writes junk into the target DB); the dynamic
 * segments become $LOAD_<PARAM> exactly as the Next flavour renders a page
 * route's, so the shared pipe/param machinery cannot tell the two apart.
 */
export function collectExpoTargets(trees: ComponentTree[]): LoadTarget[] {
  const out: LoadTarget[] = [];
  const seen = new Set<string>();
  const usedNames = new Set<string>();
  const walk = (t: ComponentTree): void => {
    for (const f of t.entry.apiCalls ?? []) {
      if (f.method !== "GET") continue;
      let p = f.urlTemplate;
      for (const hole of f.holes) p = p.replace(`:${hole}`, `$LOAD_${hole.toUpperCase()}`);
      if (seen.has(p)) continue;
      seen.add(p);
      let name = slugify(p);
      // slugify collapses every $VAR to `x`, so two distinct endpoints can
      // slug to one name and would then share one last-*.json — the merge keys
      // on that name and the second would never emit. First claimant keeps it.
      let unique = name;
      for (let n = 2; usedNames.has(unique); n++) unique = `${name}-${n}`;
      name = unique;
      usedNames.add(name);
      out.push({ name, urlPath: p, params: f.holes });
    }
    for (const c of t.children) walk(c);
  };
  for (const tree of trees) walk(tree);
  // Stable order so regeneration is byte-deterministic — endpoints are
  // harvested in screen-analysis order, which is not sorted.
  out.sort((a, b) => a.urlPath.localeCompare(b.urlPath));
  return out;
}

/** The parameterless GET endpoints, which the auth probe can hit without a filled id. */
function probeTargets(targets: LoadTarget[]): string[] {
  return targets.filter((t) => t.params.length === 0).map((t) => t.urlPath);
}

/**
 * The setup module crust imports before any pipe runs — the Expo-web variant.
 *
 * The Next flavour probes for a REDIRECT to a login page (crust follows
 * redirects, so a dead session silently measures the login form at 200). An API
 * endpoint does not redirect: an expired LOAD_AUTH gets a 401 at the SAME url,
 * which the redirect check would pass. So this probes a parameterless GET
 * endpoint and fails on a 401/403 — the sharper signal the redirect check could
 * never see, and exactly the "an authenticated /api/me answering 401" case the
 * Next setup's own comment wishes for.
 *
 * WRITE-ONCE, like every setup stub: a hand-written check that knows the app is
 * better than this one, and no regeneration overwrites it.
 */
export function renderExpoLoadSetup(targets: LoadTarget[], rel: string): string {
  const probes = probeTargets(targets);
  return `// Setup module for routes.pipes (Expo, API-only). test-pipes imports the
// sibling <name>.setup.ts and awaits its default export before any line runs.
//
// Why an API-specific check: the Next.js flavour probes for a redirect to a
// login page, because a dead cookie makes a page route serve /login at 200. An
// API endpoint does not redirect — an expired LOAD_AUTH answers 401 at the same
// URL — so a redirect check would pass on a dead session. This fails on the 401
// instead, before a single measurement.
//
// This file is written once and never regenerated. Replace it with a check that
// knows your app if you have a sharper one; nothing will overwrite yours.

/** Parameterless GET endpoints — hittable without a filled id, so they make honest auth probes. */
const PROBES: string[] = ${JSON.stringify(probes)};

export default async () => {
	const base = process.env.LOAD_BASE;
	const auth = process.env.LOAD_AUTH;
	if (!base || !auth) {
		throw new Error(
			"routes.setup: LOAD_BASE and LOAD_AUTH are required — export them or use \`crust --env-file ${underOutDir(rel, "load/.env.load")}\`",
		);
	}
	const sep = auth.indexOf(":");
	if (sep < 0) {
		throw new Error(\`routes.setup: LOAD_AUTH must be a header line, e.g. "authorization: Bearer <token>" or "cookie: session=…" — got \${auth}\`);
	}
	const headers = { [auth.slice(0, sep).trim()]: auth.slice(sep + 1).trim() };

	// Seed LOAD_<PARAM> from params.json (the e2e task's fixture), so a dynamic
	// pipe requests a real record rather than a URL with an empty segment.
	const paramsFile = Bun.file("${underOutDir(rel, "e2e/params.json")}");
	if (await paramsFile.exists()) {
		const params = (await paramsFile.json()) as {
			defaults?: Record<string, string>;
			routes?: Record<string, Record<string, string>>;
		};
		const merged: Record<string, string> = { ...(params.defaults ?? {}) };
		for (const route of Object.values(params.routes ?? {})) {
			for (const [k, v] of Object.entries(route)) if (v !== "") merged[k] = v;
		}
		for (const [k, v] of Object.entries(merged)) {
			if (v !== "") process.env[\`LOAD_\${k.toUpperCase()}\`] = v;
		}
	}

	if (PROBES.length === 0) {
		// Every endpoint is parameterised; nothing can be probed without trusting a
		// fixture id, and a wrong id reads as an auth failure. The pipes' own
		// \`expect 200\` is the only gate left — noted, not silently skipped.
		return;
	}

	for (const route of PROBES) {
		const res = await fetch(new URL(route, base), { headers });
		if (res.status === 401 || res.status === 403) {
			throw new Error(
				\`routes.setup: \${route} answered \${res.status} — LOAD_AUTH does not authenticate. \` +
				\`Every pipe below would measure the API's auth rejection, not the endpoint. Refresh the token/cookie.\`,
			);
		}
		if (res.status >= 500) {
			throw new Error(\`routes.setup: \${route} answered \${res.status} — the API is unhealthy; fix it before load-testing.\`);
		}
	}
};
`;
}

function expoLoadReadme(): string {
  return `# flawless-react load pipes (Expo, API-only)

Generated crust pipelines for the GET API endpoints the app's screens reach
through its fetch wrapper (\`lib/api\`). An Expo app has no server-rendered page
routes, so — unlike the Next.js flavour — these pipes are API endpoints only.
Mutating endpoints are excluded; add them by hand against a safe target.

Run: \`bun run flawless:load\` (crust must be installed — see the repo's crust
setup or https://github.com/lariocpt/crust).

- \`LOAD_BASE\` — the API origin, e.g. \`http://localhost:3001\`. Point it at a
  real API (a production build for real numbers), NOT at Metro: \`expo start
  --web\` serves the UI, not the endpoints these pipes hit.
- \`LOAD_AUTH\` — a header line. On React Native the app authenticates with a
  bearer token (\`authorization: Bearer <token>\`); on its web build, a cookie
  (\`cookie: session=…\`). Either works — the API accepts both. \`routes.setup.ts\`
  fails loudly if it no longer authenticates (a dead token answers 401, and the
  pipes would otherwise measure the rejection).
- \`LOAD_<PARAM>\` — one per dynamic segment (\`LOAD_BUILDINGID\`, \`LOAD_ID\`,
  \`LOAD_INVOICEID\`). \`routes.setup.ts\` seeds these from \`../e2e/params.json\`;
  fill them there (the same ids the e2e task uses) or source \`env.sh\`.

Note two names for the building id: some api functions take \`id\`, others
\`buildingId\`, so params.json carries both — fill each with the same building.

Baselines: after a good run, copy \`last-<name>.json\` to \`baseline-<name>.json\`.
Subsequent runs fail when p95 exceeds 2x the baseline.

\`routes.pipes\` is yours after generation. \`--force\` merges this run's endpoints
into it rather than replacing it: a rate you tuned, a pipe you commented out and
a POST flow you added by hand all survive. This README is regenerated by
\`--force\`; put your own notes in \`routes.pipes\`, below its header.
`;
}
