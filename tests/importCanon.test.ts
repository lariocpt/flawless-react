import { describe, expect, test } from "bun:test";
import {
  canonicalizeImportText,
  classifySource,
  cldrCmp,
  finalizeEmittedImports,
  importSourceCmp,
  markTypeOnlySpecifier,
  sourceCollate,
} from "../src/importCanon.ts";

// These pins are not invented: every ordering below is either a unit test that
// shipped with biome 2.5.1's collation sources, an order the 2.5.1 binary
// produces on the emitted corpus, or a shape probed directly against the
// binary (chunk splitting, blank-line attachment, header handling).

describe("cldrCmp (identifier order)", () => {
  test("uppercase sorts before its own lowercase, interleaved per CLDR", () => {
    expect(cldrCmp("A", "a")).toBeLessThan(0);
    expect(cldrCmp("a", "B")).toBeLessThan(0);
    expect(cldrCmp("B", "b")).toBeLessThan(0);
  });
  test("observed specifier orders", () => {
    const pairs: [string, string][] = [
      ["HttpResponse", "http"], // handlers.ts
      ["expect", "Page"], // e2e specs
      ["Page", "test"],
      ["beforeEach", "expect"], // colocated specs
      ["expect", "test"],
      ["test", "vi"],
      ["createContext", "ReactNode"], // store-provider spec
      ["ReactNode", "useContext"],
      ["useContext", "useRef"],
      ["fooBar", "foobar"], // case tie breaks by codepoint
      ["foobar", "foobaz"],
      ["ABC", "abc"],
      ["Apple", "apple"],
    ];
    for (const [x, y] of pairs) expect(cldrCmp(x, y)).toBeLessThan(0);
  });
});

describe("sourceCollate (module-source order)", () => {
  test("pairs from biome 2.5.1's own import_source tests", () => {
    const sorted = [
      "a.js",
      "a a.js",
      "a_a.js",
      "a-a.js",
      "a+a.js",
      "a*a.js",
      "https://example.org/path?prop=val",
      "https://example.org/path?prop-1=val",
      "https://example.org/path?prop-1=val#frag",
      "https://example.org/path?prop-1=val&prop2=val",
      "https://example.org/path?prop-1=val-1&prop-2=val-2",
      "https://example.org/path#frag",
      "https://example.org/path-a",
    ];
    for (let i = 0; i + 1 < sorted.length; i++) {
      const x = sorted[i];
      const y = sorted[i + 1];
      if (x === undefined || y === undefined) continue;
      expect(sourceCollate(x, y)).toBeLessThan(0);
    }
  });
  test("natural digits and path separators", () => {
    expect(sourceCollate("./path9", "./path10")).toBeLessThan(0);
    expect(sourceCollate("path/a", "path-a")).toBeLessThan(0);
  });
});

describe("classifySource / importSourceCmp", () => {
  test("kinds", () => {
    expect(classifySource("react")).toBe("package");
    expect(classifySource("@testing-library/react")).toBe("package");
    expect(classifySource("node:fs")).toBe("protocol");
    expect(classifySource("https://example.org/x")).toBe("url");
    expect(classifySource("./x")).toBe("path");
    expect(classifySource("../x")).toBe("path");
    expect(classifySource("/x")).toBe("path");
    expect(classifySource("@/x")).toBe("alias");
  });
  test("kind order: protocol < package < alias < path", () => {
    expect(importSourceCmp("node:fs", "bun")).toBeLessThan(0);
    expect(importSourceCmp("bun", "@/alias")).toBeLessThan(0);
    expect(importSourceCmp("@/alias", "./local")).toBeLessThan(0);
  });
  test("path proximity: more parents first, then ./", () => {
    expect(importSourceCmp("../../flawless/provider", "../budgets.json")).toBeLessThan(0);
    expect(importSourceCmp("../budgets.json", "./_heap")).toBeLessThan(0);
  });
  test("registry.ts order: InboxList < providers < ReportTitle", () => {
    expect(
      importSourceCmp("../../src/components/InboxList", "../../src/components/providers/sp"),
    ).toBeLessThan(0);
    expect(
      importSourceCmp("../../src/components/providers/sp", "../../src/components/ReportTitle"),
    ).toBeLessThan(0);
  });
});

describe("canonicalizeImportText", () => {
  const stampLine = "// @flawless-generated sha256:dd32752051d9813d flawless-react@0.3.1";

  test("sorts named specifiers by local name", () => {
    const out = canonicalizeImportText(
      `import { test, expect, vi, beforeEach } from "vitest";\nvoid test; void expect; void vi; void beforeEach;\n`,
    );
    expect(out.split("\n")[0]).toBe('import { beforeEach, expect, test, vi } from "vitest";');
  });

  test("sorts statements by source kind", () => {
    const out = canonicalizeImportText(
      `import type { BunPlugin } from "bun";\nimport path from "node:path";\nimport { readFileSync } from "node:fs";\n\nvoid path; void readFileSync;\n`,
    );
    expect(out.split("\n").slice(0, 3).join("\n")).toBe(
      [
        'import { readFileSync } from "node:fs";',
        'import path from "node:path";',
        'import type { BunPlugin } from "bun";',
      ].join("\n"),
    );
  });

  test("same source: namespaceType sorts before named", () => {
    const out = canonicalizeImportText(
      `import { cloneElement } from "react";\nimport type * as React from "react";\nvoid cloneElement;\n`,
    );
    expect(out.split("\n")[0]).toBe('import type * as React from "react";');
  });

  test("bare import is its own chunk and stays put", () => {
    const out = canonicalizeImportText(
      `import { b } from "bbb";\nimport "a-side";\nimport { a } from "aaa";\nconsole.log(a, b);\n`,
    );
    expect(out).toBe(
      `import { b } from "bbb";\nimport "a-side";\nimport { a } from "aaa";\n\nconsole.log(a, b);\n`,
    );
  });

  test("attached comment travels with its import; blank line before code", () => {
    const out = canonicalizeImportText(
      `import "side";\nimport { b } from "bbb";\n// explains a\nimport { a } from "aaa";\nconsole.log(a, b);\n`,
    );
    expect(out).toBe(
      `import "side";\n// explains a\nimport { a } from "aaa";\nimport { b } from "bbb";\n\nconsole.log(a, b);\n`,
    );
  });

  test("setup.ts shape: blank+comment attach to the moved import", () => {
    const out = canonicalizeImportText(
      `import "side";\nimport { vi } from "vitest";\nimport { s } from "./m";\n\n// explains hooks\nimport * as nm from "node:module";\n{\n  const x = nm;\n  console.log(vi, s, x);\n}\n`,
    );
    expect(out).toBe(
      `import "side";\n\n// explains hooks\nimport * as nm from "node:module";\nimport { vi } from "vitest";\nimport { s } from "./m";\n\n{\n  const x = nm;\n  console.log(vi, s, x);\n}\n`,
    );
  });

  test("blank line inside a run collapses when statements move", () => {
    const out = canonicalizeImportText(
      `import { b } from "bbb";\n\nimport { a } from "aaa";\nconsole.log(a, b);\n`,
    );
    expect(out).toBe(`import { a } from "aaa";\nimport { b } from "bbb";\n\nconsole.log(a, b);\n`);
  });

  test("reordering adds the blank line after a header comment", () => {
    const out = canonicalizeImportText(
      `${stampLine}\nimport { test, expect } from "vitest";\nimport { render } from "@testing-library/react";\n\nvoid test; void expect; void render;\n`,
    );
    expect(out.split("\n").slice(0, 4).join("\n")).toBe(
      `${stampLine}\n\nimport { render } from "@testing-library/react";\nimport { expect, test } from "vitest";`,
    );
  });

  test("specifier-only fix leaves the header comment alone", () => {
    const out = canonicalizeImportText(
      `${stampLine}\nimport { render } from "@testing-library/react";\nimport { test, expect } from "vitest";\n\nvoid test; void expect; void render;\n`,
    );
    expect(out.split("\n").slice(0, 3).join("\n")).toBe(
      `${stampLine}\nimport { render } from "@testing-library/react";\nimport { expect, test } from "vitest";`,
    );
  });

  test("sorted statements with unsorted specifiers need no blank after header", () => {
    // h5 probe: header + sorted imports + code with no blank line.
    const out = canonicalizeImportText(
      `${stampLine}\nimport { render } from "@testing-library/react";\nimport { expect, test } from "vitest";\nconst x = render + expect + test;\nvoid x;\n`,
    );
    expect(out.split("\n").slice(0, 4).join("\n")).toBe(
      `${stampLine}\nimport { render } from "@testing-library/react";\nimport { expect, test } from "vitest";\n`,
    );
  });

  test("multiline specifier lists sort in place", () => {
    const out = canonicalizeImportText(
      `import { takeHeapSnapshot, clearScanEvents } from "./_heap";\nimport {\n  measure,\n  bracketScenario,\n} from "./_helpers";\nvoid takeHeapSnapshot; void clearScanEvents; void bracketScenario; void measure;\n`,
    );
    expect(out).toContain('import {\n  bracketScenario,\n  measure,\n} from "./_helpers";');
  });

  test("second import run after code gets a blank line before it", () => {
    const out = canonicalizeImportText(
      `import { act } from "@testing-library/react";\n\nvi.mock("@/lib/data", () => ({}));\nimport AppProvider from "../../flawless/provider";\nvoid act; void AppProvider;\n`,
    );
    expect(out).toBe(
      `import { act } from "@testing-library/react";\n\nvi.mock("@/lib/data", () => ({}));\n\nimport AppProvider from "../../flawless/provider";\n\nvoid act; void AppProvider;\n`,
    );
  });

  test("idempotent on every case above", () => {
    const inputs = [
      `import { test, expect } from "vitest";\nvoid test; void expect;\n`,
      `${stampLine}\nimport { test } from "vitest";\nvoid test;\n`,
      `import "side";\nimport { vi } from "vitest";\n\n// c\nimport * as nm from "node:module";\nvoid vi; void nm;\n`,
    ];
    for (const src of inputs) {
      const once = canonicalizeImportText(src);
      expect(canonicalizeImportText(once)).toBe(once);
    }
  });
});

describe("markTypeOnlySpecifier", () => {
  test("marks vi when only typeof-used", () => {
    const out = markTypeOnlySpecifier(
      `import { describe, test, expect, vi, beforeEach } from "vitest";\nconst h: Record<string, ReturnType<typeof vi.fn>> = {};\nvoid describe; void test; void beforeEach; void h;\n`,
      "vi",
    );
    expect(out.split("\n")[0]).toBe(
      'import { describe, test, expect, type vi, beforeEach } from "vitest";',
    );
  });
  test("leaves vi alone when value-used", () => {
    const src = `import { test, vi } from "vitest";\nvi.mock("x", () => ({}));\nvoid test;\n`;
    expect(markTypeOnlySpecifier(src, "vi")).toBe(src);
  });
  test("leaves vi alone when void-used (RSC doc-root shape)", () => {
    const src = `import { test, expect, vi } from "vitest";\nvoid vi;\nvoid test; void expect;\n`;
    expect(markTypeOnlySpecifier(src, "vi")).toBe(src);
  });
  test("leaves an already-marked specifier alone", () => {
    const src = `import { test, type vi } from "vitest";\nconst h: ReturnType<typeof vi.fn> = {};\nvoid test; void h;\n`;
    expect(markTypeOnlySpecifier(src, "vi")).toBe(src);
  });
});

describe("finalizeEmittedImports", () => {
  test("marks and sorts in one pass, idempotently", () => {
    const src = `import { describe, test, expect, vi, beforeEach } from "vitest";\nimport { render } from "@testing-library/react";\nconst h: Record<string, ReturnType<typeof vi.fn>> = {};\nvoid describe; void test; void beforeEach; void h; void render;\n`;
    const once = finalizeEmittedImports(src);
    expect(once.split("\n")[0]).toBe('import { render } from "@testing-library/react";');
    expect(once).toContain('import { beforeEach, describe, expect, test, type vi } from "vitest";');
    expect(finalizeEmittedImports(once)).toBe(once);
  });
});
