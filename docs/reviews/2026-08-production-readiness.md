# Production-readiness assessment — August 2026

Scored against the post-engagement state (main after PRs #1–#4), with every
score anchored to evidence: a file, a measurement, or a dogfood outcome from
[`2026-08-review.md`](2026-08-review.md). An open P0 in the findings ledger
would cap its dimension at 2; none is open. Dimensions 2–4 count double —
they are the product.

## Scorecard

Scale: 1 broken/absent · 2 works on the author's machines · 3 works for a
colleague following the docs · 4 usable by a stranger team in production ·
5 best-in-class.

| # | Dimension | Score | Evidence |
|---|---|---|---|
| 1 | Install & runtime story | **2** | Published only to a LAN Verdaccio (`publishConfig.registry: npm.in.drlario.org`); compiled binary distributed via the private apps plane; Bun-only engines gate; binary needs biome reachable for a11y/react-rules. A stranger cannot install it today. |
| 2 | Emitted-artefact correctness ×2 | **3** | Dogfood: all five layers green (unit 508, browser 191, perf 212, e2e 39/39, load 33/33); emitted configs/servers executed by the repo's own tests. Held back by open P1s that bite on common shapes: title injection via backtick labels (FR-012), `src/`-assuming colocate glob (FR-013), dotted-callee mocks that fail correct RSCs (FR-014). |
| 3 | Analysis soundness ×2 | **3** | Two-hop props, intersections, cva tables, hooks/deps, honest `uncertain` bails; effect-only and useRender shapes detected since this round (183/183 components accounted, 0 unreadable). Held back by FR-011 — wrapper-typed props (`forwardRef<E,P>`, `FC<P> = memo`) extract silently empty, violating the tool's own recorded-give-up contract — and 181 TODO markers of residual hand-work. |
| 4 | Honesty of findings ×2 | **4** | The differentiator: skip-with-reason specs, REPORT.md's printed arithmetic, baseline-gated pipes, throw-on-login e2e setup, commented-out unfilled pipes, machine-independent repro lines. This round closed the exit-code P0 (FR-001) and suppression noise (FR-008). Not a 5 while FR-011's silent empties exist. |
| 5 | Docs accuracy | **4** | The doc-honesty sweep landed: regeneration contract, refusal scope, profile path, click-rerender description all verified against code; the perf claim carries a dated measurement. Docs, website, and skills were rewritten from the same evidence. |
| 6 | Error handling & DX | **3** | UsageError→exit-2 now consistent (incl. `--nextjs`, directory patterns); non-TTY safe; good biome-missing message; `--help` complete. Real workflow friction remains: no-force over an adopted suite exits 1 with no refresh mode (FR-028), `--changed` needs a task subset to run anything (FR-017). |
| 7 | Test suite & CI rigor | **3** | 513 tests; the emitted-execution pattern is genuinely unusual (emitted shell/js executed under real interpreters, servers booted and curled, configs interrogated via the real runners). Gaps: no emitted unit spec runs under real vitest in CI (FR-018), no playwright spec meets a browser (FR-022), no crust in CI (FR-021), no biome gate (FR-023). |
| 8 | Performance at scale | **5** | Measured: full 7-task generation over 99 files ≈ 0.95 s user-felt; analysis 463 ms; 3 child processes per run; no LLM latency or cost anywhere. Extrapolates to seconds at 500 files. Best-in-class for the category by construction. |
| 9 | Security of emitted code | **4** | Host and mock servers bind `127.0.0.1` explicitly (templates.ts:482, :1472); `e2e/.auth.json` (session cookies) is auto-gitignored; identifiers reaching emitted code go through JSON.stringify/regex-escape (titles excepted — FR-012). No formal threat model. |
| 10 | Versioning & compat | **2** | `0.3.0-dev`; no declared support matrix (proven on React 19.2 + Next 16 in practice); no semver discipline; write-once files never receive later fixes (FR-016, B-4) — the upgrade story for adopted suites is git archaeology. |
| 11 | Portability / machine assumptions | **3** | Emitted artefacts are machine-independent by design (relative repro lines, no timestamps, indentation-preserving merges — all tested). The tool's own distribution and CI are single-LAN (Verdaccio, Jenkins mounts). |

**Weighted total: 46/70 (66%).** Verdict: **B− as an internal power tool,
not yet shippable as a product.** For the team that built it — on this stack,
this LAN — it is genuinely production-useful today, and dimensions 4 and 8
are already best-in-class traits. The distance to "a stranger team adopts it"
is concentrated in two gates.

**Gates to 1.0** (every dimension ≤ 2 contributes):
1. **Distribution** — publish to a public registry (or public binary
   releases); declare the support matrix; CI off the private LAN.
2. **Upgrade story** — a refresh mode between nothing and `--force`
   (FR-028), a regenerable host registry (FR-016), and content-hash
   refresh for colocated specs (B-4), so adopted suites can receive tool
   improvements without clobbering hand-work.

## Out-of-the-box coverage and impact (measured, this app)

What one command produced on mybodycorpai `apps/web` (99 files, 183
components), before any hand-work:

| Layer | Estate | Result |
|---|---|---|
| Unit (vitest/jsdom) | 174 spec files, 522 tests | 508 pass / 14 reasoned skips |
| Browser (playwright vs bun host) | 96 specs | 191 pass / 12 skips |
| Perf profile (Profiler + react-scan + heaps) | 96 specs | 212 pass / 263 scaffold-time skips |
| Route e2e (real server, real login) | 31 routes / 39 tests | 39 pass |
| Load (crust pipes, baseline-gated) | 33 pipes | 33 pass |
| Findings | perf-static 245 · a11y+react-rules burned to 0 | triaged |

Measured line coverage of the **unit layer alone** (v8): **64.7% of all
component-file lines**; inside `src/components/`: 66.2% lines / 88.9%
branches. The browser, profile, e2e and load layers sit on top of that and
are not measurable by v8. (`src/lib/` coverage is 15% — correctly so: the
tool targets components, not libraries. Combined crust+flawless coverage of
a full Next.js app is a future exercise.)

**Time-saving estimate, stated honestly.** Hand-writing comparable
scaffolding — 174 RTL spec files (~15–30 min each), 31 route e2e specs, 33
load pipes with an env contract, and a working Profiler/react-scan/heap
harness — is roughly **70–130 hours** of competent work. Generation costs
~1 second plus the hardening loop; dogfood iteration 3 (fixtures filled,
findings burned to zero, three specs hand-hardened) took about 90 minutes.
The honest caveats: generated assertions are shallower than an engineer's
best hand-written test for a critical flow; 181 `TODO(flawless)` markers
remain as the priced-in hand-work (89% of them in three mechanically
derivable clusters — the backlog's B-1/2/3); and the number that matters
long-term is maintenance, where regeneration tracking source changes
(iteration 4: regenerated specs correctly followed the id-keyed form
refactor) beats hand-maintained suites at their weakest point.

## Competitor comparison

Facts researched 2026-08-24; every claim carries its source in the research
log, unverifiable ones are marked. Two landscape findings first, because they
reframe everything: **Octomind was discontinued in May 2026** (domain no
longer resolves; no first-party post-mortem) and **Qodo Cover's repo was
abandoned 2025-06-15** (Qodo pivoted to PR review) — of the dedicated
AI-test-generation products chosen for this comparison a year ago, half no
longer exist. Nobody left in the space publishes prices; the only transparent
pricing is editor-agent subscriptions.

react-scan and axe are components flawless *uses*, not competitors, and are
deliberately absent.

| | Mechanism | Determinism | Input needed | You own the code | Categories | Source stays local | Price (as-of 2026-08) | Maintenance | React 19 / RSC |
|---|---|---|---|---|---|---|---|---|---|
| **flawless-react** | static analysis + codegen | same input → same bytes | source only | yes, entirely | unit, browser, perf-profile, perf-static, a11y, react-rules, e2e, load | yes — no network at all | $0 marginal | regen tracks source; write-once set holds hand-work | proven (dogfooded on React 19.2 + Next 16, RSC-aware) |
| **Meticulous** | record/replay, AI-curated | replay deterministic; curation not | script tag + real traffic + (Next.js) your app container on their infra | no — hosted suite, no test code exists | visual/behavioral e2e regression | no — sessions incl. network responses uploaded | sales-led, pricing page 404 | fully automatic (their side) | Next.js App Router guide; React 19 unstated |
| **Checksum.ai** | LLM agents → Playwright PRs | output runs deterministically; generation/healing not | repo + running test environment | yes — plain Playwright via PRs | e2e, API, CI-generated tests | no — SaaS with repo access | tiered by workflows, $ undisclosed | self-healing agent (~70% autonomous, self-reported) | framework-agnostic (browser-level); unstated |
| **Qodo Cover** | LLM loop, coverage-validated | generation nondeterministic | buildable project + LLM key | yes — AGPL OSS | unit only | yes, with a self-hosted model | free + tokens | none — **abandoned 2025-06** | no JS/TS support listed |
| **Octomind** | LLM authoring → Playwright | execution deterministic | URL of running app | exportable Playwright | web e2e only | no | historical, conflicting | none — **discontinued 2026-05** | moot |
| **Editor agents** (Copilot/Cursor/Claude Code) | general LLM, prompted | generation varies run-to-run; committed tests run deterministically | source + a test command | yes | anything you ask for, quality bounded by review | no — cloud inference | $10–100/user/mo | manual re-prompt; agent fixes on demand | yes — current model knowledge |
| **Manual** (Testing Library + Playwright + Profiler wiring) | a person | as good as the person | source + time | yes | anything, at ~70–130 h for this scale | yes | salary | full manual burden | yes |

**Choose it when:**
- *flawless-react* — you want a deterministic, offline, code-owned scaffold of
  the whole quality surface in one second, and accept hardening the TODOs and
  living without vendor support.
- *Meticulous* — you have real traffic, want zero test-authoring forever, and
  accept renting a suite you can neither read nor take with you.
- *Checksum* — you want maintained Playwright e2e in your repo without writing
  it, and accept a SaaS in the loop.
- *Editor agents* — the realistic 2026 default: flexible, framework-current,
  and only as rigorous as the review you give it. A team can rationally use
  flawless for the mechanical scaffold and an editor agent for the deep
  hand-written flows — they compose rather than compete.
- *Manual* — the critical flows where an engineer's intent is the point.

**Face-off on the dimensions where flawless competes directly** (1–5;
maturity/support scored honestly against funded vendors):

| Dimension | flawless | Meticulous | Checksum | Editor agents | Manual |
|---|---|---|---|---|---|
| Determinism (input→output) | 5 | 4 | 3 | 2 | 5 |
| Code ownership / exit cost | 5 | 1 | 4 | 5 | 5 |
| Offline / source stays local | 5 | 1 | 1 | 1 | 5 |
| Marginal cost per run | 5 | 2 (unverified) | 2 (unverified) | 4 | 1 |
| Category breadth (unit→load) | 5 | 2 | 2 | 4 | 4 |
| Setup to first green suite | 4 | 3 | 3 | 4 | 1 |
| Maintenance automation | 3 | 5 | 4 | 2 | 1 |
| Maturity / support / community | **1** | 4 | 3 | 5 | 5 |
| Framework future-proofing | 3 | 3 | 4 | 5 | 5 |

The two rows flawless loses are real: it is a single-author 0.3.0-dev tool on
a private registry with no support channel, and its framework coverage moves
only when its author moves it — a funded vendor or a frontier model tracks
React's churn for you. The rows it wins, it wins by construction, not by
polish: no LLM and no network anywhere in the loop is a property the funded
half of this table cannot retrofit, and the May-2026/June-2025 shutdowns are
a reminder that a hosted suite's exit cost is the whole suite.

**Final rating:** flawless-react is a **strong niche instrument as a
deterministic, offline, code-owned test scaffolder for React/Next.js — the
only product in this comparison covering unit-through-load in one pass —
compared against tools that are either better-funded conveniences with rented
output (Meticulous, Checksum), general-purpose agents with no determinism
story (editor LLMs), or dead (Octomind, Qodo Cover). At 66% weighted
production-readiness it is production-useful for its own team today and two
gates (public distribution, an upgrade story for adopted suites) away from
being honestly recommendable to strangers.**
