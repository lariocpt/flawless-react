import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import os, { tmpdir } from "node:os";
import path from "node:path";
import { analyse } from "../src/analyse/index.ts";
import { renderSuite } from "../src/scaffold/templates.ts";
import { renderUnitBrowser } from "../src/scaffold-tests/templates.ts";

/**
 * The emitted specs must not contain the two shapes that have actually hung.
 *
 * Every 30-second timeout this project has produced came from one of these, and
 * each cost a full suite run to discover:
 *
 *  - a `.click()` on a target that may not be there. UserMenu returns null until
 *    a store hook supplies a session, so its disclosure trigger never rendered
 *    and Playwright waited out the timeout for it — twice, because the same
 *    mistake was made separately in the browser and profile emitters.
 *  - a locator built from a bare host tag with no presence check, which is the
 *    "whichever button is first" guess that resolved to VoteCard's disabled
 *    "Cast vote" while the handler belonged to a vote option.
 *
 * Grepping the emitted string costs milliseconds. Finding them by running a
 * browser costs a quarter of an hour, and this suite exists because that is the
 * trade that was actually being made.
 */

const FIXTURES = [
  "Toolbar.tsx",
  "AmbiguousTags.tsx",
  "GatedSubmit.tsx",
  "GuardedMenu.tsx",
  "CheckboxForm.tsx",
  "NoSubmitForm.tsx",
  "StatefulPanel.tsx",
  "Card.tsx",
];

const tmpDir = (): Promise<string> => mkdtemp(path.join(tmpdir(), "flawless-act-"));

/** Lines that click without any preceding guard in the same test body. */
function unguardedClicks(content: string): string[] {
  const out: string[] = [];
  // Split on test declarations at column 0 only. Splitting on any `test.skip(`
  // cut bodies in half at their own runtime skip, so the guard landed in one
  // fragment and the click in the next — the rule then flagged code that was
  // correctly guarded.
  for (const body of content.split(/^test(?:\.skip)?\(/m).slice(1)) {
    const guarded =
      /\.count\(\)/.test(body) ||
      /isDisabled\(\)/.test(body) ||
      /isEnabled\(\)/.test(body) ||
      /hasButton/.test(body);
    for (const line of body.split("\n")) {
      if (!/\.click\(\)/.test(line)) continue;
      // A locator naming a real handle (test id, label, role, literal text) is
      // allowed to click unguarded: if it is missing, that IS the failure.
      const named = /getByTestId|getByLabel|getByRole|getByText|getByPlaceholder|locator\("#/.test(
        line,
      );
      if (!named && !guarded) out.push(line.trim());
    }
  }
  return out;
}

/** Bare host-tag locators, which name an element only when it is the only one. */
function bareTagLocators(content: string): string[] {
  return content
    .split("\n")
    .filter((l) => /page\.locator\("[a-z][a-z0-9-]*"\)/.test(l))
    .filter((l) => !/\.count\(\)/.test(l))
    .map((l) => l.trim());
}

async function emitAll(fixture: string): Promise<Array<{ path: string; content: string }>> {
  const tree = await analyse({
    entry: path.resolve(__dirname, "fixtures", fixture),
    depth: 0,
    includeChildren: false,
  });
  const files: Array<{ path: string; content: string }> = [];
  for (const f of renderSuite({ tree, outDir: await tmpDir(), variants: 3, report: false })) {
    if (f.relPath.endsWith(".spec.ts")) files.push({ path: f.relPath, content: f.content });
  }
  for (const f of renderUnitBrowser({
    trees: [tree],
    outDir: await tmpDir(),
    variants: 3,
    browserSpecs: true,
  })) {
    if (f.relPath.endsWith(".spec.ts")) files.push({ path: f.relPath, content: f.content });
  }
  return files;
}

describe("emitted specs never wait on something that may not be there", () => {
  test("no click on an unnamed target without a presence check", async () => {
    const offenders: string[] = [];
    for (const fixture of FIXTURES) {
      for (const f of await emitAll(fixture)) {
        for (const line of unguardedClicks(f.content)) {
          offenders.push(`${fixture} → ${f.path}: ${line}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test("no bare host-tag locator that is not counted first", async () => {
    const offenders: string[] = [];
    for (const fixture of FIXTURES) {
      for (const f of await emitAll(fixture)) {
        for (const line of bareTagLocators(f.content)) {
          offenders.push(`${fixture} → ${f.path}: ${line}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test("the checks themselves reject the shapes they are meant to catch", () => {
    // Guards the guard: a rule that can never fire is worse than no rule,
    // because it reads as coverage.
    const hung = 'test("x", async () => {\n  await page.locator("button").first().click();\n});';
    expect(unguardedClicks(hung).length).toBeGreaterThan(0);
    expect(bareTagLocators(hung).length).toBeGreaterThan(0);

    const fine =
      'test("x", async () => {\n  await page.getByRole("button", { name: "Go" }).first().click();\n});';
    expect(unguardedClicks(fine)).toEqual([]);
    expect(bareTagLocators(fine)).toEqual([]);
  });
});

describe("an undecidable render emits a named refusal, not a spec that cannot pass", () => {
  // NOT ClassBoundary: that is an error boundary and now gets a real two-path
  // spec, so it stopped being an example of a refusal.
  const BOUNDARY = path.resolve(__dirname, "fixtures/UndecidableRender.tsx");

  async function specFor(entry: string): Promise<string> {
    const out = mkdtempSync(path.join(os.tmpdir(), "undecidable-"));
    try {
      const tree = await analyse({ entry, depth: 0, includeChildren: false });
      const files = renderUnitBrowser({ trees: [tree], outDir: out, variants: 3 });
      const spec = files.find((f) => f.relPath.endsWith(".test.tsx"));
      if (!spec) throw new Error("no spec emitted");
      return spec.content;
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  }

  test("the spec refuses by name and says how to make it assertable", async () => {
    const src = await specFor(BOUNDARY);
    expect(src).toContain("no render can be described");
    expect(src).toContain("test.skip(");
  });

  test("and does NOT drive the control inside the branch the defaults never take", async () => {
    // This is the assertion that matters. A test checking only "a spec was
    // emitted" is green over a spec that cannot pass. Executed before the fix:
    // "Unable to find an accessible element with the role 'button' and name
    // 'Try again'".
    const src = await specFor(BOUNDARY);
    expect(src).not.toContain("Flagged action");
    expect(src).not.toContain("Behind the flag");
  });

  test("a component whose render IS decidable still gets its real spec", async () => {
    // The control: without it the refusal could fire for everything and both
    // assertions above would still pass.
    const src = await specFor(path.resolve(__dirname, "fixtures/ClassComponents.tsx"));
    expect(src).not.toContain("no render can be described");
    expect(src).toContain("renderTarget()");
  });
});

describe("no emitted test rests on a survival floor", () => {
  test("the DOM emitter no longer writes the container.firstElementChild floor", async () => {
    // Executed both ways before it was removed: vacuous under a provider (the
    // provider's own node answers it), red without one on a component that
    // legitimately unmounts. 88 of them across the dogfood app.
    const out = mkdtempSync(path.join(os.tmpdir(), "nofloor-"));
    try {
      const tree = await analyse({
        entry: path.resolve(__dirname, "fixtures/Dashboard.tsx"),
        depth: 0,
        includeChildren: false,
      });
      const files = renderUnitBrowser({ trees: [tree], outDir: out, variants: 3 });
      for (const f of files) {
        if (!f.relPath.endsWith(".test.tsx")) continue;
        expect(`${f.relPath}: ${f.content.includes("did not take the component down")}`).toBe(
          `${f.relPath}: false`,
        );
      }
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  test("a canary asserts something that CAN fail — nothing escaped the handler", async () => {
    // The floor's replacement is not another survival check. Executed: a throwing
    // handler leaves today's vitest test green and fails only the run, so naming
    // it in the test is strictly more than the floor ever did.
    const out = mkdtempSync(path.join(os.tmpdir(), "canary-"));
    try {
      const tree = await analyse({
        entry: path.resolve(__dirname, "fixtures/Dashboard.tsx"),
        depth: 0,
        includeChildren: false,
      });
      const files = renderUnitBrowser({ trees: [tree], outDir: out, variants: 3 });
      const withCanary = files.find((f) => f.content.includes("nothing escaped it"));
      if (withCanary) {
        expect(withCanary.content).toContain('window.addEventListener("error"');
        expect(withCanary.content).toContain("expect(escaped");
        // The listener must be removed even when the dispatch throws, or one
        // spec's canary starts catching the next one's errors.
        expect(withCanary.content).toContain("finally");
      }
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});

describe("the mount path makes no claim it cannot back", () => {
  async function specFor(fixture: string): Promise<string> {
    const out = mkdtempSync(path.join(os.tmpdir(), "mount-"));
    try {
      const tree = await analyse({
        entry: path.resolve(__dirname, fixture),
        depth: 0,
        includeChildren: false,
      });
      const files = renderUnitBrowser({ trees: [tree], outDir: out, variants: 3 });
      return files.find((f) => f.relPath.endsWith(".test.tsx"))?.content ?? "";
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  }

  test("no emitted spec asserts container.firstElementChild any more", async () => {
    // Proven vacuous by execution: a component whose whole body is `return null`,
    // rendered under the derived provider, PASSES that assertion — next-themes'
    // ThemeProvider injects a <script> and firstElementChild finds it.
    // DynamicTag and RenderHookBadge resolve NO host root tag, so they are the
    // components that reach the branch this is about. An earlier version listed
    // Card and Dashboard, which both resolve a root and take a different branch —
    // so reverting the fix left this green, which is a coverage gap, not a pass.
    for (const fx of [
      "fixtures/DynamicTag.tsx",
      "fixtures/RenderHookBadge.tsx",
      "fixtures/Dashboard.tsx",
    ]) {
      const src = await specFor(fx);
      expect(`${fx}: ${/^\s+expect\(container\.firstElementChild/m.test(src)}`).toBe(
        `${fx}: false`,
      );
    }
  });

  test("a known host root is asserted by NAME, which can fail", async () => {
    // The variant matrix used to use the same vacuous expression. Where the
    // analyser knows the component's own root it now names it — mutating a
    // component's root tag reddens every one of its variant rows.
    const src = await specFor("fixtures/Hello.tsx");
    // Hello resolves a <div> root and has literal-union props, so its variant rows
    // name the tag. Mutating the component's root reddens every one of them —
    // verified on the dogfood app's StatCard, all three rows.
    expect(src).toContain("rendered no <");
    expect(src).not.toMatch(/^\s+expect\(container\.firstElementChild/m);
  });

  test("with no resolvable root, the claim is only that mounting is safe", async () => {
    // Bail rather than guess. Comparing against a harness-only baseline WOULD
    // have a falsifier, and it turns four correct components red: Dialog, Sheet,
    // DropdownMenu and AlertDialog are compound ROOTS that render nothing until
    // opened, and nothing recorded distinguishes them from a component that
    // failed to render.
    const src = await specFor("fixtures/A11yOffender.tsx");
    if (src.includes("mounts at defaults without throwing")) {
      expect(src).toContain("not.toThrow()");
    }
  });
});

describe("an error boundary gets a real two-path spec, not a refusal", () => {
  test("both branches are driven, and the caught one silences React's log", async () => {
    const out = mkdtempSync(path.join(os.tmpdir(), "eb-"));
    try {
      const tree = await analyse({
        entry: path.resolve(__dirname, "fixtures/ClassBoundary.tsx"),
        depth: 0,
        includeChildren: false,
      });
      const src =
        renderUnitBrowser({ trees: [tree], outDir: out, variants: 3 }).find((f) =>
          f.relPath.endsWith(".test.tsx"),
        )?.content ?? "";
      expect(src).not.toContain("no render can be described");
      expect(src).toContain("renders its children when nothing throws");
      expect(src).toContain("renders its fallback when a child throws");
      expect(src).toContain("Something went wrong");
      // The spy is scoped to the caught case only — around the happy path it
      // would hide a real console error.
      expect(src).toContain('vi.spyOn(console, "error")');
      expect(src).toContain("logged.mockRestore()");
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});
