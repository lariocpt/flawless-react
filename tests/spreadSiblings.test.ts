import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseFile } from "../src/analyse/parseFile.ts";
import { SourceFileCache } from "../src/analyse/sourceCache.ts";
import { inheritSpreadSiblingProps } from "../src/analyse/spreadSiblings.ts";

const SOURCE = `
'use client';
import { usePathname } from 'next/navigation';
import type { Route } from 'next';
import type Link from 'next/link';

type RenderProps = { isActive: boolean };
type Renderable<T> = T | ((props: RenderProps) => T);

type Props<T extends string = string> = Omit<React.ComponentProps<typeof Link>, 'href' | 'className' | 'children'> & {
  href: Route<T> | URL;
  className?: Renderable<string | undefined>;
  children?: Renderable<React.ReactNode>;
  exact?: boolean;
};

export function NavLink<T extends string>(props: Props<T>) {
  return (
    <Suspense fallback={<NavLinkShell {...props} isActive={false} />}>
      <NavLinkInner {...props} />
    </Suspense>
  );
}

function NavLinkInner<T extends string>(props: Props<T>) {
  const pathname = usePathname();
  const isActive = pathname === props.href.toString() && !!props.exact;
  return <NavLinkShell {...props} isActive={isActive} />;
}

function NavLinkShell<T extends string>({
  href,
  className,
  children,
  exact,
  isActive,
  ...rest
}: Props<T> & { isActive: boolean }) {
  return (
    <a href={href as string} className={className as string} data-exact={exact || undefined}>
      {children}
    </a>
  );
}
`;

async function navLinkUnit() {
  const dir = mkdtempSync(path.join(tmpdir(), "flawless-spread-"));
  const file = path.join(dir, "nav-link.tsx");
  writeFileSync(file, SOURCE);
  const parsed = await parseFile(file, new SourceFileCache());
  const unit = parsed.components.find((c) => c.componentName === "NavLink");
  if (!unit) throw new Error("NavLink component was not parsed");
  return { unit, parsed };
}

describe("inheritSpreadSiblingProps", () => {
  test("a props-forwarding wrapper inherits prop names and member reads from siblings", async () => {
    const { unit, parsed } = await navLinkUnit();
    // The type layer resolves nothing for `Omit<…> & {…}` — that is the bug's
    // premise; the pass must work from zero known props.
    const unresolved: string[] = [];
    const usage: import("../src/types.ts").PropUsage[] = [];
    inheritSpreadSiblingProps(
      unit,
      parsed.components,
      new Set<string>(),
      unresolved,
      usage,
      parsed.sourceFile,
    );
    // href is read via props.href.toString() in NavLinkInner — the member
    // read is what tells the {} floor its value survives .toString().
    expect(unresolved).toContain("href");
    expect(usage.some((u) => u.propName === "href" && u.member === "toString")).toBe(true);
    // exact reaches NavLinkShell only through the chain, proving transitivity.
    expect(unresolved).toContain("exact");
    // children/className never take a value floor — {} is an invalid child and
    // renders "[object Object]" as a class.
    expect(unresolved).not.toContain("children");
    expect(unresolved).not.toContain("className");
  });

  test("props the wrapper already resolves are left alone", async () => {
    const { unit, parsed } = await navLinkUnit();
    const usage: import("../src/types.ts").PropUsage[] = [];
    inheritSpreadSiblingProps(
      unit,
      parsed.components,
      new Set<string>(["href"]),
      [],
      usage,
      parsed.sourceFile,
    );
    expect(usage.some((u) => u.propName === "href")).toBe(false);
  });
});
