// The menu `flawless-react skills install` shows on a terminal.
//
// clack's multiselect rather than a hand-rolled raw-mode picker: the project
// already depends on @clack/prompts, already speaks it in the generation prompts,
// and already has an injection seam for it (FR-024), so a second cursor library
// would be one more thing to keep alive for no added behaviour. Scope and
// overwrite are NOT keys in this menu — they are the `--global` and `--force`
// flags — which keeps one meaning per spelling and lets the menu answer exactly
// one question: which skills.
import { type ClackPrompts, loadClack } from "../prompt.ts";
import type { SkillStatus } from "./data.ts";

/**
 * What the menu pre-selects: everything that is not already installed and
 * byte-identical. So the default answer to Enter is "bring this machine up to
 * date", not "rewrite what is already right" — and an `edited` entry is offered
 * because the usual reason it is edited is that the user wants the new one.
 */
export function defaultSelection(entries: Array<{ name: string; status: SkillStatus }>): string[] {
  return entries.filter((e) => e.status !== "current").map((e) => e.name);
}

export interface MenuItem {
  name: string;
  hint?: string;
}

/**
 * Ask which skills to install. `undefined` means the user cancelled — the caller
 * must not install anything in that case, and must not call it a failure.
 *
 * `target` is in the question because the answer means different things per
 * scope: the same menu writing into `~/.agents/skills` is a machine-wide
 * decision, and a menu that hides where it is about to write is how you get a
 * skills directory you cannot explain later.
 */
export async function pickSkills(
  target: string,
  items: MenuItem[],
  defaults: string[],
  prompts?: ClackPrompts,
): Promise<string[] | undefined> {
  const p = prompts ?? (await loadClack());
  const picked = await p.multiselect({
    message: `Install which skills into ${target}?`,
    options: items.map((i) => ({ value: i.name, label: i.name, hint: i.hint })),
    initialValues: defaults,
    required: true,
  });
  if (p.isCancel(picked)) {
    p.cancel("aborted — nothing installed");
    return undefined;
  }
  return Array.isArray(picked) ? picked : [];
}
