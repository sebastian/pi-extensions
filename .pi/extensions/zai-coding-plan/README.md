# Z.AI Built-in Provider Enhancer for pi

Enhances pi's built-in `zai/*` provider instead of registering a custom provider.

Use pi's official model IDs, for example:

- `zai/glm-5.2`
- `zai/glm-5.1`

## What this package still does

- Shows a compact live Z.AI quota indicator in the interactive status line.
- Adds a small per-turn system-prompt nudge for `zai/glm-5.1` and `zai/glm-5.2` to be concise, direct, and less sycophantic.
- Clamps the active `zai/glm-5.1` and `zai/glm-5.2` `contextWindow` to `116384`, so pi compacts around ~100k prompt tokens instead of riding the much larger advertised window.

## What this package no longer does

It does **not** register a separate `zai-coding-plan/*` provider or custom model list. Pi's built-in `zai` provider already uses the official coding-plan endpoint:

- `https://api.z.ai/api/coding/paas/v4`

That built-in provider now carries the current Z.AI compatibility metadata, including GLM-5.2 `reasoning_effort` / `max` support. This extension only adds the local workflow tweaks above.

## Install

Global install:

```text
pi install /absolute/path/to/.pi/extensions/zai-coding-plan
```

Project-local install:

```text
pi install -l /absolute/path/to/.pi/extensions/zai-coding-plan
```

Or use it for one run:

```text
pi -e /absolute/path/to/.pi/extensions/zai-coding-plan
```

## Configure auth

Use pi's normal built-in `zai` provider auth. For environment auth:

```bash
export ZAI_API_KEY=your_zai_api_key
```

## Use it

Start pi, open `/model`, and pick a built-in `zai/*` model.

CLI example:

```bash
pi --provider zai --model glm-5.2
```

When a Z.AI-backed model is active, the extension shows a small live usage status with your current 5-hour and 7-day quota headroom whenever the monitor endpoint exposes those windows.

## Notes

- The quota status indicator uses `GET /api/monitor/usage/quota/limit` on `api.z.ai`, which is also what Z.AI's official usage-query plugin relies on.
- The quota indicator is installed only in pi's interactive UI; RPC/JSON/print runs still get the prompt/context-window tweaks without status polling.
- The context-window clamp updates the built-in `zai/glm-5.1` and `zai/glm-5.2` registry entries, with the active model as a fallback. It does not replace the provider or its model list.
- If pi later exposes extension-level `modelOverrides`, replace that small registry mutation with a public override.

## Sources

- Z.AI GLM Coding Plan overview: `https://docs.z.ai/devpack/overview`
- Z.AI quick start: `https://docs.z.ai/devpack/quick-start`
- Z.AI "Other Tools" guide: `https://docs.z.ai/devpack/tool/others`
- Z.AI OpenCode guide: `https://docs.z.ai/devpack/tool/opencode`
- Z.AI GLM-5.1 guide: `https://docs.z.ai/guides/llm/glm-5.1`
