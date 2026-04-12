# Guided Discovery Extension

A research-first planning workflow for pi that turns a loose feature prompt into a concise implementation plan, then lets you either hand off directly or run a bounded isolated sub-agent build.

## Features

- read-only discovery mode with `read`, `bash`, `grep`, `find`, `ls`, `questionnaire`, and `web_research`
- structured multiple-choice clarifying questions with an `Other` fallback
- external docs / API / market / state-of-the-art research via `web_research`
- concise final-plan detection and automatic save of the latest plan to `PLAN.md`
- approval UI with two implementation paths:
  - direct handoff to the main session
  - isolated sub-agent implementation workflow
- standalone `/implement-subagents [prompt]` entrypoint for ad hoc sub-agent implementation outside discovery
- raw-prompt sub-agent runs synthesize a lightweight ephemeral plan instead of requiring a repo-root `PLAN.md`
- bundled sub-agent roles for decomposition, general implementation, design-specialist implementation, cleanup auditing, design review, final code review, and plan validation
- simplified sub-agent progress UI in interactive sessions: a persistent widget above the editor showing workflow stages, worker batches, active phases, targeted follow-through activity, final review reruns, and only the branches that are actually in use
- single-pass advisory validator output instead of an open-ended endgame remediation loop
- touched-path `AGENTS.md` discovery so worker, remediation, cleanup, design review, checker, and validator passes see the right repo-local guidance for touched files
- conservative execution of explicit `AGENTS.md` check commands as part of the checker / final quality path
- multi-model checking with `gpt-5.4` plus at most one companion checker model: prefer `gpt-5.3-codex`, else `GLM-5.1`
- checker-model failures are recorded as errored reviews without aborting the whole workflow, as long as at least one checker succeeds
- packaged as a reusable pi package, not just a project-local extension

## Commands

- `/discover [goal]` — enable guided discovery mode, and optionally kick it off with a loose prompt
- `/discover-off` — leave discovery mode and restore normal tools
- `/discover-implement [mode] [extra instructions]` — start implementation from the approved plan
  - examples:
    - `/discover-implement`
    - `/discover-implement direct Start with tests.`
    - `/discover-implement subagents Keep changes minimal.`
- `/implement-subagents [prompt]` — run sub-agents directly from the current `PLAN.md`, or from a raw prompt that gets a lightweight synthesized plan
  - examples:
    - `/implement-subagents`
    - `/implement-subagents Add a standalone /sync command and keep the UI minimal.`
- `Ctrl+Alt+D` — toggle discovery mode

## How discovery mode behaves

While guided discovery mode is active:

- active tools are restricted to `read`, `bash`, `grep`, `find`, `ls`, `questionnaire`, and `web_research`
- `bash` is limited to a read-only allowlist
- the model is pushed to:
  - do a fast repo scan first
  - proactively research external products, APIs, ecosystems, and market patterns when they materially affect the decision
  - prefer first-party sources for vendor / API details
  - surface the real product / UX / technical trade-offs and recommend a default
  - ask only the highest-leverage questions
  - keep planning concise and implementation-oriented
  - produce a final plan with problem, key findings, trade-offs, approach, build plan, acceptance checks, and risks

When the assistant produces a final plan, the extension:

1. auto-saves it to `PLAN.md`
2. appends a `## Sources consulted` section when external sources were used
3. shows an approval UI with options to:
   - implement directly
   - implement with sub-agents
   - keep refining in discovery mode
   - leave discovery mode with the saved plan only

## Sub-agent implementation mode

Sub-agent mode keeps orchestration out of the main conversation and runs a fixed workflow in isolated `pi` subprocesses. The whole run happens in a temporary jj workspace (or git worktree fallback), and parallel-safe worker batches get their own child workspaces before their results are integrated back into the parent workspace. Design-sensitive work is routed to a dedicated design specialist worker.

The workflow is intentionally bounded:

1. **phase-local follow-through** — after each implementation phase, run targeted cleanup and, when needed, targeted design review inside that phase’s scope
2. **final holistic review** — one final cleanup pass and one conditional design pass for glaring feature-level issues only
3. **final code review loop** — the only looping end-stage reviewer, bounded to 2 passes, focused on logic, regressions, side effects, security, and guidance
4. **single advisory validator pass** — compare the final result to the approved plan once, report any remaining gaps, and stop there

In interactive TUI sessions, it also renders a persistent progress widget above the editor. The widget keeps the workflow spine visible, expands worker batches after decomposition, highlights the current active phase, and hides unused branches like fix unless they are actually touched. In RPC or non-interactive flows, the extension falls back to concise text progress instead.

### Stages

1. **decomposer** — breaks `PLAN.md` into a very small set of actionable phases with conservative parallel-safety hints and a `designSensitive` flag for UI, interaction, discoverability, navigation, copy, and ambiguous product-behavior work
2. **worker / design worker** — implements phases, usually sequentially, only parallelizing batches when touched paths do not overlap and safety is explicit. Parallel phases run in separate child workspaces and are then integrated back into the parent workspace. Design-sensitive phases use the dedicated design worker instead of the generic worker.
3. **targeted phase follow-through** — after each phase, run targeted cleanup on that phase’s changed files and touched paths. If the phase is design-sensitive or visibly user-facing, also run targeted design review. This loop is small, local, and bounded.
4. **final cleanup auditor** — after the implementation is merged, run one holistic cleanup pass for glaring feature-level cleanup mistakes only.
5. **final design reviewer** — after the implementation is merged, run one holistic design pass when the feature is design-sensitive or visibly user-facing.
6. **final code review** — runs review passes with the primary checker model plus at most one companion model (`gpt-5.3-codex`, else `GLM-5.1`), executes explicit required checks extracted conservatively from relevant `AGENTS.md` files, and focuses on:
   - logic bugs and correctness
   - unintended regressions or side effects
   - security issues
   - performance regression risk when materially relevant
   - relevant `AGENTS.md` guidance for touched areas
7. **review remediation loop** — if the final code review returns findings, the workflow applies fixes automatically and reruns only the final code review. After 2 review passes, remaining non-critical findings are non-blocking.
8. **validator** — compares the actual result against the approved plan once and reports remaining discrepancies as advisory follow-up instead of triggering another endgame implementation loop

If the validator finds material discrepancies, the extension reports them clearly in the final summary and, by design, does not keep looping.

### Reports and summaries

- the cleanup auditor, design reviewer, and checker all return the existing `CheckerReport` JSON shape instead of introducing separate report types
- that shared structure means parsing, severity/category handling, finding summaries, and fix-context rendering are reused across all three quality gates
- the final workflow summary reports changed files, how many cleanup audits ran, how many design reviews ran vs were skipped, how many quality remediation passes were needed, how many cleanup/design/checker findings were fixed, whether any residual soft findings were accepted, whether any blocking hard issues remain, how many merged-result verification passes ran, whether legacy code/files were removed, final review totals, and the validator recommendation
- remaining validator discrepancies stay visible under the remaining-discrepancies section instead of being silently dropped or auto-looped away
- cleanup reporting is concrete: it focuses on actionable cleanup appropriate to finish now, and the summary calls out when legacy or superseded code/files were actually removed

## `AGENTS.md` guidance behavior

For every changed file or touched path, the sub-agent workflow walks ancestor directories up to repo root and collects relevant `AGENTS.md` files.

Those instructions are passed into worker, remediation, cleanup, design review, checker, and validator passes so implementation and review stay aligned with repo-local coding guidance and explicit checks, even when the touched files are outside the original working-directory ancestor chain.

When those `AGENTS.md` files contain explicit check commands in recognizable validation/check sections (for example `Run: npm test` or fenced command blocks under a Checks heading), the workflow executes them in the isolated workspace and treats failures or blocked required checks as hard remediation-triggering findings instead of advisory notes.

Free-form repository workflow instructions that require higher-level orchestration steps (for example `jj new`, `jj describe`, `jj commit`, or `jj push`) are still guidance for the caller/orchestrator around the workflow; this extension currently enforces explicit runnable checks, not every prose workflow rule in `AGENTS.md`.

## Direct vs sub-agent mode

### Direct mode

- preserves today’s lightweight handoff behavior
- remains unchanged by the new design-review and cleanup behavior
- exits discovery mode
- sends an implementation prompt back into the main session

### Sub-agent mode

- works from either a saved `PLAN.md` or a raw prompt passed to `/implement-subagents`
- synthesizes a lightweight ephemeral plan for raw-prompt runs
- runs implementation in an isolated jj workspace or git worktree with bundled prompts
- keeps orchestration chatter out of the main session
- prefers `openai-codex/gpt-5.4` for decomposition, implementation, and validation when available
- routes design-sensitive implementation and remediation work to the dedicated design worker when needed
- runs targeted per-phase cleanup after every implementation phase and targeted design review only for design-sensitive/user-visible work
- runs one final holistic cleanup pass and one final holistic design pass for glaring feature-level issues only
- runs the final code review with the primary model plus at most one companion (`gpt-5.3-codex`, else `GLM-5.1`)
- makes final code review the only looping end-stage reviewer, capped at 2 passes
- treats severe design/accessibility/discoverability issues, security/correctness regressions, AGENTS-required check failures, and process violations as blocking problems, while letting non-critical residual findings stop blocking after the second review pass
- runs the validator once at the end as an advisory plan-coverage check
- does not auto-integrate isolated-workspace output back into the original checkout when the workflow hands back to discovery reformulation

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
