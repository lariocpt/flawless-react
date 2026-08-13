import { describe, expect, test } from "bun:test";
import { renderSuite } from "../src/scaffold/templates.ts";
import {
  allocateSpecNames,
  flattenTrees,
  hostEligibility,
} from "../src/scaffold-tests/registry.ts";
import type { ComponentInfo, ComponentTree } from "../src/types.ts";

function comp(name: string, extra: Partial<ComponentInfo> = {}): ComponentInfo {
  return {
    componentName: name,
    filePath: `/proj/src/${name}.tsx`,
    importSpecifier: `./${name}.tsx`,
    propsShape: {},
    variants: [],
    hooks: [],
    unresolvedProps: [],
    exportKind: "named",
    ...extra,
  };
}

function tree(entry: ComponentInfo, children: ComponentTree[] = []): ComponentTree {
  return { entry, children };
}

describe("flattenTrees", () => {
  test("keeps every component declared in one file", () => {
    // The perf host used to dedupe on filePath alone, so a file exporting seven
    // components contributed one — 84 of the dogfood app's 181 disappeared.
    const file = "/proj/src/card.tsx";
    const flat = flattenTrees([
      tree(comp("Card", { filePath: file }), [
        tree(comp("CardHeader", { filePath: file })),
        tree(comp("CardFooter", { filePath: file })),
      ]),
    ]);
    expect(flat.map((c) => c.info.componentName)).toEqual(["Card", "CardHeader", "CardFooter"]);
  });

  test("the same component reached twice appears once", () => {
    const shared = comp("Button");
    const flat = flattenTrees([tree(comp("A"), [tree(shared)]), tree(comp("B"), [tree(shared)])]);
    expect(flat.filter((c) => c.info.componentName === "Button")).toHaveLength(1);
  });
});

describe("allocateSpecNames", () => {
  test("same name in two files gets a parent-qualified alias", () => {
    const flat = flattenTrees([
      tree(comp("PollPage"), [tree(comp("CommentForm", { filePath: "/proj/src/a/x.tsx" }))]),
      tree(comp("JobPage"), [tree(comp("CommentForm", { filePath: "/proj/src/b/x.tsx" }))]),
    ]);
    const names = [...allocateSpecNames(flat).values()];
    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain("CommentForm");
    expect(names).toContain("JobPage__CommentForm");
  });
});

describe("hostEligibility", () => {
  test("only a mountable client component is hosted", () => {
    expect(hostEligibility(comp("Widget", { renderMode: "client" })).eligible).toBe(true);
  });

  test("everything else is excluded WITH a reason", () => {
    const cases: Array<[Partial<ComponentInfo>, RegExp]> = [
      [{ exportKind: "none" }, /not exported/],
      [{ renderMode: "rsc" }, /async server component/],
      [{ renderMode: "compound-part" }, /compound part|Root/],
      [{ renderMode: "document-root" }, /document root/],
      [{ renderMode: "null" }, /renders null/],
    ];
    for (const [extra, reason] of cases) {
      const verdict = hostEligibility(comp("X", extra));
      expect(verdict.eligible).toBe(false);
      expect(verdict.reason ?? "").toMatch(reason);
    }
  });
});

describe("renderSuite host", () => {
  function suite(trees: ComponentTree[]) {
    const [first, ...rest] = trees;
    return renderSuite({
      tree: first as ComponentTree,
      extraTrees: rest,
      outDir: "/proj/flawless",
      variants: 3,
      nextjsHost: true,
      report: false,
    });
  }
  const contentOf = (files: ReturnType<typeof suite>, rel: string) =>
    files.find((f) => f.relPath === rel)?.content ?? "";

  test("a default export is imported as a default, never as a binding", () => {
    const main = contentOf(
      suite([tree(comp("Widget", { exportKind: "default" }))]),
      "host/main.tsx",
    );
    expect(main).toContain('import Widget from "../../src/Widget";');
    expect(main).not.toContain("import { Widget }");
    // No .tsx: the target project type-checks the host.
    expect(main).not.toContain('"../../src/Widget.tsx"');
  });

  test("duplicate names are aliased so the module compiles", () => {
    const files = suite([
      tree(comp("PollPage"), [tree(comp("CommentForm", { filePath: "/proj/src/a/x.tsx" }))]),
      tree(comp("JobPage"), [tree(comp("CommentForm", { filePath: "/proj/src/b/x.tsx" }))]),
    ]);
    const main = contentOf(files, "host/main.tsx");
    // Two identical import identifiers in one module is a compile error, and it
    // took the whole bundle — and therefore every profile test — with it.
    expect(main).toContain("as JobPage__CommentForm");
    expect(main).toContain('"JobPage__CommentForm": JobPage__CommentForm as unknown as Component,');
    expect(files.map((f) => f.relPath)).toContain("profile/JobPage__CommentForm.profile.spec.ts");
  });

  test("siblings in one file each get a profile spec", () => {
    const file = "/proj/src/card.tsx";
    const files = suite([
      tree(comp("Card", { filePath: file }), [
        tree(comp("CardHeader", { filePath: file })),
        tree(comp("CardFooter", { filePath: file })),
      ]),
    ]);
    const paths = files.map((f) => f.relPath);
    expect(paths).toContain("profile/CardHeader.profile.spec.ts");
    expect(paths).toContain("profile/CardFooter.profile.spec.ts");
  });

  test("ineligible components are excluded and the README says why", () => {
    const files = suite([
      tree(comp("Widget", { renderMode: "client" })),
      tree(comp("Page", { renderMode: "rsc", isAsync: true })),
      tree(comp("DialogContent", { renderMode: "compound-part" })),
      tree(comp("Private", { exportKind: "none" })),
    ]);
    const main = contentOf(files, "host/main.tsx");
    expect(main).toContain('"Widget": Widget as unknown as Component,');
    for (const absent of ["Page", "DialogContent", "Private"]) {
      expect(main).not.toContain(`"${absent}":`);
    }
    // Silence would read as "everything is covered".
    const readme = contentOf(files, "README.md");
    expect(readme).toContain("Not in this host (3)");
    expect(readme).toContain("async server component");
    expect(readme).toContain("not exported");
  });
});
