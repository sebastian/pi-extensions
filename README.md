# pi-extensions

My personal collection of extensions for [pi](https://github.com/earendil-works/pi-mono) and [Oh My Pi](https://omp.sh).

I maintain this repo for my own workflows and experiments.

## Notes

- Feel free to use, copy, adapt, and learn from anything here.
- I am **not** looking for external contributions, feature requests, or maintenance help on this repo.
- If something here is useful to you, great — please treat it as a freely available personal toolbox.
- The pi packages track pi's current runtime floor, currently target pi `0.83.x`, and declare Node.js `>=22.19.0`; OMP packages target the current OMP extension API and Bun `>=1.3.14`.

## Current contents

- `.omp/extensions/vim-mode/` — the OMP-native port of the Vim mode, using OMP's public editor APIs, managed extension timers, clipboard/app shortcut names, and plugin manifest
- `.omp/extensions/ponytail/` — an OMP-native port of [Dietrich Gebert's Ponytail](https://github.com/DietrichGebert/ponytail), with persistent `off`/`lite`/`full`/`ultra` modes, prompt injection, status and configuration commands, and the companion review/audit/debt/gain/help skills
- `.pi/extensions/toolbox/` — a small pi extension package with concise provider rate-limit handling plus `/review`, which reviews the current change or an exact jj/git revision/range, compares preferred reviewer models, deduplicates findings, and lets you choose which ones to address
- `.pi/extensions/reasoning-queue/` — streaming-aware per-message reasoning-level directives for normal, steering, and follow-up prompts, so queued work can switch between `low`, `high`, `xhigh`, `max`, etc. without wasting the active in-flight request or the whole queue on one setting
- `.pi/extensions/vim-mode/` — a much more capable vim-style modal editor for pi, with multiline visual selections, counts, Unicode-aware word motions, find/till motions, operator-pending `d`/`c`/`y`, linewise commands, paste, joins, and a stronger normal-mode editing surface
- `.pi/extensions/zai-coding-plan/` — an enhancer for pi's built-in `zai/*` provider that keeps the live quota indicator, less-sycophantic GLM-5.1/5.2 prompt nudge, and conservative ~100k context window without registering custom models

## License

MIT. See [LICENSE](./LICENSE).

The Ponytail port is derived from Dietrich Gebert's MIT-licensed project and retains its copyright and permission notice in [`.omp/extensions/ponytail/LICENSE`](./.omp/extensions/ponytail/LICENSE).
