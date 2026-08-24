import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";
import { analyse } from "../src/analyse/index.ts";
import { detectNextjs } from "../src/nextjs/detect.ts";
import { emitNextjsMocks } from "../src/nextjs/emit.ts";
import { ensureClientProviderWrapper } from "../src/nextjs/providerWrapper.ts";
import { extractRoutes, loadApiSpec } from "../src/scaffold/openapi.ts";
import { renderSuite } from "../src/scaffold/templates.ts";
import { renderUnitBrowser } from "../src/scaffold-tests/templates.ts";
import { findTask } from "../src/tasks/index.ts";
import type { TaskId } from "../src/types.ts";

/**
 * Every file the tool writes has to parse.
 *
 * This exists because a template refactor emitted a profile spec with one `})`
 * too many, and nothing noticed until Playwright tried to collect it thirteen
 * minutes into a run — where it appeared as `SyntaxError: Unexpected token` in
 * a file no human wrote. The unit specs are covered by actually running vitest;
 * the Playwright ones had no equivalent, so a whole class of template mistake
 * could only be found by running the browser.
 *
 * Parsing is cheap. Every fixture goes through every emitter, and both branches
 * of the conditional scenarios get exercised: a component with a nameable click
 * target and one without.
 */
const FIXTURES = [
  "Toolbar.tsx", // nameable click target → full scenario bodies
  "AmbiguousTags.tsx", // no nameable target → skip-only scenarios
  "GatedSubmit.tsx", // statically disabled control
  "CheckboxForm.tsx", // form with typed fields
  "NoSubmitForm.tsx", // form with no submit control
  "StatefulPanel.tsx",
  "Card.tsx",
];

const NEXTAPP = path.resolve(__dirname, "fixtures", "nextapp");

const tmpDir = (): Promise<string> => mkdtemp(path.join(tmpdir(), "flawless-syntax-"));

function parseErrorsIn(file: string, content: string): string[] {
  const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(file, content, ts.ScriptTarget.ESNext, true, kind);
  const diagnostics = (sf as unknown as { parseDiagnostics?: ts.Diagnostic[] }).parseDiagnostics;
  return (diagnostics ?? []).map((d) => {
    const at =
      d.start === undefined ? "" : ` at ${ts.getLineAndCharacterOfPosition(sf, d.start).line + 1}`;
    return `${file}${at}: ${ts.flattenDiagnosticMessageText(d.messageText, " ")}`;
  });
}

describe("every emitted file parses", () => {
  test("the profile suite", async () => {
    const errors: string[] = [];
    const parsed = new Set<string>();
    for (const fixture of FIXTURES) {
      const tree = await analyse({
        entry: path.resolve(__dirname, "fixtures", fixture),
        depth: 0,
        includeChildren: false,
      });
      const files = renderSuite({ tree, outDir: await tmpDir(), variants: 3, report: true });
      for (const f of files) {
        if (!/\.(m?tsx?)$/.test(f.relPath)) continue;
        parsed.add(f.relPath);
        errors.push(...parseErrorsIn(`${fixture} → ${f.relPath}`, f.content));
      }
    }
    expect(errors).toEqual([]);
    // Explicit, so a rename cannot silently drop the sweep's coverage of the
    // regenerated registry beside the write-once wrapper.
    expect([...parsed]).toContain("host/registry.ts");
    expect([...parsed]).toContain("host/main.tsx");
  });

  test("the unit and browser specs", async () => {
    const errors: string[] = [];
    for (const fixture of FIXTURES) {
      const tree = await analyse({
        entry: path.resolve(__dirname, "fixtures", fixture),
        depth: 0,
        includeChildren: false,
      });
      const files = renderUnitBrowser({
        trees: [tree],
        outDir: await tmpDir(),
        variants: 3,
        browserSpecs: true,
      });
      for (const f of files) {
        if (!/\.(m?tsx?)$/.test(f.relPath)) continue;
        errors.push(...parseErrorsIn(`${fixture} → ${f.relPath}`, f.content));
      }
    }
    expect(errors).toEqual([]);
  });

  test("the e2e, mocks and provider files — which no emitter above reaches", async () => {
    // renderSuite and renderUnitBrowser are only two of the emitters. The e2e
    // task, the MSW mocks and the derived provider write straight to disk and
    // were parsed by nothing at all, which is the same blind spot that let a
    // profile spec ship with one `})` too many.
    const outDir = await tmpDir();
    const ctx = await detectNextjs(NEXTAPP);
    const page = path.join(NEXTAPP, "src", "app", "items", "[id]", "page.tsx");
    const tree = await analyse({ entry: page, depth: 0, includeChildren: false });

    const e2e = findTask("e2e" as TaskId);
    if (!e2e) throw new Error("e2e task not registered");
    await e2e.run({
      trees: [tree],
      outDir,
      variants: 3,
      heaps: "stress",
      force: false,
      report: false,
      provider: undefined,
      apiSpec: undefined,
      inlineSummary: false,
      nextjs: ctx,
    });
    await emitNextjsMocks(ctx, outDir);
    ensureClientProviderWrapper(ctx, outDir);

    const seen: string[] = [];
    const errors: string[] = [];
    for (const rel of readdirSync(outDir, { recursive: true }) as string[]) {
      const relPath = rel.split(path.sep).join("/");
      if (!/\.(m?tsx?)$/.test(relPath)) continue;
      seen.push(relPath);
      errors.push(...parseErrorsIn(relPath, readFileSync(path.join(outDir, relPath), "utf8")));
    }
    expect(errors).toEqual([]);

    // Without this the walk could cover an empty directory and still pass —
    // the exact vacuity that makes a coverage test worthless. Each of these is
    // an emitter that had no parse coverage before.
    for (const expected of [
      "e2e/playwright.config.ts",
      "e2e/params.ts",
      "e2e/global-setup.ts",
      "e2e/items-id.spec.ts",
      "mocks/handlers.ts",
      "mocks/browser.ts",
      "mocks/node.ts",
      "provider.tsx",
    ]) {
      expect(seen, `emitted and parsed ${expected}`).toContain(expected);
    }
  });

  test("the mock server, which only exists when --api was passed", async () => {
    // mock/server.ts and mock/routes.ts are emitted only when mockRoutes is
    // set, and the suites above never set it — so a check added there would
    // have passed while covering neither file.
    const tree = await analyse({
      entry: path.resolve(__dirname, "fixtures", "Toolbar.tsx"),
      depth: 0,
      includeChildren: false,
    });
    const mockRoutes = extractRoutes(
      await loadApiSpec(path.resolve(__dirname, "fixtures", "_api.json")),
    );
    expect(mockRoutes.length).toBeGreaterThan(0);

    const files = renderSuite({
      tree,
      outDir: await tmpDir(),
      variants: 3,
      report: false,
      mockRoutes,
    });
    const emitted = files.map((f) => f.relPath);
    expect(emitted).toContain("mock/server.ts");
    expect(emitted).toContain("mock/routes.ts");

    const errors: string[] = [];
    for (const f of files) {
      if (!/\.(m?tsx?)$/.test(f.relPath)) continue;
      errors.push(...parseErrorsIn(f.relPath, f.content));
    }
    expect(errors).toEqual([]);
  });

  test("the checker itself catches an unbalanced brace", () => {
    // Guards the guard: if parseDiagnostics ever stops being populated, this
    // whole file would pass vacuously.
    expect(parseErrorsIn("broken.ts", "function a() { void b; })\n").length).toBeGreaterThan(0);
  });

  test("every fixture is real", () => {
    const present = new Set(readdirSync(path.resolve(__dirname, "fixtures")));
    for (const f of FIXTURES) expect(present.has(f)).toBe(true);
  });
});
