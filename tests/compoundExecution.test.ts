import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runCore } from "../src/core.ts";
import { suitePackageJson } from "../src/scaffold-tests/index.ts";

/**
 * B-2 end to end, by EXECUTING the emitted specs against a minimal fake
 * radix-style package whose parts genuinely THROW outside their Root. Two
 * runs carry the proof:
 *  - the generated family-wrapped specs are green (the wrapper mounts the
 *    part the way call sites do);
 *  - a hand-written bare-part spec is RED with the context error — the
 *    wrapper is load-bearing, not decoration.
 */

const DIALOG_TSX = `import * as DialogPrimitive from "@radix-ui/react-dialog";
import type * as React from "react";

export function Dialog(props: Record<string, unknown>) {
  return <DialogPrimitive.Root {...props} />;
}

export function DialogTrigger({ children }: { children?: React.ReactNode }) {
  return <DialogPrimitive.Trigger>{children}</DialogPrimitive.Trigger>;
}

export function DialogContent({ children }: { children?: React.ReactNode }) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay />
      <DialogPrimitive.Content>{children}</DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

export function DialogHeader({ children }: { children?: React.ReactNode }) {
  return <DialogPrimitive.Title>{children}</DialogPrimitive.Title>;
}

export function DialogOverlay() {
  return <DialogPrimitive.Overlay />;
}

export function DialogDismiss() {
  return <DialogPrimitive.Trigger />;
}
`;

/**
 * The fake primitive: context-gated like the real thing. Every part throws
 * without the Root's provider, Content renders only while open, and Portal
 * really portals to document.body — the portal-aware assertion axis.
 */
const FAKE_PKG = `"use strict";
const React = require("react");
const ReactDOM = require("react-dom");
const Ctx = React.createContext(null);

function useCtx(part) {
  const ctx = React.useContext(Ctx);
  if (!ctx) throw new Error("DialogContext missing: " + part + " must be used within Root");
  return ctx;
}

exports.Root = function Root({ open, children }) {
  return React.createElement(Ctx.Provider, { value: { open: !!open } }, children);
};
exports.Trigger = function Trigger({ children, ...props }) {
  useCtx("Trigger");
  return React.createElement("button", { type: "button", ...props }, children);
};
exports.Portal = function Portal({ children }) {
  const ctx = useCtx("Portal");
  return ctx.open ? ReactDOM.createPortal(children, document.body) : null;
};
exports.Overlay = function Overlay(props) {
  useCtx("Overlay");
  return React.createElement("div", { "data-overlay": "", ...props });
};
exports.Content = function Content({ children, ...props }) {
  const ctx = useCtx("Content");
  if (!ctx.open) return null;
  // Renders the child TWICE, on purpose. Real primitives do: a radix Select
  // mounted without its Trigger renders a mirror <option> for the bubble
  // select, and radix Tooltip 1.0.x renders children again inside a
  // VisuallyHidden node. getByText throws on multiple matches, so an emitted
  // assertion built on it goes red against a perfectly healthy component —
  // which is exactly what shipped until the review caught it. Duplicating here
  // is what keeps this gate able to see that class at all.
  return React.createElement(
    "div",
    { role: "dialog", ...props },
    children,
    React.createElement("span", { hidden: true }, children),
  );
};
exports.Title = function Title({ children, ...props }) {
  useCtx("Title");
  return React.createElement("h2", props, children);
};
`;

const BARE_CONTROL = `import { test } from "vitest";
import { render } from "@testing-library/react";
import { DialogHeader } from "../../src/dialog";

test("a bare part outside its Root", () => {
  render(<DialogHeader>bare</DialogHeader>);
});
`;

// The childless branch's assertion, applied to a part that renders nothing.
// A trigger's wrapper is a bare <Root> — a context provider that renders no DOM
// of its own — so the only element left under baseElement is render()'s own
// container div and the count is 1. If this control ever goes GREEN, the
// assertion the generator emits for every childless part has stopped meaning
// anything, and DialogDismiss passing below proves nothing.
const NULL_PART_CONTROL = `import { test, expect } from "vitest";
import { render } from "@testing-library/react";
import { Dialog } from "../../src/dialog";

function NullPart() {
  return null;
}

test("a childless part that renders nothing", () => {
  const { baseElement } = render(<Dialog><NullPart /></Dialog>);
  expect(baseElement.querySelectorAll("*").length).toBeGreaterThan(1);
});
`;

function suitePins(): string[] {
  const pkg = JSON.parse(suitePackageJson("/x/flawless", false)) as {
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
  };
  const all = { ...pkg.dependencies, ...pkg.devDependencies };
  return [
    "react",
    "react-dom",
    "vitest",
    "jsdom",
    "@testing-library/react",
    "@testing-library/user-event",
    "@testing-library/jest-dom",
  ].map((name) => {
    const range = all[name];
    if (range === undefined) throw new Error(`the emitted suite no longer pins ${name}`);
    return `${name}@${range}`;
  });
}

let tmpRoot: string | undefined;

afterAll(() => {
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
});

describe("family-wrapped compound specs, executed", () => {
  test("the wrapped specs are green; the bare part is red — the wrapper is load-bearing", async () => {
    tmpRoot = await mkdtemp(path.join(tmpdir(), "flawless-compound-exec-"));
    const app = path.join(tmpRoot, "app");
    mkdirSync(path.join(app, "src"), { recursive: true });
    writeFileSync(
      path.join(app, "tsconfig.json"),
      `${JSON.stringify({ compilerOptions: { jsx: "react-jsx", strict: true } }, null, 2)}\n`,
    );
    writeFileSync(path.join(app, "src", "dialog.tsx"), DIALOG_TSX);
    const outDir = path.join(app, "flawless");

    const result = await runCore({
      pattern: path.join(app, "src", "dialog.tsx"),
      outDir,
      taskIds: ["unit-browser"],
      roots: "exported",
      force: true,
      log: false,
      inlineSummary: false,
    });
    expect(result.exitCode).toBe(0);

    // Emission first: the parts got real mount specs, not typeof skips.
    const headerSpec = readFileSync(path.join(outDir, "unit", "DialogHeader.test.tsx"), "utf8");
    expect(headerSpec).toContain("<Dialog open>");
    expect(headerSpec).toContain("<DialogContent>");
    expect(headerSpec).not.toContain("is exported as a component");
    const triggerSpec = readFileSync(path.join(outDir, "unit", "DialogTrigger.test.tsx"), "utf8");
    expect(triggerSpec).toContain("<Dialog>");
    expect(triggerSpec).not.toContain("<Dialog open>");
    // A part taking no children takes the other emission branch, which has no
    // child text to witness and counts document elements instead. Pin that the
    // branch was actually taken, so the run below is executing it.
    const overlaySpec = readFileSync(path.join(outDir, "unit", "DialogOverlay.test.tsx"), "utf8");
    expect(overlaySpec).toContain(
      'expect(baseElement.querySelectorAll("*").length).toBeGreaterThan(1)',
    );
    expect(overlaySpec).not.toContain("flawless-slot");

    const install = Bun.spawn(["bun", "add", "-d", ...suitePins()], {
      cwd: app,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [installErr, installCode] = await Promise.all([
      new Response(install.stderr).text(),
      install.exited,
    ]);
    if (installCode !== 0) {
      throw new Error(
        `could not install the suite's runners (needs registry access):\n${installErr}`,
      );
    }
    // The fake primitive lands AFTER the install so nothing prunes it.
    const pkgDir = path.join(app, "node_modules", "@radix-ui", "react-dialog");
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(
      path.join(pkgDir, "package.json"),
      `${JSON.stringify({ name: "@radix-ui/react-dialog", version: "0.0.0-flawless-fake", main: "index.js" }, null, 2)}\n`,
    );
    writeFileSync(path.join(pkgDir, "index.js"), FAKE_PKG);

    const vitestBin = path.join(app, "node_modules", ".bin", "vitest");
    if (!existsSync(vitestBin)) throw new Error(`vitest did not install at ${vitestBin}`);
    const vitest = async (...specs: string[]): Promise<{ code: number; output: string }> => {
      const run = Bun.spawn([vitestBin, "run", ...specs], {
        cwd: outDir,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [out, err, code] = await Promise.all([
        new Response(run.stdout).text(),
        new Response(run.stderr).text(),
        run.exited,
      ]);
      return { code, output: out + err };
    };

    // The five wrapped part specs, green against the throwing primitive.
    // DialogOverlay and DialogDismiss take no children and so exercise the
    // other emission branch; DialogDismiss is a trigger, whose wrapper is a
    // bare Root that renders no DOM, which is the shape where that branch's
    // count assertion can actually fail. (The Root's OWN spec is out of scope:
    // a context-provider Root with no children legitimately renders nothing,
    // and its default smoke spec is a pre-existing question B-2 does not touch.)
    const generated = await vitest(
      "unit/DialogHeader.test.tsx",
      "unit/DialogTrigger.test.tsx",
      "unit/DialogContent.test.tsx",
      "unit/DialogOverlay.test.tsx",
      "unit/DialogDismiss.test.tsx",
    );
    if (generated.code !== 0) console.error(generated.output);
    expect(generated.code).toBe(0);
    expect(generated.output).not.toContain("DialogContext missing");

    // The control proves the fake package genuinely gates on the Root: the
    // SAME part, bare, is red with the context error. Without this, green
    // above could mean the primitive never checked anything.
    writeFileSync(path.join(outDir, "unit", "zBareControl.test.tsx"), BARE_CONTROL);
    const control = await vitest("unit/zBareControl.test.tsx");
    expect(control.code).not.toBe(0);
    expect(control.output).toContain("DialogContext missing");

    // Second control, for the childless branch: the same assertion the
    // generator emits for DialogDismiss, applied to a part that renders
    // nothing, must be RED. Green here would mean the count assertion passes
    // whatever the part does, and DialogDismiss's green above is worth nothing.
    writeFileSync(path.join(outDir, "unit", "zNullPartControl.test.tsx"), NULL_PART_CONTROL);
    const nullPart = await vitest("unit/zNullPartControl.test.tsx");
    expect(nullPart.code).not.toBe(0);
    expect(nullPart.output).toContain("to be greater than 1");
  }, 120_000);
});
