# Toolbox Extension

Small pi toolbox package for `/review` and provider rate-limit cleanup.

## What it does

- formats ugly provider rate-limit errors into concise messages
- waits for short server-requested retry delays before pi retries
- adds `/review` for the current uncommitted change
- supports `/review <exact-revision-or-range>` for jj/git snapshots, e.g. `/review main..HEAD`
- supports `/review for <focus>` and `/review <scope> with an extra focus on <focus>`
- runs alternate reviewers from GPT-5.6 Sol, GPT-5.5, and GLM-5.2 when available, using `xhigh` for GPT and `high` for GLM to avoid the expensive `max` tier, then deduplicates findings and lets you pick what to fix

## Install

```text
pi install /absolute/path/to/.pi/extensions/toolbox
```

Project-local:

```text
pi install -l /absolute/path/to/.pi/extensions/toolbox
```
