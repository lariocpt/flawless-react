import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { analyse, analyseFile } from "../src/analyse/index.ts";
import { DEFAULT_EXCLUDES, expandGlob } from "../src/core.ts";

const FIXTURES = path.resolve(__dirname, "fixtures");
const tmpDirs: string[] = [];

function tmp(): string {
  const d = mkdtempSync(path.join(os.tmpdir(), "flawless-analysefile-"));
  tmpDirs.push(d);
  return d;
}

afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

const MULTI = `import type { FC } from "react";

interface RowProps {
  label: string;
}

function Row({ label }: RowProps) {
  return <li>{label}</li>;
}

function Hidden() {
  return <span>internal</span>;
}

export const List: FC<{ title: string }> = ({ title }) => (
  <ul>
    <Row label={title} />
    <Hidden />
  </ul>
);

export { Row };
`;

function writeMulti(): string {
  const dir = tmp();
  const file = path.join(dir, "List.tsx");
  writeFileSync(file, MULTI);
  return file;
}

describe("analyseFile roots", () => {
  test('roots "exported" returns one tree per exported component', async () => {
    const trees = await analyseFile({
      entry: writeMulti(),
      depth: 0,
      includeChildren: false,
      roots: "exported",
    });
    expect(trees.map((t) => t.entry.componentName).sort()).toEqual(["List", "Row"]);
  });

  test("a non-exported component is not a root but is still reachable as a child", async () => {
    const file = writeMulti();
    const trees = await analyseFile({
      entry: file,
      depth: 2,
      includeChildren: true,
      roots: "exported",
    });
    const list = trees.find((t) => t.entry.componentName === "List");
    expect(list).toBeDefined();
    const childNames = (list?.children ?? []).map((c) => c.entry.componentName);
    expect(childNames).toContain("Hidden");
  });

  test('roots "primary" matches analyse() exactly — the historical behaviour', async () => {
    const file = writeMulti();
    const trees = await analyseFile({
      entry: file,
      depth: 0,
      includeChildren: false,
      roots: "primary",
    });
    const single = await analyse({ entry: file, depth: 0, includeChildren: false });
    expect(trees).toHaveLength(1);
    expect(trees[0]?.entry.componentName).toBe(single.entry.componentName);
  });

  test("each root walks children independently — a shared visited set would starve the second", async () => {
    // Row is a child of List AND a root in its own right. With one shared
    // visited set the second root comes back empty.
    const trees = await analyseFile({
      entry: writeMulti(),
      depth: 2,
      includeChildren: true,
      roots: "exported",
    });
    for (const t of trees) expect(t.entry.componentName.length).toBeGreaterThan(0);
    const row = trees.find((t) => t.entry.componentName === "Row");
    expect(row?.entry.propsShape).toEqual({ label: "" });
  });

  test("defaults to primary when roots is omitted", async () => {
    const trees = await analyseFile({
      entry: writeMulti(),
      depth: 0,
      includeChildren: false,
    });
    expect(trees).toHaveLength(1);
  });
});

describe("expandGlob exclusions", () => {
  function seed(): string {
    const dir = tmp();
    mkdirSync(path.join(dir, "nested"), { recursive: true });
    writeFileSync(path.join(dir, "Foo.tsx"), "export const Foo = () => <p>a</p>;\n");
    writeFileSync(path.join(dir, "Foo.flawless.test.tsx"), "// generated\n");
    writeFileSync(path.join(dir, "Foo.test.tsx"), "// hand-written\n");
    writeFileSync(path.join(dir, "types.d.ts"), "export {};\n");
    writeFileSync(path.join(dir, "nested", "Bar.tsx"), "export const Bar = () => <p>b</p>;\n");
    return dir;
  }

  test("a glob never matches the specs the tool itself generated", async () => {
    const dir = seed();
    const found = await expandGlob(path.join(dir, "*.tsx"));
    expect(found).toEqual([path.join(dir, "Foo.tsx")]);
  });

  // `flawless-react src` (and the interactive prompt's empty submit, which
  // resolves "" to cwd) used to fall through to "Directories cannot be read
  // like files" — two messages, neither naming the mistake.
  test("a directory is a usage error that names the fix", async () => {
    const dir = seed();
    await expect(expandGlob(dir)).rejects.toThrow(/is a directory — pass a \.tsx file or a glob/);
    // Shell tab-completion hands over "src/" — the suggested glob must not
    // read "src//**/*.tsx".
    const message = await expandGlob(`${dir}/`).then(
      () => "",
      (err: Error) => err.message,
    );
    expect(message).toMatch(/is a directory/);
    expect(message).not.toContain("//");
  });

  test("--no-default-excludes restores the raw match", async () => {
    const dir = seed();
    const found = await expandGlob(path.join(dir, "*.tsx"), { useDefaultExcludes: false });
    expect(found.length).toBeGreaterThan(1);
  });

  test("extra excludes are appended to the defaults", async () => {
    const dir = seed();
    const found = await expandGlob(path.join(dir, "**/*.tsx"), { exclude: ["**/nested/**"] });
    expect(found).toEqual([path.join(dir, "Foo.tsx")]);
  });

  test("an explicit existing path beats every exclusion", async () => {
    const dir = seed();
    const spec = path.join(dir, "Foo.flawless.test.tsx");
    // Deliberately pointing at an excluded file must still work.
    expect(await expandGlob(spec)).toEqual([spec]);
  });

  test("the generated-spec pattern is first in the defaults", () => {
    expect(DEFAULT_EXCLUDES[0]).toBe("**/*.flawless.test.*");
  });

  test("existing fixtures still resolve through a glob", async () => {
    const found = await expandGlob(path.join(FIXTURES, "Dashboard.tsx"));
    expect(found).toHaveLength(1);
  });
});
