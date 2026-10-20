---
name: flawless-a11y
description: Run and act on flawless-react's a11y task — biome's a11y rule group over a web tree, or the tool's own React Native analyser (six `a11y/*` rules with a denominator) under `--expo`, both writing one aggregate `reports/a11y.json`. Use when triaging accessibility findings, when the native run reports zero and you need to know whether it looked, when biome is not found, when a `biome-ignore` comment is flagged as unused, or when deciding what an icon-only control needs. For the suppression rules across tasks see flawless-findings.
---

# flawless a11y

```bash
bunx flawless-react "src/**/*.tsx" --tasks a11y
```

One task, two engines, one aggregate report (`flawless/reports/a11y.json`). Which
engine runs is decided by `--expo`, and the two are not interchangeable: biome's
rules are HTML/ARIA, the native rules are `accessibilityLabel`/`accessibilityRole`.

## Web: a biome sweep

The task runs biome with a **scratch config** — `recommended: false` plus only the
`a11y` group — so your project's `biome.json` is bypassed and a finding here is not
an invitation to reconfigure your lint. Findings print as
`file:line:col lint/a11y/<rule> message`.

Severities are mixed and mean what they say: `useAltText`, `useButtonType`,
`useHtmlLang`, `useAnchorContent`, `useHeadingContent`, `noRedundantRoles` are
errors; `noAutofocus`, `noLabelWithoutControl`, `noNoninteractiveTabindex`,
`noPositiveTabindex`, `noRedundantAlt`, `useFocusableInteractive` are warnings.
Errors are defects; warnings on a component that composes its label elsewhere (a
generic `Field` wrapper) are usually correct code.

**biome is a prerequisite on this path only.** The resolver looks in the target
package's `node_modules`, every ancestor (so a hoisted workspace root counts) and
`PATH`; when it finds nothing the task fails naming all of them. From the compiled
binary the message is explicit: install `@biomejs/biome` in the project you are
scanning, or put biome on `PATH`.

**And it has to be biome 2.** The sweep writes a biome 2 linter config and parses
its JSON reporter, so a candidate whose `--version` names another major is walked
past in favour of one that can read it — which is how a repo that hoists a 1.x
still gets a sweep from a 2 on `PATH` — and if none can, the task fails naming the
version and path it refused. A 1.x biome does answer, and what it prints is a
different document (`location.path` is an object, `message` an array of markup
runs), so its output cannot be read as findings. A source or npm install answers
with its own pinned 2 first and never sees the repo's biome: only the compiled
binary resolves into the scanned project.

## Native: the analyser, and its denominator

Biome's a11y rules are all HTML/ARIA. Over 31 React Native files carrying 82
unlabelled `<Pressable>`s they returned **zero**, while the same config finds 3/3 on
this repo's own DOM offender fixture — so the native path is the tool's own engine,
six rules:

| rule | severity | what it catches |
| --- | --- | --- |
| `a11y/unnamed-control` | error | a pressable whose children are provably textless with no `accessibilityLabel` |
| `a11y/missing-role` | error | a pressable with no `accessibilityRole` — RN has no implicit roles |
| `a11y/textinput-unlabelled` | error | a `TextInput` with no label; a `placeholder` alone does not count |
| `a11y/icon-unhidden` | warn | an icon from a known vector family exposed to the a11y tree with nothing to announce |
| `a11y/label-text-mismatch` | error | an `accessibilityLabel` that does not contain the visible text |
| `a11y/invalid-role` | error | an `accessibilityRole` value RN does not know |

Two things to read off every native run:

- **The summary always carries a denominator:** `N press target(s), N text input(s),
  N icon(s) examined, 6 native rules`. **A native zero without that denominator is a
  bug, not a clean bill.**
- **Files in DOM dialect are not swept.** A component whose host dialect is not
  native (a `react-native-web` surface, a web-only screen inside an Expo tree) is
  counted, not judged: the summary appends `N dom-dialect file(s) NOT swept — run
  without --expo for those`, and the report carries them under
  `domDialectFilesNotSwept`.

The engine is restrained on purpose, and that restraint is why its errors are
trustworthy: `unnamed-control` fires only on the **provably** nameless case —
children that are absent or all textless. A pressable rendering `{building.name}`
announces at runtime, so label-absence there is not a finding. The same for
`dynamicLabel` / `dynamicRole`: a label built by code is not a finding.

One freebie worth knowing: RN's own `<Button>` is exempt from `missing-role`,
because it has exactly one implicit role and the analyser injects it.

## What neither engine sees

Static a11y is name-and-role analysis. It does not check contrast, focus order,
reading order, motion, or whether a `role` is semantically right for the widget; the
web engine cannot see a label supplied by a wrapper it does not analyse, and the
native engine cannot see what a screen reader assembles at run time. Zero findings
means "no provably silent control", not "accessible".

## Suppressing

```tsx
// biome-ignore lint/a11y/noLabelWithoutControl: generic wrapper — every call site associates the control
```

Biome attaches the comment to the **next line's** diagnostic; for a multi-line JSX
element whose finding anchors on an attribute, put the comment inside the tag
directly above that attribute. Native findings have **no suppression mechanism** —
deliberately: each message names the one prop that retires it
(`accessibilityLabel`, `accessibilityRole`, `aria-hidden`), so either add it or the
finding is wrong and belongs in an issue.

The cross-config trap that makes a biome suppression report as `unused`, and the fix
for it, is in flawless-findings.

## Never

- Never read a native zero as a pass without its denominator.
- Never enable one of these rules in a project's biome config purely to silence the
  project's `biome ci` about the suppression — enable it because the suppressed site
  was the only finding, which is usually true, and say so in the commit.
- Never add `accessibilityRole` or `aria-*` to satisfy a sweep where the message's
  actual ask (`accessibilityLabel`, `aria-hidden`) is the fix.
