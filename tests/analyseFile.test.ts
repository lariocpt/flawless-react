import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { analyse, analyseFile } from "../src/analyse/index.ts";
import { ModuleResolver } from "../src/analyse/resolveModule.ts";
import { SourceFileCache } from "../src/analyse/sourceCache.ts";
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

describe("wrapper components keep their declared props type (FR-011)", () => {
  async function analysed(source: string): Promise<import("../src/types.ts").ComponentInfo> {
    const dir = tmp();
    const file = path.join(dir, "Widget.tsx");
    writeFileSync(file, source);
    const t = await analyse({ entry: file, depth: 0, includeChildren: false });
    return t.entry;
  }

  test("forwardRef<E, Props> feeds Props to extraction", async () => {
    const info = await analysed(`import { forwardRef } from "react";

interface Props {
  label: string;
  count: number;
}

export const Widget = forwardRef<HTMLDivElement, Props>(function Widget({ label, count }, ref) {
  return (
    <div ref={ref}>
      {label}
      {count}
    </div>
  );
});
`);
    expect(info.wrappers).toEqual(["forwardRef"]);
    expect(info.propsShape).toEqual({ label: "", count: 0 });
  });

  test("const X: FC<Props> = memo(...) keeps the declared Props", async () => {
    const info = await analysed(`import { memo } from "react";
import type { FC } from "react";

interface Props {
  title: string;
}

export const Widget: FC<Props> = memo(({ title }) => <div>{title}</div>);
`);
    expect(info.wrappers).toEqual(["memo"]);
    expect(info.propsShape).toEqual({ title: "" });
  });

  test("memo<Props> generic argument is the props type", async () => {
    const info = await analysed(`import { memo } from "react";

interface Props {
  text: string;
}

export const Widget = memo<Props>((props) => <span>{props.text}</span>);
`);
    expect(info.propsShape).toEqual({ text: "" });
  });

  test("React.-qualified and nested wrappers resolve through the innermost type args", async () => {
    const info = await analysed(`import * as React from "react";

interface Props {
  name: string;
}

export const Widget = React.memo(
  React.forwardRef<HTMLButtonElement, Props>(function Widget({ name }, ref) {
    return (
      <button type="button" ref={ref}>
        {name}
      </button>
    );
  }),
);
`);
    expect(info.wrappers).toEqual(["memo", "forwardRef"]);
    expect(info.propsShape).toEqual({ name: "" });
  });
});

describe("analyseFile shared context", () => {
  const LEAF = `export function Leaf({ label }: { label: string }) {
  return <em>{label}</em>;
}
`;
  const entrySrc = (name: string) => `import { Leaf } from "./Leaf.tsx";

export function ${name}() {
  return (
    <div>
      <Leaf label="${name}" />
    </div>
  );
}
`;

  test("two entries sharing one context parse a shared leaf once", async () => {
    const dir = tmp();
    const leafAbs = path.join(dir, "Leaf.tsx");
    writeFileSync(leafAbs, LEAF);
    writeFileSync(path.join(dir, "EntryA.tsx"), entrySrc("EntryA"));
    writeFileSync(path.join(dir, "EntryB.tsx"), entrySrc("EntryB"));

    // Counting probe: record every SourceFile the shared cache hands out for
    // the leaf DURING analysis. Asserting on cache contents afterwards would
    // pass vacuously (the assert itself would populate the cache).
    const cache = new SourceFileCache();
    const seenLeafParses: unknown[] = [];
    const origGet = cache.get.bind(cache);
    cache.get = (abs: string) => {
      const sf = origGet(abs);
      if (abs === leafAbs && sf) seenLeafParses.push(sf);
      return sf;
    };
    const shared = { cache, resolver: new ModuleResolver() };

    await analyseFile(
      { entry: path.join(dir, "EntryA.tsx"), depth: 2, includeChildren: true },
      shared,
    );
    await analyseFile(
      { entry: path.join(dir, "EntryB.tsx"), depth: 2, includeChildren: true },
      shared,
    );

    // Each entry must fetch the leaf THROUGH the shared cache — TWICE: once
    // resolving <Leaf> as a tag target (what host element does it render?),
    // once analysing it as a child. A count below 4 means one of those hops
    // parsed the file on its own, invisibly to this probe: resolveTagRootTags
    // did exactly that, re-parsing every tag target once per entry.
    expect(seenLeafParses.length).toBeGreaterThanOrEqual(4);
    // …and every fetch must receive the SAME parsed object — one parse for the
    // corpus, not one per entry (FR-032: card.tsx parsed 237x in the dogfood
    // sweep).
    for (const sf of seenLeafParses) expect(sf).toBe(seenLeafParses[0] as object);
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

describe("input that TypeScript cannot parse cleanly", () => {
  // ts.createSourceFile is error-tolerant: `return <div>` with no closing tag
  // still yields a tree, and every extractor downstream reads it as if it were
  // the source. Before this guard the tool analysed such a file, described it,
  // and reported `ok: true, 0 findings` — a clean run over something that does
  // not compile.
  //
  // The asymmetry is the point: parseDiagnostics is asserted in five test files,
  // every one of them on the tool's OUTPUT, and nowhere on its input.
  const tmp = (name: string, body: string): string => {
    const d = mkdtempSync(path.join(os.tmpdir(), "flawless-parse-"));
    const f = path.join(d, name);
    writeFileSync(f, body);
    return f;
  };

  test("is refused, with the error and the line named", async () => {
    const f = tmp("Broken.tsx", "export const X = () => {\n  return <div>\n");
    expect(analyseFile({ entry: f, depth: 0, includeChildren: false })).rejects.toThrow(
      /syntax error\(s\) and cannot be analysed honestly/,
    );
    await analyseFile({ entry: f, depth: 0, includeChildren: false }).catch((e: Error) => {
      expect(e.message).toContain("has no corresponding closing tag");
      expect(e.message).toMatch(/at line 2/);
      // The escape has to be nameable, or the user's only option is to guess.
      expect(e.message).toContain("--exclude");
    });
  });

  test("valid TSX is untouched — the guard fires only on genuinely broken input", async () => {
    // Measured before shipping: 111 fixture files and 241 real component files
    // across both dogfood apps produce ZERO parse diagnostics. A guard that
    // fired on ordinary source would be worse than the defect it replaces.
    const f = tmp("Fine.tsx", "export const X = () => <div>hi</div>;\n");
    const trees = await analyseFile({ entry: f, depth: 0, includeChildren: false });
    expect(trees[0]?.entry.componentName).toBe("X");
  });
});
