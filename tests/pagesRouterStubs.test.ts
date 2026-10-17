import { describe, expect, test } from "bun:test";
import { renderSuite } from "../src/scaffold/templates.ts";
import { renderUnitBrowser } from "../src/scaffold-tests/templates.ts";
import type { ComponentInfo } from "../src/types.ts";

/**
 * `next/router` is the PAGES-router router, and outside Next's App container
 * `useRouter()` throws "NextRouter was not mounted". talkformai dogfood: the
 * unit plane reached 0 passed / 26 failed because NavBar, DashboardMode and
 * SignInForm each read the router during render, and the perf host could not
 * mount them at all. Next provides no test router, so both planes ship their
 * own — same discipline as the next/navigation stand-in: navigate nowhere, and
 * define every documented field, because `router.query.id` is what a render
 * actually touches.
 */

const entry: ComponentInfo = {
  componentName: "Widget",
  filePath: "/proj/src/Widget.tsx",
  importSpecifier: "./Widget.tsx",
  propsShape: {},
  variants: [],
  hooks: [],
  unresolvedProps: [],
  moduleImports: [],
};

function setupSource(): string {
  return (
    renderUnitBrowser({
      trees: [{ entry, children: [] }],
      outDir: "/proj/flawless",
      variants: 3,
    }).find((f) => f.relPath === "setup.ts")?.content ?? ""
  );
}

describe("next/router stand-ins", () => {
  test("setup.ts mocks the pages router: navigation recorded, never performed", () => {
    const setup = setupSource();
    expect(setup).toContain('vi.mock("next/router",');
    expect(setup).toContain("push: vi.fn(async () => true)");
    // The fields a render reads: query for route params, pathname for prefix
    // logic, events for a component that subscribes on mount. An undefined one
    // is a second crash, not a quieter first one.
    expect(setup).toContain('pathname: "/"');
    expect(setup).toContain("query: {},");
    expect(setup).toContain("events: { on: vi.fn(), off: vi.fn(), emit: vi.fn() },");
    // withRouter is the HOC form of the same hook and real apps use it; a
    // missing export is a collection error for the whole file.
    expect(setup).toContain("withRouter:");
  });

  test("the perf host intercepts next/router where it intercepts next/navigation", () => {
    const host =
      renderSuite({
        tree: { entry, children: [] } as never,
        outDir: "/proj/flawless",
        variants: 3,
        report: false,
      }).find((f) => f.relPath === "host/server.ts")?.content ?? "";
    expect(host).toContain("flawless-next-router-stub");
    expect(host).toContain("export const useRouter = () => __router;");
    expect(host).toContain("export const withRouter =");
    // The \\.js variant is intercepted too — bundled library output asks for it.
    expect(host).toContain("router(\\.js)?");
  });
});
