# pi-extensions

My personal collection of [pi](https://github.com/badlogic/pi-mono) extensions.

I maintain this repo for my own workflows and experiments.

## Notes

- Feel free to use, copy, adapt, and learn from anything here.
- I am **not** looking for external contributions, feature requests, or maintenance help on this repo.
- If something here is useful to you, great — please treat it as a freely available personal toolbox.

## Current contents

- `.pi/extensions/toolbox/` — a catch-all pi extension package where I keep shared workflows, prompts, utilities, and tests; its current public entrypoint adds a flexible `/review` command that can review the current change or broader user-described scopes, compare them against preferred reviewer models, deduplicate the findings, and let you choose which ones to address
- `.pi/extensions/reasoning-queue/` — per-message reasoning-level directives for normal, steering, and follow-up prompts, so queued work can switch between `low`, `high`, `xhigh`, etc. without wasting the whole queue on one setting
- `.pi/extensions/vim-mode/` — a much more capable vim-style modal editor for pi, with counts, word motions, find/till motions, operator-pending `d`/`c`/`y`, linewise commands, paste, joins, and a stronger normal-mode editing surface
- `.pi/extensions/zai-coding-plan/` — a pi provider extension that adds Z.AI **coding plan only** models via the official coding-plan endpoint so usage counts against plan quota rather than separate API billing

## License

MIT. See [LICENSE](./LICENSE).
