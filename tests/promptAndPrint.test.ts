import { describe, expect, test } from "bun:test";
import path from "node:path";
import { type ClackPrompts, confirmRunTests, promptInteractive } from "../src/prompt.ts";
import { printFindings, printSummaryTable } from "../src/reporters/findings.ts";
import type { Finding, TaskResult } from "../src/types.ts";

/**
 * FR-024: prompt.ts and the findings print functions were the remaining
 * zero-execution modules. A FAIL rendered as ok, or a cancel that falls
 * through to a run, would have shipped silently — so the prompt flow is
 * driven end to end through a scripted ClackPrompts fake, and the print
 * functions run against a captured stdout.
 */

const CANCEL = Symbol("cancel");

interface Script {
  text?: Array<string | symbol>;
  multiselect?: Array<string[] | symbol>;
  confirm?: Array<boolean | symbol>;
}

function fake(script: Script): { prompts: ClackPrompts; calls: string[] } {
  const calls: string[] = [];
  const texts = [...(script.text ?? [])];
  const multis = [...(script.multiselect ?? [])];
  const confirms = [...(script.confirm ?? [])];
  const prompts: ClackPrompts = {
    intro: (msg) => void calls.push(`intro:${msg}`),
    outro: (msg) => void calls.push(`outro:${msg}`),
    cancel: (msg) => void calls.push(`cancel:${msg}`),
    isCancel: (v) => v === CANCEL,
    text: async () => {
      calls.push("text");
      const v = texts.shift();
      if (v === undefined) throw new Error("scripted fake ran out of text answers");
      return v;
    },
    multiselect: async () => {
      calls.push("multiselect");
      const v = multis.shift();
      if (v === undefined) throw new Error("scripted fake ran out of multiselect answers");
      return v;
    },
    confirm: async () => {
      calls.push("confirm");
      const v = confirms.shift();
      if (v === undefined) throw new Error("scripted fake ran out of confirm answers");
      return v;
    },
  };
  return { prompts, calls };
}

const CHOICES = {
  taskChoices: [
    { id: "unit-browser" as const, label: "unit", description: "unit tests" },
    { id: "perf-harness" as const, label: "perf", description: "profiling" },
  ],
  defaultTaskIds: ["perf-harness" as const],
};

describe("promptInteractive through a scripted fake", () => {
  test("the happy path returns trimmed answers and the chosen tasks", async () => {
    const { prompts, calls } = fake({
      text: ["  src/App.tsx  ", "  ./custom-out "],
      multiselect: [["unit-browser"]],
    });
    const result = await promptInteractive(CHOICES, prompts);
    expect(result).toEqual({
      pattern: "src/App.tsx",
      outDir: "./custom-out",
      tasks: ["unit-browser"],
    });
    expect(calls[0]).toBe("intro:flawless-react");
  });

  test("an empty output directory falls back to ./.flawless", async () => {
    const { prompts } = fake({
      text: ["src/App.tsx", "   "],
      multiselect: [["perf-harness"]],
    });
    const result = await promptInteractive(CHOICES, prompts);
    expect(result?.outDir).toBe("./.flawless");
  });

  test("a cancel at ANY stage aborts with undefined — never falls through to a run", async () => {
    // Stage 1: the pattern prompt.
    const first = fake({ text: [CANCEL] });
    expect(await promptInteractive(CHOICES, first.prompts)).toBeUndefined();
    expect(first.calls).toContain("cancel:aborted");
    // Stage 2: the out-dir prompt.
    const second = fake({ text: ["src/App.tsx", CANCEL] });
    expect(await promptInteractive(CHOICES, second.prompts)).toBeUndefined();
    // Stage 3: the task multiselect.
    const third = fake({ text: ["src/App.tsx", "./out"], multiselect: [CANCEL] });
    expect(await promptInteractive(CHOICES, third.prompts)).toBeUndefined();
  });
});

describe("confirmRunTests through a scripted fake", () => {
  test("yes is true, no is false, cancel is FALSE — never a run", async () => {
    expect(await confirmRunTests(fake({ confirm: [true] }).prompts)).toBe(true);
    expect(await confirmRunTests(fake({ confirm: [false] }).prompts)).toBe(false);
    expect(await confirmRunTests(fake({ confirm: [CANCEL] }).prompts)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Print functions, against captured stdout
// ---------------------------------------------------------------------------

function captured(fn: () => void): string {
  const original = process.stdout.write.bind(process.stdout);
  let buf = "";
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    buf += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    return true;
  }) as typeof process.stdout.write;
  try {
    fn();
  } finally {
    process.stdout.write = original;
  }
  return buf;
}

function finding(over: Partial<Finding> = {}): Finding {
  return {
    file: path.join(process.cwd(), "src", "Widget.tsx"),
    line: 3,
    column: 7,
    rule: "img-alt",
    message: "images need alt text",
    severity: "error",
    ...over,
  } as Finding;
}

describe("printFindings", () => {
  test("groups by file, renders severities, and prints nothing for no findings", () => {
    const out = captured(() =>
      printFindings([
        finding(),
        finding({ line: 9, severity: "warning" as never, rule: "aria-role", message: "bad role" }),
      ]),
    );
    expect(out).toContain(path.join("src", "Widget.tsx"));
    expect(out).toContain("ERROR  3:7  img-alt  images need alt text");
    expect(out).toContain("warn   9:7  aria-role  bad role");
    expect(captured(() => printFindings([]))).toBe("");
  });
});

describe("printSummaryTable", () => {
  const result = (over: Partial<TaskResult>): TaskResult =>
    ({
      id: "unit-browser",
      ok: true,
      outputs: ["a", "b"],
      findings: [],
      summary: "unit tests for 2 component(s)",
      ...over,
    }) as TaskResult;

  test("a failed task prints FAIL and its error — never ok", () => {
    const out = captured(() =>
      printSummaryTable([
        result({}),
        result({ id: "a11y" as never, ok: false, error: "sweep exploded" }),
      ]),
    );
    expect(out).toContain("[ok] unit-browser");
    expect(out).toContain("[FAIL] a11y");
    expect(out).toContain("error: sweep exploded");
    // The FAIL row must not read as ok anywhere.
    const failLine = out.split("\n").find((l) => l.includes("a11y")) ?? "";
    expect(failLine).not.toContain("[ok]");
  });

  test("counts come from the arrays, not the summary text", () => {
    const out = captured(() => printSummaryTable([result({ findings: [finding()] })]));
    expect(out).toContain("files:2 findings:1");
  });
});
