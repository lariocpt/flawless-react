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
 * Scope — the planes whose assertions the PLAN-00 tier table describes:
 *   - `*.flawless.test.ts(x)`            colocated unit specs (any dir)
 *   - `flawless/unit/**.test.ts(x)`      out-dir unit specs
 *   - `flawless/browser/**.spec.ts`      browser (Playwright) specs
 *   - `flawless/native/**.spec.ts(x)`    native (Expo) specs
 * The perf-profile, e2e and load planes measure runtime budgets, not
 * component assertion depth, and are deliberately out of scope.
 *
 * When BOTH colocated and out-dir unit specs exist (a tree generated with
 * --colocate that was later regenerated without it), both are counted and the
 * per-plane table makes the double coverage visible — the census reports what
 * is on disk, it does not guess which copy is canonical.
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { census, type DepthCensus, type Tier } from "../src/reporters/depth.ts";

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

function inPlane(p: string): "unit-colocated" | "unit" | "browser" | "native" | null {
  const rel = p.split(path.sep).join("/");
  const base = rel.split("/").pop() ?? "";
  const under = (dir: string): boolean => rel.includes(`/${dir}/`) || rel.startsWith(`${dir}/`);
  if (under("flawless/native") && /\.spec\.tsx?$/.test(base)) return "native";
  if (under("flawless/browser") && /\.spec\.tsx?$/.test(base)) return "browser";
  if (under("flawless/unit") && /\.flawless\.test\.tsx?$/.test(base) === false && /\.test\.tsx?$/.test(base))
    return "unit";
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

const specs = files.map((f) => ({ path: f, source: readFileSync(f, "utf8") }));
const c: DepthCensus = census(specs);

// Per-plane breakdown (paths normalised to forward slashes for the lookup).
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

console.log(`depth census over ${c.specs} spec file(s) under ${root}`);
console.log("");
console.log("tier   specs   (strongest assertion in the spec)");
for (const t of ["T0", "T1", "T2", "T3"] as const) {
  console.log(`${t}    ${String(c.distribution[t]).padStart(5)}`);
}
console.log("");
console.log(`specs classified:        ${c.specsClassified}`);
console.log(`specs strongest T0:      ${c.specsStrongestT0}`);
console.log(`tests classified:        ${c.testsClassified}`);
console.log(`tests unclaimed:         ${c.testsUnclaimed}`);
console.log(`tests skipped:           ${c.testsSkipped}`);
console.log(`specs all-skipped:       ${c.specsAllSkipped.length}`);
console.log(`specs unclassified:      ${c.specsUnclassified.length}`);
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

if (jsonOut !== undefined) {
  const payload = {
    root,
    census: c,
    perPlane: Object.fromEntries([...planes.entries()].sort()),
  };
  writeFileSync(jsonOut, `${JSON.stringify(payload, null, 2)}\n`);
  console.log(`\nwrote ${jsonOut}`);
}

if (c.specsUnclassified.length > 0) {
  console.error("FAIL: spec files present that the census could not classify");
  process.exit(1);
}
