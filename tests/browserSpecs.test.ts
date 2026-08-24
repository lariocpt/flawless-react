import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";
import { fillKind, requiredAncestors } from "../src/analyse/htmlContentModel.ts";
import { analyse } from "../src/analyse/index.ts";
import { functionProps } from "../src/scaffold-tests/registry.ts";
import { renderUnitBrowser } from "../src/scaffold-tests/templates.ts";
import type { ComponentInfo, ComponentTree } from "../src/types.ts";

const tmpDir = (): Promise<string> => mkdtemp(path.join(tmpdir(), "flawless-browser-"));

async function treeFor(fixture: string): Promise<ComponentTree> {
  return analyse({
    entry: path.resolve(__dirname, "fixtures", fixture),
    depth: 0,
    includeChildren: false,
    roots: "exported",
  });
}

async function specsFor(fixture: string): Promise<Map<string, string>> {
  const trees = [await treeFor(fixture)];
  const files = renderUnitBrowser({
    trees,
    outDir: await tmpDir(),
    variants: 3,
    browserSpecs: true,
  });
  return new Map(files.map((f) => [f.relPath, f.content]));
}

describe("html content model", () => {
  test("a tag HTML confines to a parent reports its chain", () => {
    expect(requiredAncestors("tbody")).toEqual(["table"]);
    expect(requiredAncestors("td")).toEqual(["table", "tbody", "tr"]);
  });

  test("an ordinary tag needs no wrapper — the map is a lookup, not a guess", () => {
    expect(requiredAncestors("div")).toEqual([]);
    expect(requiredAncestors("section")).toEqual([]);
    expect(requiredAncestors(undefined)).toEqual([]);
  });

  test("fields are classified by what a user can actually do to them", () => {
    expect(fillKind("input", "text")).toBe("text");
    expect(fillKind("input", undefined)).toBe("text");
    expect(fillKind("textarea", undefined)).toBe("text");
    expect(fillKind("input", "checkbox")).toBe("toggle");
    expect(fillKind("input", "radio")).toBe("toggle");
    expect(fillKind("select", undefined)).toBe("select");
    // The three that produced "Input of type X cannot be filled" at runtime.
    expect(fillKind("input", "hidden")).toBe("skip");
    expect(fillKind("input", "file")).toBe("skip");
    expect(fillKind("input", "range")).toBe("skip");
  });
});

describe("form fills respect the field type", () => {
  test("checkboxes are checked, hidden inputs skipped, selects selected", async () => {
    const specs = await specsFor("CheckboxForm.tsx");
    const browser = specs.get("browser/CheckboxForm.spec.ts") ?? "";
    expect(browser).toContain(".check()");
    expect(browser).toContain(".selectOption(");
    expect(browser).toContain('page.getByLabel("Note").first().fill(');
    // A hidden input holds a value the component chose. Filling it asserts
    // nothing, and with several sharing a name it cannot even be addressed.
    expect(browser).not.toContain("csrf");
    // Every field locator is resolved to one element: a checkbox group renders
    // as many as there are options, and Playwright's strict mode rejects that.
    expect(browser).not.toMatch(/page\.locator\([^)]*\)\.(fill|check)\(/);
  });

  test("the submit control is read from the markup, never from likely wording", async () => {
    const specs = await specsFor("CheckboxForm.tsx");
    const browser = specs.get("browser/CheckboxForm.spec.ts") ?? "";
    // "Update details" matches none of submit|save|send|create|add|confirm —
    // the old regex waited the full 30s here.
    expect(browser).toContain('name: "Update details", exact: true');
    expect(browser).not.toContain("sign\\s*up|save|send");
  });

  test("a disabled submit control is reported as disabled, not as absent", async () => {
    const specs = await specsFor("DisabledSubmitForm.tsx");
    const browser = specs.get("browser/DisabledSubmitForm.spec.ts") ?? "";
    expect(browser).toContain("its submit control is disabled at these props");
    // "No submit control in the markup" would be false — it is right there.
    expect(browser).not.toContain("no submit control in the markup");
  });

  test("a form with no submit control is skipped with the reason", async () => {
    const specs = await specsFor("NoSubmitForm.tsx");
    const browser = specs.get("browser/NoSubmitForm.spec.ts") ?? "";
    expect(browser).toContain("no submit control in the markup");
    expect(browser).not.toContain('"Go"');
    expect(browser).not.toContain('"Clear"');
  });

  test("a change handler on a <form> is not driven as a text box", async () => {
    const specs = await specsFor("NoSubmitForm.tsx");
    const browser = specs.get("browser/NoSubmitForm.spec.ts") ?? "";
    const unit = specs.get("unit/NoSubmitForm.test.tsx") ?? "";
    expect(browser).not.toContain('page.locator("form").first().fill(');
    expect(browser).toContain("holds no value to change");
    expect(unit).toContain("holds no value to change");
  });
});

describe("disabled controls never become a 30-second wait", () => {
  test("a control disabled at the initial render is asserted, not clicked", async () => {
    const specs = await specsFor("GatedSubmit.tsx");
    const browser = specs.get("browser/GatedSubmit.spec.ts") ?? "";
    expect(browser).toContain("toBeDisabled()");
    expect(browser).toContain("is disabled at these props");
  });

  test("a control with no disabled attribute is still clicked", async () => {
    const specs = await specsFor("GatedSubmit.tsx");
    const browser = specs.get("browser/GatedSubmit.spec.ts") ?? "";
    expect(browser).toContain("'Pick A' #0 fires without error");
    // Not everything is a skip: the enabled button gets a real click.
    expect(browser).toContain(
      'page.getByRole("button", { name: "Pick A", exact: true }).first().click()',
    );
  });

  test("an unknown operand does not make || or && unknown", async () => {
    const specs = await specsFor("PendingSubmit.tsx");
    const browser = specs.get("browser/PendingSubmit.spec.ts") ?? "";
    // disabled={pending || rows.length === 0} with rows starting empty: the
    // right side settles it whatever `pending` is, so this is decided, not
    // deferred to a runtime check.
    expect(browser).toContain("is disabled at these props");
  });

  test("an undecidable guard asks at runtime rather than waiting it out", async () => {
    const specs = await specsFor("StatefulPanel.tsx");
    const browser = specs.get("browser/StatefulPanel.spec.ts") ?? "";
    // Nothing in this fixture is disabled, so no guard should appear — the
    // runtime check is emitted only where the source shows a `disabled` prop.
    expect(browser).not.toContain("isDisabled()");
  });
});

describe("a bare host tag only names the element when it is the only one", () => {
  test("two buttons means the tag identifies neither", async () => {
    const tree = await treeFor("AmbiguousTags.tsx");
    const click = tree.entry.interactions?.clicks[0];
    expect(click?.ambiguousTag).toBe(true);

    const specs = await specsFor("AmbiguousTags.tsx");
    const browser = specs.get("browser/AmbiguousTags.spec.ts") ?? "";
    // page.locator("button").first() would resolve to "Done", not the row
    // button carrying the handler.
    expect(browser).not.toContain('page.locator("button")');
    // And the skip says which fact stopped it. "No interactions detected" would
    // be false — one was detected and could not be addressed.
    expect(browser).toContain("more than one <button> renders here");
    expect(browser).not.toContain("no interactions detected");
  });

  test("a single button of its kind still gets the fallback", async () => {
    const specs = await specsFor("GatedSubmit.tsx");
    const unit = specs.get("unit/GatedSubmit.test.tsx") ?? "";
    // Both GatedSubmit buttons carry literal text, so they are named by it and
    // never need the tag fallback in the first place.
    expect(unit).toContain('"Pick A"');
  });
});

describe("a name that picks out no single control", () => {
  test("two branches claiming one name are both dropped", async () => {
    const specs = await specsFor("BranchedField.tsx");
    const browser = specs.get("browser/BranchedField.spec.ts") ?? "";
    // At runtime the element under [name="visibleTo"] was a hidden input, and
    // the spec waited for a <select> that never appears.
    expect(browser).not.toContain("visibleTo");
    // The unambiguous field beside it is still driven.
    expect(browser).toContain('getByLabel("Body")');
  });

  test("a checkbox group sharing one name is kept — it is one control", async () => {
    const specs = await specsFor("CheckboxForm.tsx");
    const browser = specs.get("browser/CheckboxForm.spec.ts") ?? "";
    expect(browser).toContain("[name='trades']");
    // Once, not once per option.
    expect(browser.match(/name='trades'/g)?.length).toBe(1);
  });
});

describe("a component whose guard the analyser cannot decide", () => {
  test("its interactions check they are on screen first", async () => {
    const tree = await treeFor("GuardedMenu.tsx");
    expect(tree.entry.renderGuarded).toBe(true);

    const specs = await specsFor("GuardedMenu.tsx");
    const browser = specs.get("browser/GuardedMenu.spec.ts") ?? "";
    expect(browser).toContain("count()) === 0");
    expect(browser).toContain("left nothing to drive");
    // The mount test stops claiming markup it cannot promise — but it does not
    // give up entirely: when the guard passes, the component's literal copy has
    // to be there, so the claim becomes conditional rather than absent.
    expect(browser).not.toContain("expect(rootHtml.length).toBeGreaterThan(0)");
    expect(browser).toContain("if (rootHtml.trim().length > 0)");
    expect(browser).toContain('page.getByText("Open account menu").count()');
  });

  test("an unguarded component still asserts it rendered something", async () => {
    const specs = await specsFor("CheckboxForm.tsx");
    const browser = specs.get("browser/CheckboxForm.spec.ts") ?? "";
    expect(browser).toContain("expect(rootHtml.length).toBeGreaterThan(0)");
    expect(browser).not.toContain("count()) === 0");
  });
});

describe("a component that logs errors itself", () => {
  test("keeps its uncaught-error assertion and drops the console one", async () => {
    const tree = await treeFor("GatedSubmit.tsx");
    expect(tree.entry.logsErrors).toBe("logger.error()");

    const specs = await specsFor("GatedSubmit.tsx");
    const browser = specs.get("browser/GatedSubmit.spec.ts") ?? "";
    expect(browser).toContain('errors.filter((e) => !e.startsWith("[console]"))');
    expect(browser).toContain("expect(rootHtml.length).toBeGreaterThan(0)");
  });

  test("a component that logs nothing keeps the strict assertion", async () => {
    const specs = await specsFor("CheckboxForm.tsx");
    const browser = specs.get("browser/CheckboxForm.spec.ts") ?? "";
    expect(browser).toContain("expect(errors).toEqual([]);");
    expect(browser).not.toContain("errors.filter(");
  });
});

describe("function props the host has to supply", () => {
  test("handlers and called props are named", async () => {
    const tree = await treeFor("NoSubmitForm.tsx");
    expect(functionProps(tree.entry)).toContain("onChange");
  });

  test("a prop bound to an event attribute counts however it is named", async () => {
    const tree = await treeFor("ResetButton.tsx");
    // `reset` matches no naming convention; being the value of onClick is the
    // evidence. AuthError({ error, reset }) is this shape, and the browser spec
    // called undefined the moment the click landed.
    expect(functionProps(tree.entry)).toContain("reset");
  });

  test("a component with no callable props names none", async () => {
    const tree = await treeFor("TableParts.tsx");
    expect(functionProps(tree.entry)).toEqual([]);
  });
});

describe("the profile suite no longer clicks whichever button is first", () => {
  test("an unnameable target skips with the reason rather than guessing", async () => {
    const { renderSuite } = await import("../src/scaffold/templates.ts");
    const tree = await treeFor("AmbiguousTags.tsx");
    const files = renderSuite({ tree, outDir: await tmpDir(), variants: 3, report: false });
    const spec =
      files.find((f) => f.relPath.endsWith("AmbiguousTags.profile.spec.ts"))?.content ?? "";
    // page.locator("button").first() is the same guess that resolved to a
    // disabled "Cast vote" while the handler belonged to a vote option.
    expect(spec).not.toContain('page.locator("button").first()');
    expect(spec).toContain("more than one <button> renders here");
  });

  test("a named target is still clicked", async () => {
    const { renderSuite } = await import("../src/scaffold/templates.ts");
    const tree = await treeFor("GatedSubmit.tsx");
    const files = renderSuite({ tree, outDir: await tmpDir(), variants: 3, report: false });
    const spec =
      files.find((f) => f.relPath.endsWith("GatedSubmit.profile.spec.ts"))?.content ?? "";
    expect(spec).toContain('name: "Pick A", exact: true');
    expect(spec).not.toContain('page.locator("button").first()');
  });
});

describe("the browser suite no longer clicks whichever button is first", () => {
  // `analyse` always fills `interactions`, so the undefined-interactions shape
  // — a hand-registered entry, or info from before the analyser ran — is built
  // directly rather than through a fixture.
  const bareEntry = (): ComponentInfo => ({
    componentName: "Plain",
    filePath: path.join(tmpdir(), "Plain.tsx"),
    importSpecifier: "./Plain.tsx",
    propsShape: {},
    variants: [],
    hooks: [],
    unresolvedProps: [],
    exportKind: "named",
  });

  test("no derivable target skips with the reason instead of guessing", async () => {
    const files = renderUnitBrowser({
      trees: [{ entry: bareEntry(), children: [] }],
      outDir: await tmpDir(),
      variants: 3,
      browserSpecs: true,
    });
    const spec = files.find((f) => f.relPath === "browser/Plain.spec.ts")?.content ?? "";
    expect(spec.length).toBeGreaterThan(0);
    // `button:not([disabled])` names whichever enabled button comes first, not
    // one the analysis found a handler on — the same guess the profile suite
    // dropped when it resolved to VoteCard's submit control.
    expect(spec).not.toContain("button:not([disabled])");
    expect(spec).not.toContain(".first()");
    // Decided at scaffold time, reason in the title — a runtime skip would pay
    // a full page load to discover it has nothing to do, and the list reporter
    // prints titles, not runtime skip reasons.
    expect(spec).toContain("test.skip(");
    expect(spec).toContain("the analyser found no click handler on this component");
  });

  test("a component with derived targets keeps its targeted click test", async () => {
    const specs = await specsFor("GatedSubmit.tsx");
    const browser = specs.get("browser/GatedSubmit.spec.ts") ?? "";
    expect(browser).toContain(
      'page.getByRole("button", { name: "Pick A", exact: true }).first().click()',
    );
    expect(browser).not.toContain("button:not([disabled])");
  });
});

describe("ambiguity is decided by what a tag renders, not what it is called", () => {
  test("a component named like a button that renders an anchor does not count", async () => {
    const tree = await analyse({
      entry: path.resolve(__dirname, "fixtures/resolved/OneRealButton.tsx"),
      depth: 0,
      includeChildren: false,
    });
    // <LinkButton> resolves to <a>, so the one <button> is unambiguous. The old
    // `endsWith("button")` convention counted it and skipped the test.
    expect(tree.entry.interactions?.clicks[0]?.ambiguousTag).toBeUndefined();
  });

  test("a component that really renders a button still counts", async () => {
    const tree = await analyse({
      entry: path.resolve(__dirname, "fixtures/resolved/TwoRealButtons.tsx"),
      depth: 0,
      includeChildren: false,
    });
    expect(tree.entry.interactions?.clicks[0]?.ambiguousTag).toBe(true);
  });

  test("an unresolvable tag falls back to the cautious convention", async () => {
    // The mapped <button> and the fixed one are both host tags here, so the
    // count is direct — and a tag that could NOT be resolved would fall back to
    // the convention, which over-counts rather than under-counts.
    const tree = await analyse({
      entry: path.resolve(__dirname, "fixtures/AmbiguousTags.tsx"),
      depth: 0,
      includeChildren: false,
    });
    expect(tree.entry.interactions?.clicks[0]?.ambiguousTag).toBe(true);
  });
});

describe("rootTag is a host element or nothing", () => {
  test("a component whose root is another component reports no root tag", async () => {
    const tree = await treeFor("resolved/WrapsAComponent.tsx");
    // shadcn's Button returns <ButtonPrimitive>. Reporting that as the root tag
    // let a caller conclude the render held an element called
    // "ButtonPrimitive" and no button at all — which is how VoteCard's click
    // target went back to being whichever button came first.
    expect(tree.entry.rootTag).toBeUndefined();
  });

  test("a component whose root is a host element reports it", async () => {
    const tree = await treeFor("resolved/RealButton.tsx");
    expect(tree.entry.rootTag).toBe("button");
  });
});

describe("hostile characters in interaction labels", () => {
  // The click-label helper escaped only double quotes, but its output lands in
  // TEMPLATE-LITERAL titles: a backtick in a clickable label terminated the
  // emitted literal, and a `${` in an aria-label became a live substitution.
  function parseErrorsIn(file: string, content: string): string[] {
    const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
    const sf = ts.createSourceFile(file, content, ts.ScriptTarget.ESNext, true, kind);
    const diagnostics = (sf as unknown as { parseDiagnostics?: ts.Diagnostic[] }).parseDiagnostics;
    return (diagnostics ?? []).map((d) => ts.flattenDiagnosticMessageText(d.messageText, " "));
  }

  test("a backtick or ${ in a label still emits specs that parse", async () => {
    const specs = await specsFor("TrickyLabels.tsx");
    const browser = specs.get("browser/TrickyLabels.spec.ts") ?? "";
    expect(browser.length).toBeGreaterThan(0);
    expect(parseErrorsIn("browser/TrickyLabels.spec.ts", browser)).toEqual([]);
    // "${amount}" PARSES — as a substitution of a name that does not exist.
    // The titles have to carry defused text, not evaluate it.
    const titles = browser.split("\n").filter((l) => l.trimStart().startsWith("test"));
    expect(titles.length).toBeGreaterThan(1);
    expect(titles.join("\n")).not.toContain("${amount}");
    expect(titles.join("\n")).toContain("$ {amount}");
    // The Playwright locator still targets the REAL label, verbatim.
    expect(browser).toContain('page.getByLabel("Pay ${amount} now")');
    const unit = specs.get("unit/TrickyLabels.test.tsx") ?? "";
    expect(parseErrorsIn("unit/TrickyLabels.test.tsx", unit)).toEqual([]);
  });
});
