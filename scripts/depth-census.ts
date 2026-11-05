/**
 * depth-census — maintainer tooling for D0 (PLAN-00).
 *
 *   bun run scripts/depth-census.ts <dir-of-emitted-specs> [--json out.json]
 *
 * Walks the emitted suite under <dir> and prints the depth census: the tier
 * distribution over specs, the count of specs whose strongest tier is T0, the
 * per-test unclaimed count, and a zero-unclassified-specs assertion (non-zero
 * exit when a spec file was found but no test declaration could be read).
 *
 * Scope — ONE census, ONE denominator. The census subject is the suite THIS
 * run emitted, i.e. the out-dir planes whose assertions the PLAN-00 tier table
 * describes:
 *   - `flawless/unit/**.test.ts(x)`      out-dir unit specs
 *   - `flawless/browser/**.spec.ts(x)`   browser (Playwright) specs
 *   - `flawless/native/**.spec.ts(x)`    native (Expo) specs
 * The perf-profile, e2e and load planes measure runtime budgets, not
 * component assertion depth, and are deliberately out of scope.
 *
 * A tree generated with --colocate (or an older published package) also
 * carries a committed copy of the unit plane beside the sources
 * (`*.flawless.test.tsx` anywhere outside the out dir). Counting both copies
 * double-counts the unit plane and inflates the denominator — the first pinned
 * baseline read 310 specs where the run emitted 191. Those colocated files
 * are therefore NOT part of the headline: they are classified separately into
 * the `crossCheck` field, with its own distribution, explicitly excluded from
 * `headline`. When the two copies agree, crossCheck is a free cross-check of
 * the classifier over a second copy of the same suite; when they differ, the
 * committed copy is stale and the out-dir suite is still the truth.
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { census, type DepthCensus, DEPTH_PLANES, type Tier } from "../src/reporters/depth.ts";

function usage(): never {
  console.error("usage: bun run scripts/depth-census.ts <dir-of-emitted-specs> [--json out.json]");
  process.exit(2);
}

const args = process.argv.slice(2);
const jsonFlag = args.indexOf("--json");
let jsonOut: string | undefined;
if (jsonFlag !== -1) {
  jsonOut = args[jsonFlag + 1];
  if (!jsonOut) usage();
  args.splice(jsonFlag, 2);
}
const root = args[0];
if (!root || args.length > 1) usage();

/**
 * Headline planes = the out-dir suite this run emitted. `unit-colocated` is
 * the crossCheck bucket: a committed copy outside the out dir, never part of
 * the headline denominator.
 */
type Plane = "unit" | "browser" | "native" | "unit-colocated";

function inPlane(p: string): Plane | null {
  const rel = p.split(path.sep).join("/");
  const base = rel.split("/").pop() ?? "";
  for (const plane of DEPTH_PLANES) {
    const dir = `flawless/${plane.dir}`;
    const under = rel.includes(`/${dir}/`) || rel.startsWith(`${dir}/`);
    if (under && plane.match(base)) return plane.dir;
  }
  if (/\.flawless\.test\.tsx?$/.test(base)) return "unit-colocated";
  return null;
}

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".git") continue;
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (inPlane(full) !== null) out.push(full);
  }
}

const files: string[] = [];
walk(root as string, files);
files.sort();

const headlineFiles = files.filter((f) => inPlane(f) !== "unit-colocated");
const crossCheckFiles = files.filter((f) => inPlane(f) === "unit-colocated");

const readSpecs = (fs: string[]) => fs.map((f) => ({ path: f, source: readFileSync(f, "utf8") }));
const c: DepthCensus = census(readSpecs(headlineFiles));
const cross: DepthCensus = census(readSpecs(crossCheckFiles));

// Per-plane breakdown of the headline census (paths normalised to forward
// slashes for the lookup).
const planes = new Map<string, { specs: number; distribution: Record<Tier, number> }>();
for (const row of c.perSpec) {
  const plane = inPlane(row.path.split(path.sep).join("/")) ?? "other";
  const entry = planes.get(plane) ?? {
    specs: 0,
    distribution: { T0: 0, T1: 0, T2: 0, T3: 0 },
  };
  entry.specs++;
  if (row.tier !== null) entry.distribution[row.tier]++;
  planes.set(plane, entry);
}

function table(cen: DepthCensus): string[] {
  const out: string[] = [];
  out.push("tier   specs   (strongest assertion in the spec)");
  for (const t of ["T0", "T1", "T2", "T3"] as const) {
    out.push(`${t}    ${String(cen.distribution[t]).padStart(5)}`);
  }
  out.push("");
  out.push(`specs classified:        ${cen.specsClassified}`);
  out.push(`specs strongest T0:      ${cen.specsStrongestT0}`);
  out.push(`tests classified:        ${cen.testsClassified}`);
  out.push(`tests unclaimed:         ${cen.testsUnclaimed}`);
  out.push(`tests skipped:           ${cen.testsSkipped}`);
  out.push(`specs all-skipped:       ${cen.specsAllSkipped.length}`);
  out.push(`specs unclassified:      ${cen.specsUnclassified.length}`);
  return out;
}

console.log(`depth census over ${c.specs} spec file(s) under ${root} — the out-dir suite`);
console.log("");
for (const line of table(c)) console.log(line);
if (c.specsUnclassified.length > 0) {
  for (const p of c.specsUnclassified) console.log(`  unclassified: ${p}`);
}
console.log("");
console.log("per plane:");
for (const [plane, e] of [...planes.entries()].sort()) {
  const d = e.distribution;
  console.log(
    `  ${plane.padEnd(15)} specs=${String(e.specs).padStart(3)}  T0=${d.T0} T1=${d.T1} T2=${d.T2} T3=${d.T3}`,
  );
}
console.log("");
console.log(
  `crossCheck — committed colocated copies (*.flawless.test.ts(x) outside the out dir): ` +
    `${cross.specs} spec file(s), EXCLUDED from the headline above.`,
);
const cd = cross.distribution;
console.log(
  `  crossCheck distribution: T0=${cd.T0} T1=${cd.T1} T2=${cd.T2} T3=${cd.T3}  ` +
    `(tests classified=${cross.testsClassified} unclaimed=${cross.testsUnclaimed} skipped=${cross.testsSkipped})`,
);
if (cross.specs > 0) {
  console.log(
    "  crossCheck is a second copy of the unit plane, not extra coverage: one census,",
  );
  console.log("  one denominator — the headline counts only the suite this run emitted.");
}

if (jsonOut !== undefined) {
  const payload = {
    root,
    headline: c,
    crossCheck: {
      ...cross,
      note: "Committed colocated copies (*.flawless.test.ts(x) outside the out dir). " +
        "Explicitly excluded from `headline`: the census subject is the suite this run emitted.",
    },
    perPlane: Object.fromEntries([...planes.entries()].sort()),
  };
  writeFileSync(jsonOut, `${JSON.stringify(payload, null, 2)}\n`);
  console.log(`\nwrote ${jsonOut}`);
}

if (c.specsUnclassified.length > 0) {
  console.error("FAIL: spec files present that the census could not classify");
  process.exit(1);
}
