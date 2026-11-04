// Every emitted .ts/.tsx byte must already be a fixed point of
// finalizeEmittedImports when it hits disk — a host with no resolvable biome
// gets no style pass, and the two paths pinned here were exactly the ones
// that never got wired: the e2e route-spec write (src/tasks/e2eRoutes.ts)
// and the mocks/handlers.ts write (src/nextjs/emit.ts). On the no-style arm
// they carried the only 5 organizeImports errors a fresh regen left behind
// (4 route specs + handlers.ts), measured on 6dcb475 with the startup PATH
// stripped. The shapes below are the two biome 2.5.1 flagged:
// `{ test, expect, type Page }` (plus no blank line before const ROUTE) and
// `{ http, HttpResponse }`.

import { describe, expect, test } from "bun:test";
import { finalizeEmittedImports } from "../src/importCanon.ts";
import { renderHandlers } from "../src/nextjs/emit.ts";
import { routeSpecForTest } from "../src/tasks/e2eRoutes.ts";
import type { ComponentTree, NextjsApiRoute } from "../src/types.ts";

const tree: ComponentTree = {
  entry: {
    componentName: "ThingPage",
    filePath: "src/app/things/page.tsx",
    importSpecifier: "./page",
    propsShape: {},
    variants: [],
    hooks: [],
    unresolvedProps: [],
  },
  children: [],
};

const ROUTES = [
  { urlPath: "/things", params: [], specStem: "things" },
  { urlPath: "/things/[id]", params: ["id"], specStem: "things-id" },
];

describe("routeSpec bytes", () => {
  for (const route of ROUTES) {
    test(`${route.urlPath}: finalized bytes are a fixed point in biome's canonical form`, () => {
      const raw = routeSpecForTest(tree, route, "flawless");
      const emitted = finalizeEmittedImports(raw);
      expect(finalizeEmittedImports(emitted)).toBe(emitted);
      // The exact shape biome 2.5.1's organizeImports rewrote the raw line to.
      expect(emitted).toContain('import { expect, type Page, test } from "@playwright/test";');
      // organizeImports separates the import chunk from the code below it.
      expect(emitted).toContain('from "./params";\n\nconst ROUTE');
    });
  }
});

describe("handlers.ts bytes", () => {
  const routes: NextjsApiRoute[] = [
    {
      path: "/api/things/{id}",
      methods: ["GET", "POST"],
      file: "src/app/api/things/[id]/route.ts",
    },
  ];
  test("the render closure's bytes are a fixed point in biome's canonical form", () => {
    const emitted = renderHandlers("0123456789abcdef", routes);
    expect(finalizeEmittedImports(emitted)).toBe(emitted);
    // The exact shape biome 2.5.1's organizeImports rewrote the raw line to.
    expect(emitted).toContain('import { HttpResponse, http } from "msw";');
    // The stamp sits above the finalized bytes, so its hash covers them.
    expect(emitted.split("\n")[0]).toMatch(/^\/\/ @flawless-generated sha256:[0-9a-f]{16}/);
    expect(emitted.split("\n")[1]).toBe("// @flawless-spec sha256:0123456789abcdef");
  });
});
