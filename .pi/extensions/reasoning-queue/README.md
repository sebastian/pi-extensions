# Reasoning Queue Extension

Adds per-message reasoning-level directives for pi prompts, including streaming-aware steering and follow-up messages queued while the agent is working.

## Usage

Prefix a message with a level directive:

```text
:low fix the typo after the current tool call
:max design the migration plan
/think medium implement the next step
[r:off] summarize what changed
```

Supported levels: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`.

A standalone directive changes the default inherited level for later messages:

```text
/think low
```

Messages without a directive inherit the current default. If you queue `:low task one` and then queue `task two`, `task two` inherits `low`.

Reasoning-level autocomplete opens for slash, colon, and bracket directive forms on current pi versions.

The extension follows pi's model-level `thinkingLevelMap` metadata, so GLM/Z.AI-style boolean thinking models clamp choices to the closest supported level. Anthropic-compatible adaptive thinking follows pi's `compat.forceAdaptiveThinking` metadata for built-in models, custom providers, and aliases.

## Notes

- Directives are stripped before the message is sent to the model.
- If the selected model cannot use a requested level, the extension applies the closest supported level instead. Extended `xhigh` and `max` levels are offered only when model metadata maps them explicitly.
- The rewriter leaves pi 0.79.9+ `chat-template` models untouched: pi-ai already resolves their `chat_template_kwargs` from the active thinking level, so this extension does not overwrite those kwargs with the qwen-style shape.
- The extension uses pi's `InputEvent.streamingBehavior` metadata to distinguish idle prompts from mid-stream steering and follow-up messages, so queued directives do not change the active in-flight provider request.
- The extension tracks queued messages in order, drops stale metadata when Pi's queue is restored for editing, and rewrites provider requests so steering messages inside an active agent run can still use their queued reasoning level.
- Model changes made while the agent is working are deferred until the queued message starts, so the in-flight request keeps its original model and reasoning payload shape.
- The status line shows the current inherited default as `reasoning:<level>` and stays in sync with pi's built-in thinking-level controls.
