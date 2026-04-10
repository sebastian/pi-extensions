# Guided Discovery Extension

A Codex-style planning workflow for pi that lets you start from a loose feature prompt, research first, ask structured multiple-choice questions, save an implementation-ready plan, and then explicitly approve the switch into coding.

## Features

- read-only discovery mode with `read`, `bash`, `grep`, `find`, `ls`, `questionnaire`, and `web_research`
- structured multiple-choice clarifying questions with an `Other` fallback
- external docs / API / market / state-of-the-art research via `web_research`
- final-plan detection using the required discovery sections
- automatic save of the latest final plan to `PLAN.md`
- approval UI before implementation starts
- one-command handoff from planning into coding
- packaged as a reusable pi package, not just a project-local extension

## Commands

- `/discover [goal]` — enable guided discovery mode, and optionally kick it off with a loose prompt
- `/discover-off` — leave discovery mode and restore normal tools
- `/discover-implement [extra instructions]` — confirm and start implementing the approved plan
- `Ctrl+Alt+D` — toggle discovery mode

## How it behaves

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
   - approve and implement now
   - keep refining in discovery mode
   - leave discovery mode with the saved plan only

## Example workflow

```text
/discover Add a self-serve billing portal for teams
```

The agent should inspect the codebase, then optionally pull in external docs or market context when needed, ask structured questions, and eventually produce a final implementation-ready plan.

Then either approve from the UI or start manually:

```text
/discover-implement
```

Or add extra steering:

```text
/discover-implement Start with the smallest safe slice and add tests first.
```

## Install globally as a pi package

Because this directory now contains a `package.json` with a `pi` manifest, you can install it globally with a local path:

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
