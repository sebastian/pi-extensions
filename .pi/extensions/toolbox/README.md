# Toolbox Extension

Small pi toolbox package for `/review`, **opt-in per-session** task orchestration, and provider rate-limit cleanup.

## What it does

- formats ugly provider rate-limit errors into concise messages
- waits for short server-requested retry delays before pi retries
- adds `/review` for the current uncommitted change
- supports `/review <exact-revision-or-range>` for jj/git snapshots, e.g. `/review main..HEAD`
- supports `/review for <focus>` and `/review <scope> with an extra focus on <focus>`
- runs alternate reviewers from the current pi model scope, preferring GPT-5.6 Sol, GPT-5.5, and GLM-5.2 when available, using `xhigh` for GPT and `max` for GLM, then deduplicates findings and lets you pick what to fix

## Task orchestration (off by default)

Run `/orchestrate on` in a session to make the foreground agent a supervisor.
Then talk normally:

```text
Add tests for the parser, then update its documentation.
Actually, put the documentation task first. Leave the running task alone.
```

The supervisor maintains task IDs, requests, acceptance criteria and statuses through
`work_queue`. One background Pi worker implements a task; a fresh validator checks
**every criterion** against the workspace before it becomes `done`. The next task
starts only once the foreground agent is idle, so it can finish reshuffling the plan.
Validation failures, malformed results and process failures block the task and pause
the queue. Retrying or changing failed criteria requires your decision, not automatic
retry loops. Use `/tasks <id>` to inspect the evidence.

| Command | Effect |
|---|---|
| `/orchestrate on` | Opt this session in; normal sessions remain unchanged |
| `/tasks` / `/tasks <id>` | Show the queue or a task's report, validation and cost |
| `/orchestrate pause` | Stop dispatching; let the active task finish |
| `/orchestrate start` | Resume dispatch after resolving any blocked tasks |
| `/orchestrate cancel <id>` | Explicitly cancel queued or active work; no rollback |
| `/orchestrate retry <id>` | Requeue a stopped blocked/cancelled task; then use `start` |
| `/orchestrate off` | Restore normal tools; finish/cancel active work first |

Task state is stored in the session, not project files. Resuming or reloading keeps
the queue **paused**, and interrupted work becomes blocked rather than silently
replayed. Quit/reload/session switches stop the worker; an IPC watchdog also stops
children if the parent crashes. Turn supervision off before
`/tree` or `/fork`; branching conversation history cannot undo workspace edits.
`Escape` aborts the foreground response, not the independent worker.

Workers inherit the selected model and thinking level at dispatch, repository
instructions, skills and discovered trusted extensions. They do **not** inherit the supervisor's
conversation: task requests must be self-contained. Task completion notices do not
trigger extra supervisor model calls. Per-task costs include implementation and
validation, but are separate from the foreground Pi footer's usage totals.

This is one worker **per session**, sharing the current workspace. Don't run another
writer there concurrently. The supervisor cannot call write/edit/bash tools; the
validator has inspection tools plus bash for checks. These are workflow constraints,
**not an OS sandbox**. Normal Pi tool privileges and extension trust still apply.

## Install

```text
pi install /absolute/path/to/.pi/extensions/toolbox
```

Project-local:

```text
pi install -l /absolute/path/to/.pi/extensions/toolbox
```
