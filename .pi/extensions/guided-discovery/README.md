# Guided Discovery Extension

A research-first planning workflow for pi that turns a loose feature prompt into a concrete implementation plan, asks structured clarifying questions, saves the approved plan to `PLAN.md`, and then hands off to a simple straight-line implementation flow in the main session.

## Features

- read-only discovery mode with `read`, `bash`, `grep`, `find`, `ls`, `questionnaire`, and `web_research`
- discovery runs in its own isolated jj workspace (or git worktree fallback), and relative repo reads plus read-only bash commands are routed there automatically
- stronger guided questioning for idea-shaping work: discovery is pushed to ask focused questionnaire batches that clarify the real goal, side effects, and decision points before finalizing
- structured multiple-choice clarifying questions with a recommended option shown first and an `Other` fallback
- external docs / API / market / state-of-the-art research via `web_research`
- concise final-plan detection and automatic save of the latest plan to the isolated workspace `PLAN.md`
- explicit end-of-discovery choice: **Implement now**, **Do not implement**, or **Keep refining in discovery mode**
- straight-line implementation handoff in the main session with built-in guidance to:
  - implement directly
  - run one review pass
  - immediately fix all P1-or-higher findings
  - run a second review pass
  - present remaining findings via `questionnaire` so you can choose which to address and which to ignore
- packaged as a reusable pi package, not just a project-local extension

## Commands

- `/discover [goal]` — enable guided discovery mode and optionally kick it off with a loose prompt
- `/discover-off` — leave discovery mode and restore normal tools
- `/discover-implement [extra instructions]` — exit discovery mode and start straight-line implementation from the approved plan
- `Ctrl+Alt+D` — toggle discovery mode

Deprecated compatibility aliases still exist, but they now just route back to the straight-line implementation flow instead of launching sub-agents.

## How discovery mode behaves

While guided discovery mode is active:

- active tools are restricted to `read`, `bash`, `grep`, `find`, `ls`, `questionnaire`, and `web_research`
- discovery immediately creates an isolated workspace and routes relative repo reads plus read-only bash commands there
- `bash` is limited to a read-only allowlist
- the model is pushed to:
  - do a fast repo scan first
  - proactively research external products, APIs, ecosystems, and market patterns when they materially affect the decision
  - prefer first-party sources for vendor / API details
  - surface the real product / UX / technical trade-offs and recommend a default
  - ask focused questionnaire batches for broad or ambiguous feature ideas before finalizing
  - explicitly uncover the real user outcome, important side effects, scope boundaries, and implementation-shaping decisions
  - keep planning concise and implementation-oriented
  - produce a final plan that reflects only the agreed path
  - produce a final plan with problem, key findings, the agreed trade-off rationale, approach, build plan, acceptance checks, and risks

When the assistant produces a final plan, the extension:

1. auto-saves it to the isolated workspace `PLAN.md`
2. appends a `## Sources consulted` section when external sources were used
3. shows a simple approval UI:
   - **Implement now**
   - **Do not implement**
   - **Keep refining in discovery mode**

## Implementation handoff

When you choose **Implement now**, the extension exits discovery mode and sends a structured implementation prompt back into the main session.

That prompt instructs the assistant to work in a simple straight line:

1. re-scan the relevant files
2. implement the approved plan directly in the main session
3. run one focused review for logic bugs, regressions, side effects, security, UX, and missed plan requirements
4. immediately fix every P1-or-higher finding
5. run a second review pass
6. present any remaining findings with `questionnaire`, one finding per question, so you can choose what to address now vs ignore/defer
7. only implement the findings you selected

This keeps the flow simple and visible in the main conversation instead of pushing work into extra sub-agent orchestration.

## Example workflow

```text
/discover Add a self-serve billing portal for teams
```

The agent should inspect the codebase, optionally pull in external docs or market context, ask structured questions, and eventually produce a final implementation-ready plan.

Then approve from the UI or start manually:

```text
/discover-implement
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
