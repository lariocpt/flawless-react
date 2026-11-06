import { describe, expect, test } from "bun:test";
import {
  census,
  classifyAssertionAtLine,
  classifySpec,
  type Tier,
} from "../src/reporters/depth.ts";

/**
 * Guard-the-guard tests for the D0 depth classifier (PLAN-00 acceptance 1).
 *
 * A classifier that silently stops matching would let the census drift upward
 * without anyone noticing. Every fixture therefore asserts a MINIMUM number of
 * classified tests — a parse failure shrinks that count and reddens here — and
 * the lying-shape cases (deleted spy, truthy-replaced copy) must land T0, not
 * the tier their file's prose would suggest.
 */

const mountOnlySpec = `
test("Card mounts at defaults without throwing", () => {
  // No host root tag resolved for this component.
  expect(() => renderTarget()).not.toThrow();
  void screen;
});
`;

const t1CopySpec = `
describe("Badge static content", () => {
  for (const t of ["Pending", "Paid"]) {
    test(\`renders \${JSON.stringify(t)}\`, async () => {
      renderTarget();
      expect(screen.getAllByText(t).length).toBeGreaterThan(0);
    });
  }
});

test("Badge renders a <span>", () => {
  const { container } = renderTarget();
  expect(container.querySelector("span")).not.toBeNull();
});
`;

const t2SpySpec = `
test("Button fires onClick when 'Save' (click)", async () => {
  const { container } = renderTarget();
  void container;
  await userEvent.click(screen.getByText("Save"));
  expect(handlers.onClick).toHaveBeenCalled();
});

test("Button mounts at defaults without throwing", () => {
  expect(() => renderTarget()).not.toThrow();
});
`;

const t2GuardSpec = `
test("InvoicePage: notFound() when getInvoice returns null", async () => {
  vi.mocked(getInvoice).mockResolvedValue(null as never);
  await expect(InvoicePage({ id: "1" })).rejects.toThrow(/notFound\\(\\) called/);
});
`;

const t3PayloadSpec = `
test("LoginForm submits form #0 → login called", async () => {
  const { container } = renderTarget();
  void container;
  await userEvent.fill(input, SAMPLE);
  fireEvent.submit(container.querySelectorAll("form")[0] as HTMLFormElement);
  expect(handlers.onSubmit).toHaveBeenCalledWith(payload);
});
`;

const t3FixtureSpec = `
test("renders the loaded state when listInvoices returns a row", async () => {
  server.use(http.get(URL, () => HttpResponse.json(FIXTURE)));
  renderTarget();
  expect(screen.getAllByText(invoiceNumber).length).toBeGreaterThan(0);
});
`;

const todoTailSpec = `
test("TicketForm: click via onSubmit → open updates", async () => {
  const { container } = renderTarget();
  void container;
  await userEvent.click(container.querySelector("button") as HTMLElement);
  // TODO(flawless): assert the observable change for setOpen(...) —
  // the handler fires, but no text witness could be derived statically.
  await waitFor(() => expect(document.body).toBeTruthy());
});
`;

const fetchTodoSpec = `
describe("InvoicesPage GET /api/invoices", () => {
  const URL = "/api/invoices";
  const FIXTURE: unknown = {};

  test("mount fetches and renders with a successful response", async () => {
    let calls = 0;
    server.use(http.get(URL, () => { calls++; return HttpResponse.json(FIXTURE as never); }));
    const { container } = renderTarget();
    void container;
    await waitFor(() => expect(calls).toBeGreaterThan(0), { timeout: 3000 });
    // TODO(flawless): assert rendered content derived from FIXTURE.
  });
});
`;

const skipOnlySpec = `
test.skip("Modal click on 'Open' #0 — no observable effect could be derived", () => {
  // TODO(flawless): make it reachable and this becomes a real interaction test.
});

test.skip("Modal form #0 — no submit control in the markup", () => {
  // TODO(flawless): the form declares no <button type="submit">.
});
`;

const runtimeSkipOnlySpec = `
test("Toast: every \`variant\` option renders distinct markup", (ctx) => {
  const probe = renderTarget();
  const probeCarriesClass = probe.container.querySelector("[class]") !== null;
  probe.unmount();
  if (!probeCarriesClass) {
    ctx.skip("no element in this component's render carries a class — nothing to compare");
  }
});
`;

const inversionSpec = `
test("FinancePage: arrears flipped — 2 branch site(s) change side", async () => {
  const t0 = (view.container.textContent ?? "").replace(/\\s+/g, " ");
  const n3f = vi.mocked(listMyInvoices).mock.calls.length;
  expect(t0).toContain("Arrears");
  vi.mocked(showArrears).mockReturnValueOnce(false);
  const t1 = (view2.container.textContent ?? "").replace(/\\s+/g, " ");
  expect(t1).not.toContain("Arrears");
  expect(vi.mocked(listMyInvoices).mock.calls.length).toBeGreaterThan(n3f);
});
`;

const routerLiteralSpec = `
test("Nav pushes router.push('/login') on 'Sign in' #0", async () => {
  const { container } = renderTarget();
  void container;
  routerMock.push.mockClear();
  await userEvent.click(screen.getByText("Sign in"));
  await waitFor(() => expect(routerMock.push).toHaveBeenCalledWith("/login"));
});
`;

const variantSpec = `
test("Button: every \`variant\` option renders distinct markup", (ctx) => {
  const probe = renderTarget();
  const probeCarriesClass = probe.container.querySelector("[class]") !== null;
  probe.unmount();
  if (!probeCarriesClass) {
    ctx.skip("no element in this component's render carries a class — nothing to compare");
  }
  const seen = ["default", "outline"].map((option) => {
    const { container, unmount } = renderTarget({ variant: option });
    const el = container.querySelector("[class]");
    expect(el, \`variant=\${option} rendered no element carrying a class\`).not.toBeNull();
    const dom = el?.outerHTML ?? "";
    unmount();
    return dom;
  });
  expect(new Set(seen).size, "two options rendered identical markup").toBe(seen.length);
});
`;

const fillSpec = `
test("Search form #0 accepts input and submits", async () => {
  const { container } = renderTarget();
  void container;
  await userEvent.fill(input, "user@example.com");
  expect(input as HTMLElement).toHaveValue("user@example.com");
  await userEvent.click(submit);
  // the value assertions above are the claim
});
`;

describe("classifySpec — one case per tier", () => {
  test("T0: a mount-only spec classifies its one test at T0", () => {
    const c = classifySpec(mountOnlySpec);
    expect(c.tier).toBe("T0");
    expect(c.perTest.length).toBeGreaterThanOrEqual(1);
    expect(c.perTest[0]?.tier).toBe("T0");
    expect(c.unclaimed).toBe(0);
  });

  test("T1: literal copy + named root tag classify at T1", () => {
    const c = classifySpec(t1CopySpec);
    expect(c.tier).toBe("T1");
    expect(c.perTest.length).toBeGreaterThanOrEqual(2);
    expect(c.perTest.every((t) => t.tier === "T1")).toBe(true);
  });

  test("T2: a prop-spy interaction classifies at T2", () => {
    const c = classifySpec(t2SpySpec);
    expect(c.tier).toBe("T2");
    expect(c.perTest.length).toBeGreaterThanOrEqual(2);
    const spy = c.perTest.find((t) => t.name.includes("onClick"));
    expect(spy?.tier).toBe("T2");
  });

  test("T2: a guard rejects.toThrow classifies at T2", () => {
    const c = classifySpec(t2GuardSpec);
    expect(c.tier).toBe("T2");
    expect(c.perTest.length).toBe(1);
  });

  test("T3: toHaveBeenCalledWith on a derived argument classifies at T3", () => {
    const c = classifySpec(t3PayloadSpec);
    expect(c.tier).toBe("T3");
    expect(c.perTest.length).toBeGreaterThanOrEqual(1);
  });

  test("T3: a text witness over an unnamed (fixture) value classifies at T3", () => {
    const c = classifySpec(t3FixtureSpec);
    expect(c.tier).toBe("T3");
    expect(c.perTest.length).toBe(1);
  });

  test("T2: router toHaveBeenCalledWith with a literal target is T2, not T3", () => {
    const c = classifySpec(routerLiteralSpec);
    expect(c.tier).toBe("T2");
  });

  test("T2: inversion legs (absence + call-count leg) classify at T2", () => {
    const c = classifySpec(inversionSpec);
    expect(c.tier).toBe("T2");
    expect(c.perTest.length).toBe(1);
  });

  test("T1: the variant outerHTML matrix with a conditional ctx.skip still runs and reads T1", () => {
    const c = classifySpec(variantSpec);
    expect(c.tier).toBe("T1");
    expect(c.perTest.length).toBe(1);
    expect(c.skipped).toBe(0);
  });

  test("T1: fill + toHaveValue read-back classifies at T1", () => {
    const c = classifySpec(fillSpec);
    expect(c.tier).toBe("T1");
  });
});

describe("classifySpec — the lying-shape guards", () => {
  test("GUARD: a T2 spec with its spy assertion deleted reads T0", () => {
    const neutered = t2SpySpec.replace("  expect(handlers.onClick).toHaveBeenCalled();\n", "");
    const c = classifySpec(neutered);
    expect(c.tier).toBe("T0");
    expect(c.perTest.length).toBeGreaterThanOrEqual(2);
  });

  test("GUARD: a T1 spec whose text assertion became toBeTruthy() reads T0", () => {
    const textOnlySpec = `
describe("Badge static content", () => {
  test("renders the copy", async () => {
    renderTarget();
    expect(screen.getAllByText("Pending").length).toBeGreaterThan(0);
  });
});
`;
    expect(classifySpec(textOnlySpec).tier).toBe("T1");
    const neutered = textOnlySpec.replace(
      'expect(screen.getAllByText("Pending").length).toBeGreaterThan(0);',
      'expect(screen.getByText("Pending")).toBeTruthy();',
    );
    const c = classifySpec(neutered);
    expect(c.tier).toBe("T0");
    expect(c.perTest.length).toBe(1);
  });

  test("GUARD: a spec whose only content is test.skip reports zero classified tests", () => {
    const c = classifySpec(skipOnlySpec);
    expect(c.tier).toBe(null);
    expect(c.perTest.length).toBe(2);
    expect(c.perTest.every((t) => t.tier === null)).toBe(true);
    expect(c.skipped).toBe(2);
    expect(c.unclaimed).toBe(0);
  });

  test("GUARD: a spec whose only content is a runtime ctx.skip reports zero classified tests", () => {
    const c = classifySpec(runtimeSkipOnlySpec);
    expect(c.tier).toBe(null);
    expect(c.skipped).toBe(1);
  });

  test("GUARD: TODO(flawless) + vacuous tail is T0 AND unclaimed", () => {
    const c = classifySpec(todoTailSpec);
    expect(c.tier).toBe("T0");
    expect(c.unclaimed).toBe(1);
    expect(c.perTest.length).toBe(1);
    expect(c.perTest[0]?.evidence.join(" ")).toContain("TODO(flawless)");
  });

  test("GUARD: the fetch TODO + calls>0 shape is T0 AND unclaimed", () => {
    const c = classifySpec(fetchTodoSpec);
    expect(c.tier).toBe("T0");
    expect(c.unclaimed).toBe(1);
    expect(c.perTest.length).toBe(1);
  });

  test("GUARD: a real assertion next to a TODO marker is NOT unclaimed", () => {
    const withReal = fetchTodoSpec.replace(
      "await waitFor(() => expect(calls).toBeGreaterThan(0), { timeout: 3000 });",
      'expect(screen.getAllByText("Invoices").length).toBeGreaterThan(0);',
    );
    const c = classifySpec(withReal);
    expect(c.tier).toBe("T1");
    expect(c.unclaimed).toBe(0);
  });
});

describe("census", () => {
  const specs = [
    { path: "a.flawless.test.tsx", source: mountOnlySpec },
    { path: "b.flawless.test.tsx", source: t1CopySpec },
    { path: "c.flawless.test.tsx", source: t2SpySpec },
    { path: "d.flawless.test.tsx", source: t3PayloadSpec },
    { path: "e.flawless.test.tsx", source: todoTailSpec },
    { path: "f.flawless.test.tsx", source: skipOnlySpec },
  ];

  test("distribution, T0 count, unclaimed count and skip accounting all agree", () => {
    const c = census(specs);
    expect(c.specs).toBe(6);
    expect(c.distribution).toEqual({ T0: 2, T1: 1, T2: 1, T3: 1 });
    expect(c.specsStrongestT0).toBe(2);
    expect(c.specsAllSkipped).toEqual(["f.flawless.test.tsx"]);
    expect(c.testsUnclaimed).toBe(1);
    expect(c.testsSkipped).toBe(2);
    expect(c.testsClassified).toBeGreaterThanOrEqual(6);
    expect(c.specsUnclassified).toEqual([]);
  });

  test("a file with no test declaration is reported unclassified by path", () => {
    const c = census([{ path: "empty.ts", source: "export const x = 1;\n" }]);
    expect(c.specsUnclassified).toEqual(["empty.ts"]);
    expect(c.specsClassified).toBe(0);
  });

  test("output is deterministic: two runs deep-equal, perSpec sorted by path", () => {
    const shuffled = [...specs].reverse();
    const a = census(specs);
    const b = census(shuffled);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    const paths = a.perSpec.map((s) => s.path);
    expect(paths).toEqual([...paths].sort());
  });

  test("every tier name is one of the four", () => {
    const c = census(specs);
    const tiers: (Tier | null)[] = c.perSpec.map((s) => s.tier);
    for (const t of tiers) expect(t === null || ["T0", "T1", "T2", "T3"].includes(t)).toBe(true);
  });
});

describe("classifyAssertionAtLine — the probe's line-level question", () => {
  const spec = [
    "test(\"Button fires onClick when 'Save' (click)\", async () => {",
    "  const { container } = renderTarget();",
    '  fireEvent.click(screen.getByText("Save"));',
    "  expect(handlers.onClick).toHaveBeenCalled();",
    "});",
    'test("renders copy", () => {',
    "  renderTarget();",
    '  expect(screen.getAllByText("Save").length).toBeGreaterThan(0);',
    "});",
  ].join("\n");

  test("a spy assertion on its line reads T2", () => {
    const c = classifyAssertionAtLine(spec, 4);
    expect(c?.tier).toBe("T2");
    expect(c?.evidence).toContain("spy");
  });

  test("a literal text query on its line reads T1", () => {
    const c = classifyAssertionAtLine(spec, 8);
    expect(c?.tier).toBe("T1");
  });

  test("a line with no assertion site returns null, never a guessed tier", () => {
    expect(classifyAssertionAtLine(spec, 3)).toBeNull();
    expect(classifyAssertionAtLine(spec, 1)).toBeNull();
    // a line past the end of the file
    expect(classifyAssertionAtLine(spec, 999)).toBeNull();
  });

  test("comment-stripping applies: an expect named in a comment is not a site", () => {
    const commented = `test("x", () => {\n  // expect(handlers.onX).toHaveBeenCalled();\n  expect(true).toBe(true);\n});`;
    expect(classifyAssertionAtLine(commented, 2)).toBeNull();
    expect(classifyAssertionAtLine(commented, 3)?.tier).toBe("T0");
  });
});
