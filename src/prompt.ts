import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import type { TaskId } from "./types.ts";

/**
 * The subset of @clack/prompts the flows below touch. Exported so tests can
 * drive the whole interactive path with a scripted fake (FR-024) — the flows
 * accept an injected instance and fall back to the real dynamic import.
 */
export interface ClackPrompts {
  intro: (msg: string) => void;
  outro: (msg: string) => void;
  text: (opts: {
    message: string;
    placeholder?: string;
    initialValue?: string;
  }) => Promise<string | symbol>;
  multiselect: (opts: {
    message: string;
    options: Array<{ value: string; label: string; hint?: string }>;
    initialValues?: string[];
    required?: boolean;
  }) => Promise<string[] | symbol>;
  confirm: (opts: { message: string; initialValue?: boolean }) => Promise<boolean | symbol>;
  isCancel: (v: unknown) => boolean;
  cancel: (msg: string) => void;
}

let cached: ClackPrompts | undefined;
async function clack(): Promise<ClackPrompts> {
  if (cached) return cached;
  cached = (await import("@clack/prompts")) as unknown as ClackPrompts;
  return cached;
}

export interface InteractivePromptResult {
  pattern: string;
  outDir: string;
  tasks: TaskId[];
}

export interface InteractivePromptOptions {
  taskChoices: Array<{ id: TaskId; label: string; description: string }>;
  defaultTaskIds: TaskId[];
}

export async function promptInteractive(
  opts: InteractivePromptOptions,
  prompts?: ClackPrompts,
): Promise<InteractivePromptResult | undefined> {
  const p = prompts ?? (await clack());
  p.intro("flawless-react");

  const detectedPattern = await detectDefaultPattern();
  const patternRaw = await p.text({
    message: "Component path or glob (e.g. src/Dashboard.tsx or src/**/*.tsx)",
    placeholder: detectedPattern ?? "src/**/*.tsx",
    initialValue: detectedPattern ?? "",
  });
  if (p.isCancel(patternRaw)) {
    p.cancel("aborted");
    return undefined;
  }
  const pattern = String(patternRaw).trim();

  const outRaw = await p.text({
    message: "Output directory",
    initialValue: "./.flawless",
  });
  if (p.isCancel(outRaw)) {
    p.cancel("aborted");
    return undefined;
  }

  const taskRaw = await p.multiselect({
    message: "Pick the tasks to run (space to toggle, enter to confirm)",
    options: opts.taskChoices.map((t) => ({
      value: t.id,
      label: t.label,
      hint: t.description,
    })),
    initialValues: opts.defaultTaskIds,
    required: true,
  });
  if (p.isCancel(taskRaw)) {
    p.cancel("aborted");
    return undefined;
  }

  return {
    pattern,
    outDir: String(outRaw).trim() || "./.flawless",
    tasks: taskRaw as TaskId[],
  };
}

export async function confirmRunTests(prompts?: ClackPrompts): Promise<boolean> {
  const p = prompts ?? (await clack());
  const v = await p.confirm({ message: "Run the generated tests now?", initialValue: false });
  if (p.isCancel(v)) return false;
  return Boolean(v);
}

export async function outro(msg: string): Promise<void> {
  const p = await clack();
  p.outro(msg);
}

async function detectDefaultPattern(): Promise<string | undefined> {
  const candidates = ["src/App.tsx", "src/index.tsx", "src/main.tsx"];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  const srcDir = path.resolve("src");
  if (existsSync(srcDir)) {
    const entries = await readdir(srcDir, { withFileTypes: true });
    const tsx = entries.filter((e) => e.isFile() && e.name.endsWith(".tsx"));
    if (tsx.length === 1 && tsx[0]) return path.join("src", tsx[0].name);
    if (tsx.length > 1) return "src/*.tsx";
  }
  return undefined;
}
