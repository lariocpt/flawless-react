# Rules for working in this repo

Agents work here alongside a person, and the rules below are what makes that safe:
they bound how big a change can be, what has to be green before it lands, and what
must never be committed. What the tool *is* lives in `docs/architecture.md`.

`CLAUDE.md` is a symlink to this file. Edit `AGENTS.md`; never the link.

## Make small edits

**One idea per edit, one commit per smallest change that is green on its own.** A
commit is a point where someone could stop, hand over, or revert without losing
anything, so a commit that mixes a rename with a behaviour change cannot be
reverted, and a commit that is half an idea cannot be trusted.

- Fix one thing, verify it, commit it. Then start the next thing.
- A refactor and a behaviour change are two commits. A generator fix and its
  regenerated corpus output are one.
- If a diff touches more than one subsystem, it is almost always two commits.
- While work is long-running, commit at least every ~20 minutes even mid-stream:
  an uncommitted hour of work is the one failure mode no branch protects against.
- Long jobs get their own checkpoint commit so a crash costs one increment, not a
  session.

When an edit turns out to need a second idea to work, stop, commit what is green,
and let the second idea be its own change.

## Land it

- `bun test` is the gate. `bun run check` **must** be run as
  `rm -rf node_modules/.cache/biome && bun run check` — biome caches, and a cached
  check can report success over an unformatted file.
- `bunx tsc --noEmit` is clean and stays clean. It was carried at ~78 errors while
  the CI gate that ran it stayed red, which taught nobody anything.
- Ship work through a PR into `main`: branch off `main`, `gh pr create --body-file`,
  `gh pr merge --merge --delete-branch=false`, then `git checkout main && git pull --ff-only`.
- Commit messages may quote test tallies only when that run actually happened. A
  number nobody measured is a false claim in permanent record.
- CI runs on `oven/bun:1.4`. Below 1.4 concurrent installers corrupt a shared cold
  cache, which is every CI run and almost no developer machine — the failure reads
  as a registry outage ("Fail extracting tarball"), not as what it is.
- A `bun test` tally that disagrees with the published CI build's is a measurement
  problem, not a code problem: a gitignored nested checkout (`.claude/worktrees/`)
  can get collected at an old revision, where its stale assertions fail against this
  tree. `find . -name '*.test.ts' -not -path './tests/*'` finds it. Move that copy
  out; do not make its assertions pass.
- When a read of a file disagrees with `git status`, trust git and re-read from disk.
  An edit that reported success and never landed is worse than no edit, and the only
  witness is the next `git diff`.

## Measure with the newest code

Corpus dogfood runs regenerate apps with a compiled binary. Any change to the
tool's source makes a staged binary stale: rebuild from the exact tree being
measured (`bun build --compile --minify --outfile /tmp/opencode/fl-bintest-<tree>
src/bin.ts`) and use only that binary for the next regen. A before/after delta
keeps both runs on the same binary lineage — the control is the same tree minus
the change, built the same way. A number measured on a binary built from an
older tree is a measurement problem, not a code problem: redo it before
believing it.

## Never commit

- `CURRENT_WORK.md` — handoff notes, excluded via `.git/info/exclude`.
- `pnpm-workspace.yaml` stubs that appear in dogfooded apps: pnpm 10 build-approval
  files, not tool output.
- `flawless-dogfood` corpus branches are suite output and are never pushed.
- Generated specs: fix the generator, not the emitted file. A hand-patched spec is
  gone the next run and hides the bug meanwhile.

## Keep the prose honest

`.agents/skills/*/SKILL.md`, `README.md` and `docs/` describe the same CLI, and
`tests/docsLint.test.ts` checks the claims against the real flag list, task ids,
env names and emitted paths. The website is a separate repo
(`flawless-react-website`) and validates its own examples against a published
binary, so docs and the tool move together or the site goes red. Biome organises
the skill imports by its own rules — run `bunx biome check --write`, never hand-sort
them. Scratch dirs for tests go in `tests/.tmp/`, which is gitignored.
