import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
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
