# Toolbox Extension

This directory is the catch-all home for my pi extension experiments, shared workflow code, prompts, and tests.

Right now, the extension manifest exposed to pi registers one main command: `/review`.

## What it does

- adds `/review` to review the current uncommitted change
- adds freeform `/review ...` scope and focus parsing, so you can say things like `/review for security`, `/review the two last changes`, or `/review all changes since prod with an extra focus on security`
- still supports `/review <change>` to review a specific jj or git change / revision
- treats the current session model as the implementation model
- runs the two other strongest available top-level models as reviewers
- asks those reviewer models for structured PR-style findings
- deduplicates overlapping findings while preserving which model reported what
- shows a live per-model review widget while the reviewers run, including current state, safe reasoning/activity summaries, latest visible output, and usage
- shows a review summary in the conversation
- lets you choose which findings should be addressed now
- sends only the selected findings back into the main session for implementation

## Command

- `/review` — review the current uncommitted change
- `/review for <focus>` — keep the default scope but add extra focus, e.g. `/review for security`
- `/review <natural-language scope>` — review a broader or alternate scope, e.g. `/review the two last changes`
- `/review <scope> with an extra focus on <focus>` — combine both, e.g. `/review all changes since prod with an extra focus on security`
- `/review <change>` — review a specific jj change or git revision

## Typical flow

1. Implement with your current model.
2. Run `/review`.
3. Read the merged review summary.
4. Select all, some, or none of the findings to address.
5. The extension sends the selected findings back to the main session so the agent can fix them.

## Notes

- If there are fewer than two alternate reviewer models available, the command uses as many as it can.
- For historical jj/git changes, the command reviews a snapshot of that change rather than your current working copy.
- The review is intentionally bounded toward concrete bugs, regressions, security issues, side effects, and guidance violations.
- Natural-language scope parsing is intentionally lightweight: it understands common phrasings for recent changes, `since <ref>`, explicit revision/range text, and optional extra-focus clauses.

## Install globally as a pi package

Because this directory contains a `package.json` with a `pi` manifest, you can install it globally with a local path:

```text
pi install /absolute/path/to/.pi/extensions/toolbox
```

Or project-locally:

```text
pi install -l /absolute/path/to/.pi/extensions/toolbox
```

## Project-local usage

This extension is also auto-discovered when it lives at:

```text
.pi/extensions/toolbox/
```

So in this repo you can just run `pi` and then `/reload` if pi was already open.
