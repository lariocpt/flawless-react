/**
 * The standalone suite's package.json script names and commands, in one place.
 *
 * Two tasks write `<outDir>/package.json` — perf-harness through
 * scaffold/templates.ts, unit-browser through scaffold-tests/index.ts — and both
 * used to declare `test:perf`. perf-harness said `playwright test`, unit-browser
 * said `playwright test profile`, so which one survived depended on which task
 * ran last. Nothing failed, which is exactly why it lasted: both commands work,
 * and only the bytes differed by task order.
 *
 * Deciding which emitter wins is the wrong axis. The disagreement exists because
 * one intent is spelled twice, so it is spelled here once instead and neither
 * emitter keeps a private copy. Two emitters may both declare a key — they
 * cannot disagree about it — so merge order stops being observable by
 * construction rather than by policy. tests/core.test.ts fails if they ever do
 * diverge again.
 */
export const SUITE_SCRIPT = {
  test: "test",
  unit: "test:unit",
  perf: "test:perf",
  browser: "test:browser",
  headed: "test:headed",
  report: "report",
} as const;

export const SUITE_COMMAND = {
  unit: "vitest run",
  /**
   * No positional filter, deliberately.
   *
   * `playwright test profile` duplicated `testDir: "./profile"` from the very
   * config it runs under, and that duplication has already cost a release: the
   * profile specs moved from `tests/` to `profile/`, the filter did not, and
   * `bun run test:perf` silently selected nothing while --run-tests reported a
   * correct suite as failing (d47abbe). Scope belongs to playwright.config.ts
   * alone, which cannot fall out of step with itself. The browser specs are not
   * swept up by this: they live under `browser/` with their own config.
   */
  perf: "playwright test",
  browser: "playwright test --config browser/playwright.config.ts",
  headed: "playwright test --project=interactive",
  report: "node ./scripts/report.mjs",
} as const;
