import type { Task, TaskId } from "../types.ts";
import { a11yScan } from "./a11yScan.ts";
import { eslintReactRules } from "./eslintReactRules.ts";
import { perfHarness } from "./perfHarness.ts";
import { staticPerfAnalysis } from "./staticPerfAnalysis.ts";
import { unitAndBrowser } from "./unitAndBrowser.ts";

export const TASKS: Task[] = [
  perfHarness,
  unitAndBrowser,
  staticPerfAnalysis,
  a11yScan,
  eslintReactRules,
];

export function findTask(id: TaskId): Task | undefined {
  return TASKS.find((t) => t.id === id);
}

export const ALL_TASK_IDS: TaskId[] = TASKS.map((t) => t.id);
