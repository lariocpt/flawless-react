// Types for postinstall.mjs, which stays plain JavaScript ON PURPOSE: npm runs it
// before anything is installed, so it may not need a transpile step, a bun runtime,
// or a dependency that is not in node_modules yet. That also means tsc never saw it
// — the file was shipped untyped until tests/skills-prompt.test.ts imported it.
// This declaration is the seam: the implementation keeps its runtime shape, and the
// gate's contract is written down where a change to it has to be stated.

/** What `hasBun` injects to probe for the runtime: a `spawnSync`-shaped call. */
type RunProbe = (
  command: string,
  args: readonly string[],
) => { error?: unknown; status: number | null };

/**
 * The answer from the install gate. `reason` is present on every "no" and
 * `dir` on every "yes" plus the "already installed" case — the caller that
 * spawns the picker needs the directory, the tests need the reason.
 */
export interface SkillGate {
  ask: boolean;
  dir?: string;
  reason?: string;
}

export declare function hasBun(run?: RunProbe): boolean;

export declare function shouldAsk(options: {
  env: Record<string, string | undefined>;
  stdinTty: boolean;
  stdoutTty: boolean;
  bunAvailable?: boolean;
  exists?: (path: string) => boolean;
}): SkillGate;

export declare function askSkills(options: {
  bin: string;
  bun?: string;
  spawnFn?: (
    command: string,
    args: readonly string[],
    options: { cwd?: string; stdio?: string },
  ) => {
    on: (event: string, listener: (argument: unknown) => void) => void;
  };
  log?: (line: string) => void;
}): Promise<string>;
