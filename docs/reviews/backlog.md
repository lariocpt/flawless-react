# Opportunity backlog — live

Open items only, each tied to observed dogfood evidence (never invented
features). Completed rows, declined items and their full evidence are frozen in
[`../archive/backlog-completed-2026-10.md`](../archive/backlog-completed-2026-10.md);
reviews, probes and handoffs behind them are in [`../archive/`](../archive/).

| # | Opportunity | Evidence | Effort |
|---|---|---|---|
| B-27 | **Prologue-directive: scan to the first token, not to a byte bound** (FR-060's principled follow-up) | The 2026-09 fix raised the bound to 64KB and made the remaining miss of the bound explicit in the docblock; the principled form reads leading comments/whitespace and stops at the first token, so no header length can ever matter. The read runs once per IMPORTED module in a sweep (not per file), so the cost is bounded — take it when the classifier next moves, not as a standalone change | S |
| B-28 | **useRef v2: trace `ref.current = X` assignments before the JSX** (FR-057's coverage follow-up) | The 2026-09 fix models the ref as an opaque truthy `{}` with `current` unknown — the safe direction, but it leaves `ref.current` reads un-evaluable even when the assignment is a literal earlier in the render body. Tracing assignments in body order would close that gap; it is a coverage gain, not a correctness fix, which is why the under-modelling shipped first | M |
