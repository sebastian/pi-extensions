# pi-extensions

My personal collection of extensions for [pi](https://github.com/earendil-works/pi-mono) and [Oh My Pi](https://omp.sh).

I maintain this repo for my own workflows and experiments.

## Notes

- Feel free to use, copy, adapt, and learn from anything here.
- I am **not** looking for external contributions, feature requests, or maintenance help on this repo.
- If something here is useful to you, great — please treat it as a freely available personal toolbox.
- The pi packages track pi's current runtime floor, currently target pi `1.0.x`, and declare Node.js `>=22.19.0`; OMP packages target the current OMP extension API and Bun `>=1.3.14`.

## Current contents

- `.omp/extensions/vim-mode/` — the OMP-native port of the Vim mode, using OMP's public editor APIs, managed extension timers, clipboard/app shortcut names, and plugin manifest
- `.omp/extensions/opencode-go/` — OMP's native OpenCode Go models using `OPENCODE_GO_API_KEY`
- `.omp/extensions/cloudflare-clef/` — Cloudflare Workers AI Clef as OMP's native judge, using `CLOUDFLARE_WORKERS_AI_API_KEY`
- `.omp/extensions/ponytail/` — an OMP-native port of [Dietrich Gebert's Ponytail](https://github.com/DietrichGebert/ponytail), with persistent `off`/`lite`/`full`/`ultra` modes, prompt injection, status and configuration commands, and the companion review/audit/debt/gain/help skills
- `.pi/extensions/toolbox/` — a small pi extension package with concise provider rate-limit handling plus `/review`, which reviews the current change or an exact jj/git revision/range, compares preferred reviewer models, deduplicates findings, and lets you choose which ones to address
- `.pi/extensions/reasoning-queue/` — streaming-aware per-message reasoning-level directives for normal, steering, and follow-up prompts, so queued work can switch between `low`, `high`, `xhigh`, `max`, etc. without wasting the active in-flight request or the whole queue on one setting
- `.pi/extensions/vim-mode/` — a much more capable vim-style modal editor for pi, with multiline visual selections, counts, Unicode-aware word motions, find/till motions, operator-pending `d`/`c`/`y`, linewise commands, paste, joins, and a stronger normal-mode editing surface
- `.pi/extensions/zai-coding-plan/` — an enhancer for pi's built-in `zai/*` provider that keeps the live quota indicator, less-sycophantic GLM-5.1/5.2 prompt nudge, and conservative ~100k context window without registering custom models

## OMP Ponytail setup

Add this checkout's absolute source directory to the existing `extensions` array in `~/.omp/agent/config.yml`, preserving any other entries:

```yaml
extensions:
  - /Users/sebastian/Code/pi-extensions/.omp/extensions/ponytail
```

Adjust the path to your checkout. Use the source path directly, not `omp plugin link`: OMP deduplicates entry paths, not symlink aliases, so linking this package globally also loads it a second time inside this repository.

Restart OMP. Ponytail defaults to `full` in new sessions and automatically loads in task/eval children, including custom agents. `/ponytail status` shows the current and default modes; `/ponytail full` re-enables a resumed session that previously saved `off`. `/ponytail default full` persists the default; `PONYTAIL_DEFAULT_MODE` takes precedence if set.

## OMP judge setup

Export `CLOUDFLARE_WORKERS_AI_API_KEY` and `TYPESAFE_JEV` in the shell that launches OMP, then link the provider globally:

```sh
omp plugin link "$PWD/.omp/extensions/cloudflare-clef"
```

Merge these entries into `~/.omp/agent/models.yml`, using your Cloudflare account ID:

```yaml
providers:
  cloudflare-workers-ai:
    modelOverrides:
      clef:
        headers:
          X-Cloudflare-Account-Id: your-32-character-account-id
  typesafe:
    apiKey: TYPESAFE_JEV
```

Merge this routing into `~/.omp/agent/config.yml` without replacing other roles:

```yaml
modelRoles:
  judge: typesafe/jev-latest
retry:
  fallbackChains:
    judge:
      - cloudflare-workers-ai/clef
```

Restart OMP to load the extension and exported keys. Jev is the primary judge; quota/API failures fall through OMP's existing retry chain to Clef. The extension owns an ephemeral loopback adapter between OMP's native Jev protocol and [Clef's Workers AI endpoint](https://developers.cloudflare.com/workers-ai/models/clef/); no separate service is needed. Fallback reacts to API errors, not a proactive free-credit balance check.

My `default` role uses `openai-codex/gpt-6-astra:max` with `retry.fallbackChains.default: []` in `~/.omp/agent/config.yml`. Failed requests stop after normal retries instead of switching models; other role-specific fallback chains remain enabled. This controls request recovery, not OMP's separate startup selection if the configured model is absent from its catalog.

My DeepSeek Flash roles use `opencode-go/deepseek-v4.1-flash` first and `deepseek/deepseek-flash` only as fallback, preserving each role's thinking level. Kimi K3 is absent from all configured roles and fallback chains; Kimi K2.7 is separate. OMP has no per-model hard denylist, so this does not prevent an explicit manual K3 selection.

Adapter regression check:

```sh
node --test .omp/extensions/cloudflare-clef/tests/transport.test.ts
```

## License

MIT. See [LICENSE](./LICENSE).

The Ponytail port is derived from Dietrich Gebert's MIT-licensed project and retains its copyright and permission notice in [`.omp/extensions/ponytail/LICENSE`](./.omp/extensions/ponytail/LICENSE).
