# Reasoning Queue Extension

Adds per-message reasoning-level directives for pi prompts, including steering and follow-up messages queued while the agent is working.

## Usage

Prefix a message with a level directive:

```text
:low fix the typo after the current tool call
:xhigh design the migration plan
/think medium implement the next step
[r:off] summarize what changed
```

Supported levels: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`.

A standalone directive changes the default inherited level for later messages:

```text
/think low
```

Messages without a directive inherit the current default. If you queue `:low task one` and then queue `task two`, `task two` inherits `low`.

## Notes

- Directives are stripped before the message is sent to the model.
- If the selected model cannot use a requested level, the extension applies the closest supported level instead. For example, boolean on/off thinking models such as GLM/Z.AI clamp any non-`off` request, including `xhigh`, to `high`.
- The extension tracks queued messages in order and rewrites provider requests so steering messages inside an active agent run can still use their queued reasoning level.
- The footer status shows the current inherited default as `reasoning:<level>`.
