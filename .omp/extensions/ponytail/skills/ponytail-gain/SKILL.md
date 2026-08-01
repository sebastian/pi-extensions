---
name: ponytail-gain
description: >
  Show Ponytail's published benchmark impact as a compact scoreboard: less
  code, lower cost, and faster completion. One-shot display, not a persistent
  mode, and not a per-repo number. Trigger: /ponytail-gain, "ponytail gain",
  "what does ponytail save", "show ponytail impact", "ponytail scoreboard".
---

# Ponytail Gain

Display this scoreboard when invoked. One-shot: do not change mode or persist
anything.

The figures are the published agentic benchmark means across twelve feature
tasks using Haiku 4.5 with four runs per task. They are measured, not computed
from the current repo. Source: https://github.com/DietrichGebert/ponytail/tree/main/benchmarks

## Scoreboard

```text
  ponytail gain              agentic benchmark mean, 12 tasks

  Lines of code   baseline  100%   ponytail  46%   reduction 54%
  Tokens          baseline  100%   ponytail  78%   reduction 22%
  Cost            baseline  100%   ponytail  80%   reduction 20%
  Time            baseline  100%   ponytail  73%   reduction 27%
  Safety          baseline  100%   ponytail 100%

  This repo: /ponytail-debt  shortcuts deferred
             /ponytail-audit remaining cuttable complexity
```

## Honesty boundary

These are benchmark means, not this repo. Never print a per-repo savings
number: the unbuilt version was never written, so there is no real baseline
to subtract from in a live repo.

## Boundaries

One-shot display. Edits nothing, changes no mode.
"stop ponytail" or "normal mode": revert.
