import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { analyse, analyseFile, createAnalyseSharedContext } from "../src/analyse/index.ts";
import type { ComponentTree } from "../src/types.ts";

const FIXTURES = path.resolve(__dirname, "fixtures");

describe("analyse wall-clock", () => {
  test("the top-level fixture sweep stays an order of magnitude under the bound", async () => {
    const entries = readdirSync(FIXTURES)
      .filter((f) => f.endsWith(".tsx") && !f.startsWith("_"))
      .map((f) => path.join(FIXTURES, f));
    // The sweep must actually sweep — an empty glob would pin nothing.
    expect(entries.length).toBeGreaterThan(20);

    const shared = createAnalyseSharedContext();
    const start = performance.now();
    for (const entry of entries) {
      try {
        await analyse({ entry, depth: 3, includeChildren: true }, shared);
      } catch (err) {
        // Non-detection fixtures (NoopConstant.tsx) throw by design; the sweep
        // tolerates exactly the error core.ts tolerates, nothing else.
        if (!(err instanceof Error && err.message.includes("could not locate a React component"))) {
          throw err;
        }
      }
    }
    const elapsed = performance.now() - start;

    // The bound exists to catch accidental O(n^2) walks or a typechecker
    // adoption, not to benchmark: 2000ms is ~40x the measured wall for this
    // set (~45ms cold on 2026-08-24, 41 entries, shared parse cache).
    expect(elapsed).toBeLessThan(2000);
  });
});

/**
 * B-15: the mode the B-7 pin above cannot see.
 *
 * `analyse()` hard-forces `roots: "primary"` (analyse/index.ts:49), so the pin
 * above measures one tree per file. `--roots exported` returns one tree PER
 * EXPORTED COMPONENT, and that is the mode the dogfood app actually runs — its
 * REPORT.md repro line carries `--roots exported`. Three paths only exist
 * there: parseFile re-runs per root (R+1 per file), the sibling render-mode
 * loop is R x (R-1), and each root re-walks the whole child subtree with its
 * own visited set.
 *
 * B-15 proposed caching all three. Measured first, and the answer was to stop:
 * per-tree cost is FLAT (0.308 ms at both 200 and 800 trees over 100 files),
 * so the work is linear, not quadratic; child-chain depth 1 -> 10 moves the
 * total by 4 ms; and the whole prize from the barrel walk is ~30 ms at a
 * 320-arm barrel. Not worth an invalidation hazard that could resurrect the
 * round-7 shadowing bug (2613f8b).
 *
 * What was worth shipping is this: the mode had NO timing bound at all, so a
 * genuine O(n^2) landing in it would have been invisible.
 */
describe('analyse wall-clock, roots:"exported"', () => {
  test("one tree per exported component stays an order of magnitude under the bound", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "flawless-perf-exported-"));
    try {
      const w = (rel: string, body: string): string => {
        const file = path.join(root, rel);
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, body);
        return file;
      };
      w("package.json", JSON.stringify({ name: "perf-exported", version: "0.0.0" }));
      w("tsconfig.json", JSON.stringify({ compilerOptions: { jsx: "react-jsx" } }));

      // A wide star barrel with the interfaces in its LAST arms, so every chase
      // pays the full breadth before it hits.
      const ARMS = 40;
      const ROOTS = 8;
      const FILES = 8;
      const arms: string[] = [];
      for (let i = 0; i < ARMS; i++) arms.push(`export * from "./m${i}";`);
      w("src/types/index.ts", `${arms.join("\n")}\n`);
      for (let i = 0; i < ARMS; i++) {
        w(
          `src/types/m${i}.ts`,
          i >= ARMS - ROOTS
            ? `export interface Props${i} {\n  id: string;\n  label: string;\n  count: number;\n  active: boolean;\n}\n`
            : `export const filler${i} = ${i};\n`,
        );
      }
      // A shared child chain every root renders, so the per-root subtree re-walk
      // is exercised — without children that path is not measured at all.
      const KIDS = 3;
      for (let k = 0; k < KIDS; k++) {
        const next = k + 1 < KIDS ? `import { Kid${k + 1} } from "./Kid${k + 1}";\n` : "";
        const body = k + 1 < KIDS ? `<div><Kid${k + 1} tag={tag} /></div>` : `<div>{tag}</div>`;
        w(
          `src/ui/Kid${k}.tsx`,
          `${next}\nexport function Kid${k}({ tag }: { tag: string }) {\n  return ${body};\n}\n`,
        );
      }
      const entries: string[] = [];
      for (let f = 0; f < FILES; f++) {
        const imports = ['import { Kid0 } from "./Kid0";'];
        const comps: string[] = [];
        for (let r = 0; r < ROOTS; r++) {
          const n = ARMS - ROOTS + r;
          imports.push(`import type { Props${n} } from "../types";`);
          comps.push(
            `export function C${f}_${r}({ id, label, count, active }: Props${n}) {\n` +
              `  return <button onClick={() => console.log(id)}><Kid0 tag={label} /> {count} {String(active)}</button>;\n}`,
          );
        }
        entries.push(w(`src/ui/Panel${f}.tsx`, `${imports.join("\n")}\n\n${comps.join("\n\n")}\n`));
      }

      const shared = createAnalyseSharedContext();
      // Spy on the SHARED cache, counted DURING the run. Removing the shared
      // context (a fresh one per entry) is otherwise invisible: it costs ~16%,
      // which no timing bound loose enough to be stable can catch. This sees it
      // structurally — a fresh context per entry means these files are never
      // touched at all.
      const seen = new Set<string>();
      const realGet = shared.cache.get.bind(shared.cache);
      shared.cache.get = (file: string) => {
        seen.add(file);
        return realGet(file);
      };
      const start = performance.now();
      const trees: ComponentTree[] = [];
      for (const entry of entries) {
        trees.push(
          ...(await analyseFile(
            { entry, depth: KIDS, includeChildren: true, roots: "exported" },
            shared,
          )),
        );
      }
      const elapsed = performance.now() - start;

      // VACUITY GUARDS, and they are the point of this test as much as the
      // bound is. The first draft of this corpus used inline `{ shape: T }`
      // annotations, which BAIL — propsShape came back {} and the numbers
      // measured the bail path while looking perfectly reasonable. The second
      // had no children, so the subtree re-walk was never exercised.
      expect(trees.length).toBe(FILES * ROOTS);
      // The corpus is the shape the comment claims: a WIDE barrel, and one
      // shared cache spanning every entry. Narrowing ARMS or handing each entry
      // its own context both left this test green before these two lines.
      expect(ARMS).toBeGreaterThanOrEqual(40);
      expect(seen.size).toBeGreaterThan(FILES);
      const depthBelow = (t: (typeof trees)[number]): number =>
        t.children.length === 0 ? 0 : 1 + Math.max(...t.children.map(depthBelow));
      for (const t of trees) {
        expect(Object.keys(t.entry.propsShape ?? {}).length).toBe(4);
        // The WHOLE chain, not merely one child. The review found
        // `children.length > 0` proves ONE level, so a chain of 1 and a
        // `depth: 1` that stops the recursion both passed while the comment
        // claimed a 3-deep walk. That walk is what this block exists to bound.
        // A LITERAL 3, deliberately not `KIDS`: comparing against the corpus
        // constant lets a shrunken corpus move the goalposts along with it, so
        // `KIDS = 1` would still "pass" a test whose comment promises a 3-deep
        // walk. The number here is the claim; the corpus has to meet it.
        expect(depthBelow(t)).toBe(3);
      }

      // ~55 ms measured 2026-08-25 for this corpus (64 trees, 40-arm barrel,
      // 3-deep chain). 10x, not the 80x it was: the old 2000 ms bound survived
      // deleting the shared parse cache entirely — the one mechanism
      // analyse/index.ts credits for making a wide sweep affordable — so it
      // could not fail for anything short of a corpus 50x this size.
      expect(elapsed).toBeLessThan(600);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
