# Z.AI Coding Plan Provider for pi

Adds an explicit `zai-coding-plan/*` provider namespace to pi so Z.AI GLM Coding Plan traffic goes to the official coding endpoint:

- `https://api.z.ai/api/coding/paas/v4`

That is the endpoint Z.AI documents for supported coding tools using the OpenAI-compatible protocol, and it is what makes requests count against the **GLM Coding Plan quota** instead of separate general API billing.

## Why this package exists

Z.AI documents two main integration patterns for coding agents:

- **Claude Code** uses Z.AI's Anthropic-compatible endpoint:
  - `https://api.z.ai/api/anthropic`
- **Other tools** that speak the OpenAI-compatible API should use the dedicated coding endpoint:
  - `https://api.z.ai/api/coding/paas/v4`

OpenCode also exposes a separate **Z.AI Coding Plan** provider alongside the regular Z.AI provider, which makes the coding-plan path explicit for users.

This pi package follows that same idea and registers a dedicated provider:

- provider id: `zai-coding-plan`
- auth env var: `ZAI_API_KEY`
- API type: `openai-completions`

The package also applies the Z.AI-specific OpenAI compatibility flags pi needs for:

- top-level thinking control (`thinkingFormat: "zai"`)
- no `developer` role
- tool-call streaming on the newer coding-plan models

## Included models

- `zai-coding-plan/glm-5.1`
- `zai-coding-plan/glm-5-turbo`
- `zai-coding-plan/glm-5`
- `zai-coding-plan/glm-4.7`
- `zai-coding-plan/glm-4.5-air`

These match the GLM Coding Plan model families documented by Z.AI for coding-tool usage.

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

Set your Z.AI API key in the environment before starting pi:

```bash
export ZAI_API_KEY=your_zai_api_key
```

## Use it

Start pi, open `/model`, and pick one of the `zai-coding-plan/*` models.

CLI example:

```bash
pi --provider zai-coding-plan --model glm-5.1
```

## Notes

- On newer pi versions, core may already ship built-in `zai/*` models aimed at the same coding endpoint. This package is still useful as an explicit, backportable `zai-coding-plan/*` namespace.
- Z.AI's coding-plan docs recommend the OpenAI-compatible coding endpoint for non-Claude coding tools; this package intentionally follows that route instead of the Anthropic-compatible Claude Code path.

## Sources

- Z.AI GLM Coding Plan overview: `https://docs.z.ai/devpack/overview`
- Z.AI quick start: `https://docs.z.ai/devpack/quick-start`
- Z.AI "Other Tools" guide: `https://docs.z.ai/devpack/tool/others`
- Z.AI OpenCode guide: `https://docs.z.ai/devpack/tool/opencode`
- Z.AI GLM-5.1 guide: `https://docs.z.ai/guides/llm/glm-5.1`
- OpenCode providers docs: `https://opencode.ai/docs/providers/`
