import type { Task, TaskId } from "../types.ts";
import { a11yScan } from "./a11yScan.ts";
import { e2eRoutes } from "./e2eRoutes.ts";
import { eslintReactRules } from "./eslintReactRules.ts";
import { loadPipes } from "./loadPipes.ts";
import { perfHarness } from "./perfHarness.ts";
import { staticPerfAnalysis } from "./staticPerfAnalysis.ts";
import { unitAndBrowser } from "./unitAndBrowser.ts";

export const TASKS: Task[] = [
  perfHarness,
  unitAndBrowser,
  staticPerfAnalysis,
  a11yScan,
  eslintReactRules,
  e2eRoutes,
  loadPipes,
];

export function findTask(id: TaskId): Task | undefined {
  return TASKS.find((t) => t.id === id);
}

export const ALL_TASK_IDS: TaskId[] = TASKS.map((t) => t.id);
