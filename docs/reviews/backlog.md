# Opportunity backlog — 2026-08 review

P3 opportunities from the deep review, each tied to observed dogfood evidence on
mybodycorpai (never invented features). The TODO census that grounds most of
them: 181 `TODO(flawless)` markers across 172 colocated specs, of which the top
three clusters are 89% of all remaining hand-work.

| # | Opportunity | Evidence | Effort |
|---|---|---|---|
| ~~B-1~~ (done, PR #12) | Infer mock **return shapes** for module-level data deps: chase the mocked function's return type the way props are chased, and synthesise from the OpenAPI response schema when the body wraps a fetch of a spec route | 87 of 181 TODOs are "some return shapes could not be inferred"; sibling mocks in the same spec show shaping works when the type resolves | L |
| ~~B-2~~ (done, PR #13) | Emit the **`<Root open>` wrapper** for known compound-part families (@base-ui/react/*, @radix-ui/react-*) — the REPORT already names the exact primitive and package it tells the user to add | 44 TODOs + 46 skipped browser specs are this one pattern; hand-filling two exemplars in dogfood took minutes each and the wrapper was mechanical | M |
| ~~B-3~~ (done, PR #11) | Synthesise **server-action stub returns** from the action module's own return expressions (object literals only, bail otherwise) | 31 TODOs "server action stubbed — give it a realistic return value"; detection already exists via the mock allowlist | M |
| B-8 | **Workspace-package type resolution**: chase `Promise<T>` annotation types through bare workspace specifiers (`@scope/shared`) whose source lives in the same monorepo — resolve the package name via the workspace map, then continue in its source tree | Dogfood round 5: the nullable-union fix (PR #17) unlocked nothing on mybodycorpai because every lib annotation imports its `T` from `@mybodycorp-ai/shared`; the whole 42-TODO return-shapes remainder is exactly this wall | M |
| ~~B-4~~ (done, PR #10) | **Content-hash stamp** on generated colocated specs so --force refreshes provably-untouched files and lists the hand-edited ones instead of clobbering them | Dogfood iteration 4: the entire --force clobber surface was exactly the three hand-hardened specs; restoring them needed git archaeology | M |
| ~~B-5~~ (done, wave 1) | Narrow the **e2e affected run** with a --grep built from affected.routes (the emitted titles embed the route template) | runTests.ts:173 runs all 31 dev-server-backed route specs for any affected route | S |
| ~~B-6~~ (done, wave 1) | **"Hand-work remaining" table in REPORT.md**: count TODO(flawless) markers per kind at write time so regenerations show the debt burning down | REPORT accounts for all 183 components but says nothing about the 181 TODOs the same run planted | S |
| ~~B-7~~ (done, wave 1) | Cheap **timing assertion** over tests/fixtures pinning the "half a second" analysis claim as the analyser grows | Claim now carries a dated measurement (2026-08-23, 99 files → 463 ms) but nothing re-checks it | S |

Perf micro-items measured and deliberately NOT taken (recorded so nobody
re-litigates them): parallelising the analyse loop (~2.5% projected saving —
sequential is fine); template building (no quadratic behaviour found); process
spawns (a full 7-task run spawns exactly 3 children — the per-file-spawn fear
is already fixed and guarded by a comment at biomeSweep.ts:89).
