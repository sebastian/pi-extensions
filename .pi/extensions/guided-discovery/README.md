# Guided Discovery Extension

A Codex-style planning workflow for pi that lets you start from a loose feature prompt, research first, ask structured multiple-choice questions, save an implementation-ready plan, and then explicitly approve how coding should begin.

## Features

- read-only discovery mode with `read`, `bash`, `grep`, `find`, `ls`, `questionnaire`, and `web_research`
- structured multiple-choice clarifying questions with an `Other` fallback
- external docs / API / market / state-of-the-art research via `web_research`
- final-plan detection using the required discovery sections
- automatic save of the latest final plan to `PLAN.md`
- approval UI with two implementation paths:
  - direct handoff to the main session
  - isolated sub-agent implementation workflow
- bundled sub-agent roles for decomposition, implementation, checking, and validation
- `CHECKS.md` discovery for changed areas, with safe command filtering and automatic re-checking
- packaged as a reusable pi package, not just a project-local extension

## Commands

- `/discover [goal]` — enable guided discovery mode, and optionally kick it off with a loose prompt
- `/discover-off` — leave discovery mode and restore normal tools
- `/discover-implement [mode] [extra instructions]` — start implementation from the approved plan
  - examples:
    - `/discover-implement`
    - `/discover-implement direct Start with tests.`
    - `/discover-implement subagents Keep changes minimal.`
- `Ctrl+Alt+D` — toggle discovery mode

## How discovery mode behaves

While guided discovery mode is active:

- active tools are restricted to `read`, `bash`, `grep`, `find`, `ls`, `questionnaire`, and `web_research`
- `bash` is limited to a read-only allowlist
- the model is pushed to:
  - research the repo first
  - use external research only when it materially helps
  - prefer first-party sources for vendor / API details
  - infer the real product / UX / technical decision tree
  - ask 1-4 focused multiple-choice questions at a time
  - balance state-of-the-art practice with simple, robust implementation choices
  - produce a final plan with problem, findings, decision log, approach, implementation plan, acceptance criteria, and risks

When the assistant produces a final plan, the extension:

1. auto-saves it to `PLAN.md`
2. appends a `## Sources consulted` section when external sources were used
3. shows an approval UI with options to:
   - implement directly
   - implement with sub-agents
   - keep refining in discovery mode
   - leave discovery mode with the saved plan only

## Sub-agent implementation mode

Sub-agent mode keeps orchestration out of the main conversation and runs a fixed workflow in isolated `pi` subprocesses.

### Stages

1. **decomposer** — breaks `PLAN.md` into actionable phases with dependencies, touched paths, and conservative parallel-safety hints
2. **worker** — implements phases, usually sequentially, only parallelizing batches when touched paths do not overlap and safety is explicit
3. **checker** — reviews the implementation for:
   - security
   - regression risk
   - UI consistency
   - performance regression risk
   - dead code / loose ends
   - unnecessary complexity
   - relevant `CHECKS.md` guidance
4. **fix pass** — the worker applies concrete checker findings automatically
5. **re-check** — the checker runs once more after the fix pass
6. **validator** — compares the actual result against the approved plan and reports coverage plus discrepancies

If the validator finds material discrepancies, the extension asks whether to:

- implement the remaining items now
- reformulate in discovery mode
- accept the discrepancies and finish

## `CHECKS.md` behavior

For every changed file, the sub-agent workflow walks ancestor directories up to repo root and collects relevant `CHECKS.md` files.

Command suggestions found in those files are treated as guidance, not trusted scripts:

- common verification commands such as tests, lint, type checks, and builds may run automatically
- destructive, installation, deployment, or otherwise risky commands are blocked
- blocked commands are still surfaced to the checker so they are not silently ignored

## Direct vs sub-agent mode

### Direct mode

- preserves today’s lightweight handoff behavior
- exits discovery mode
- sends an implementation prompt back into the main session

### Sub-agent mode

- requires a saved `PLAN.md`
- runs implementation in isolated contexts with bundled prompts
- keeps orchestration chatter out of the main session
- adds an automatic check / fix / re-check / validate pipeline

In non-UI contexts, `/discover-implement` still defaults to the direct path unless you explicitly request `subagents`.

## Example workflow

```text
/discover Add a self-serve billing portal for teams
```

The agent should inspect the codebase, then optionally pull in external docs or market context when needed, ask structured questions, and eventually produce a final implementation-ready plan.

Then either approve from the UI or start manually:

```text
/discover-implement
```

Or explicitly choose the isolated workflow:

```text
/discover-implement subagents Start with the smallest safe slice.
```

## Install globally as a pi package

Because this directory contains a `package.json` with a `pi` manifest, you can install it globally with a local path:

```text
pi install /absolute/path/to/.pi/extensions/guided-discovery
```

Or project-locally:

```text
pi install -l /absolute/path/to/.pi/extensions/guided-discovery
```

If you later publish this folder to npm or a git repo, it can also be installed like any other pi package.

## Project-local usage

This extension still works as a project-local auto-discovered extension because it lives in:

```text
.pi/extensions/guided-discovery/
```

So in this repo you can just run `pi` and then `/reload` if pi was already open.
