import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";
import { analyse } from "../src/analyse/index.ts";
import { renderSuite } from "../src/scaffold/templates.ts";
import { renderUnitBrowser } from "../src/scaffold-tests/templates.ts";

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
    for (const fixture of FIXTURES) {
      const tree = await analyse({
        entry: path.resolve(__dirname, "fixtures", fixture),
        depth: 0,
        includeChildren: false,
      });
      const files = renderSuite({ tree, outDir: await tmpDir(), variants: 3, report: true });
      for (const f of files) {
        if (!/\.tsx?$/.test(f.relPath)) continue;
        errors.push(...parseErrorsIn(`${fixture} → ${f.relPath}`, f.content));
      }
    }
    expect(errors).toEqual([]);
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
        if (!/\.tsx?$/.test(f.relPath)) continue;
        errors.push(...parseErrorsIn(`${fixture} → ${f.relPath}`, f.content));
      }
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
