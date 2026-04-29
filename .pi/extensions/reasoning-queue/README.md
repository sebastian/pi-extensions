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

You can also use the inline fields shown below the editor instead of typing a directive:

- Press `Tab` from an empty prompt (or from vim-mode normal mode) to focus `model`, then `reasoning`, then back to `prompt`.
- Press `Shift+Tab` to move backward through those fields.
- In the `model` or `reasoning` field, press `←`/`→` or `↑`/`↓` to cycle values, or `Enter` to pick from a selector.
- The reasoning field only shows levels valid for the selected model, so switching to GLM/Z.AI models clamps choices to the closest supported level.

## Notes

- Directives are stripped before the message is sent to the model.
- If the selected model cannot use a requested level, the extension applies the closest supported level instead. For example, boolean on/off thinking models such as GLM/Z.AI clamp any non-`off` request, including `xhigh`, to `high`.
- The extension tracks queued messages in order and rewrites provider requests so steering messages inside an active agent run can still use their queued reasoning level.
- The footer status shows the current inherited default as `reasoning:<level>`.
