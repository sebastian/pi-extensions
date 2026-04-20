# Guided Discovery Extension

A research-first planning workflow for pi that turns a loose feature prompt into a concise implementation plan, then lets you either hand off directly or run a bounded isolated sub-agent build.

## Features

- read-only discovery mode with `read`, `bash`, `grep`, `find`, `ls`, `questionnaire`, and `web_research`
- discovery starts in its own isolated jj workspace (or git worktree fallback), and relative repo reads plus read-only bash commands are routed there automatically
- structured multiple-choice clarifying questions with a recommended option shown first and an `Other` fallback
- external docs / API / market / state-of-the-art research via `web_research`
- concise final-plan detection and automatic save of the latest plan to the isolated workspace `PLAN.md`
- approval UI with two implementation paths:
  - direct handoff to the main session
  - isolated sub-agent implementation workflow in either `fast` or `strict` mode
- standalone `/implement-subagents [prompt]` and `/implement-subagents-strict [prompt]` entrypoints for ad hoc sub-agent implementation outside discovery
- raw-prompt sub-agent runs synthesize a lightweight ephemeral plan instead of requiring a repo-root `PLAN.md`
- bundled sub-agent roles for decomposition, general implementation, design-specialist implementation, cleanup auditing, design review, final code review, and plan validation
- simplified sub-agent progress UI in interactive sessions: a persistent widget above the editor showing workflow stages, worker batches, active phases, targeted follow-through activity, final review reruns, and only the branches that are actually in use
- clearer workspace-status surfacing in the widget and footer, including the isolated discovery workspace path and any resumable stopped sub-agent workspace
- single-pass advisory validator output instead of an open-ended endgame remediation loop
- touched-path `AGENTS.md` discovery so worker, remediation, cleanup, design review, checker, and validator passes see the right repo-local guidance for touched files
- conservative execution of explicit `AGENTS.md` check commands as part of the checker / final quality path
- multi-model checking with `gpt-5.4` plus at most one companion checker model: prefer `gpt-5.3-codex`, else `GLM-5.1` (including the dedicated `zai-coding-plan/glm-5.1` provider)
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
- `/discover-implement-strict [extra instructions]` — start the strict sub-agent workflow from the approved plan
- `/implement-subagents [prompt]` — run the fast sub-agent workflow directly from the approved plan, or from a raw prompt that gets a lightweight synthesized plan
  - examples:
    - `/implement-subagents`
    - `/implement-subagents Add a standalone /sync command and keep the UI minimal.`
- `/implement-subagents-strict [prompt]` — run the strict sub-agent workflow directly from the approved plan, or from a raw prompt
- `/implement-subagents-resume [extra instructions]` — resume the latest stopped sub-agent workflow from its preserved isolated workspace
- `/discover-implement-resume [extra instructions]` — same as above, but convenient from discovery mode
- `Ctrl+Alt+D` — toggle discovery mode

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
  - ask the user to choose materially different viable paths via `questionnaire`, with the recommended option first
  - ask only the highest-leverage questions
  - keep planning concise and implementation-oriented
  - produce a final plan that reflects only the agreed path, not the rejected alternatives
  - produce a final plan with problem, key findings, the agreed trade-off rationale, approach, build plan, acceptance checks, and risks

When the assistant produces a final plan, the extension:

1. auto-saves it to the isolated workspace `PLAN.md`
2. appends a `## Sources consulted` section when external sources were used
3. shows an approval UI with options to:
   - resume a previously stopped sub-agent run when one exists
   - implement directly
   - implement with sub-agents (fast)
   - implement with sub-agents (strict)
   - keep refining in discovery mode
   - leave discovery mode with the saved plan only

## Sub-agent implementation mode

Sub-agent mode keeps orchestration out of the main conversation and runs in isolated `pi` subprocesses.

Discovery already prepared an isolated workspace and stored the approved `PLAN.md` there. When you start implementation from discovery, the workflow reads that approved plan from the isolated workspace and then runs implementation in a fresh isolated build workspace. If the run finishes successfully, the discovery workspace is cleaned up so the planning `PLAN.md` does not linger afterward.

There are now two sub-agent workflows:

1. **fast** — the default. Uses one whole-plan worker, runs early `AGENTS.md`-required checks before the final review loop, keeps the final checker bounded, and runs the validator once at the end.
2. **strict** — the previous heavier workflow. Keeps decomposition, targeted follow-through, holistic cleanup/design review, the bounded final checker loop, and the final advisory validator.

In interactive TUI sessions, it also renders a persistent progress widget above the editor. The widget keeps the workflow spine visible, expands worker batches after decomposition, highlights the current active phase, and hides unused branches like fix unless they are actually touched. In RPC or non-interactive flows, the extension falls back to concise text progress instead.

### Stages

#### Fast mode

1. **single worker / design worker** — implements the approved plan as one coherent change in the isolated workspace. Workers now also get `bash` so they can do focused repo inspection and verification inside the isolated workspace.
2. **early required checks** — explicit `AGENTS.md` checks run immediately after the first implementation pass so obvious objective failures surface before the final review loop.
3. **optional focused remediation** — if those early required checks fail, the workflow does one focused remediation pass before moving on.
4. **final code review loop** — the only looping end-stage reviewer, bounded, focused on logic, regressions, side effects, security, and guidance.
5. **validator** — compares the actual result against the approved plan once and reports remaining discrepancies as advisory follow-up instead of triggering another endgame implementation loop.

#### Strict mode

1. **decomposer** — breaks `PLAN.md` into a very small set of actionable phases with conservative parallel-safety hints and a `designSensitive` flag for UI, interaction, discoverability, navigation, copy, and ambiguous product-behavior work.
2. **worker / design worker** — implements phases, usually sequentially, only parallelizing batches when touched paths do not overlap and safety is explicit. Parallel phases run in separate child workspaces and are then integrated back into the parent workspace. Design-sensitive phases use the dedicated design worker instead of the generic worker.
3. **targeted phase follow-through** — after each phase, run targeted cleanup on that phase’s changed files and touched paths. If the phase is design-sensitive or visibly user-facing, also run targeted design review. This loop is small, local, and bounded.
4. **final cleanup auditor** — after the implementation is merged, run one holistic cleanup pass for glaring feature-level cleanup mistakes only.
5. **final design reviewer** — after the implementation is merged, run one holistic design pass when the feature is design-sensitive or visibly user-facing.
6. **final code review** — runs review passes with the primary checker model plus at most one companion model (`gpt-5.3-codex`, else `GLM-5.1`, including `zai-coding-plan/glm-5.1` when available), executes explicit required checks extracted conservatively from relevant `AGENTS.md` files, and focuses on:
   - logic bugs and correctness
   - unintended regressions or side effects
   - security issues
   - performance regression risk when materially relevant
   - relevant `AGENTS.md` guidance for touched areas
7. **review remediation loop** — if the final code review returns findings, the workflow applies fixes automatically and reruns only the final code review. After 2 review passes, remaining non-critical findings are non-blocking. If hard blockers still remain at that bound, interactive sessions prompt you to either continue remediating anyway or stop gracefully with a summary of what was completed and what remains; non-interactive runs stop with that summary instead of hard-failing.
8. **resume path** — when a bounded run stops with hard blockers, the isolated implementation workspace is preserved so you can continue later with `/implement-subagents-resume` instead of restarting from scratch.
9. **validator** — compares the actual result against the approved plan once and reports remaining discrepancies as advisory follow-up instead of triggering another endgame implementation loop.

If the validator finds material discrepancies, the extension reports them clearly in the final summary and, by design, does not keep looping.

### Reports and summaries

- the cleanup auditor, design reviewer, and checker all return the existing `CheckerReport` JSON shape instead of introducing separate report types
- that shared structure means parsing, severity/category handling, finding summaries, and fix-context rendering are reused across all three quality gates
- the final workflow summary reports changed files, how many cleanup audits ran, how many design reviews ran vs were skipped, how many quality remediation passes were needed, how many cleanup/design/checker findings were fixed, whether any residual soft findings were accepted, whether any blocking hard issues remain, how many merged-result verification passes ran, whether legacy code/files were removed, final review totals, and the validator recommendation
- when the bounded final checker still has hard blockers, the workflow now returns a graceful stop summary instead of surfacing a raw workflow failure; that summary explicitly says what completed in the isolated workspace, what remains, and whether the isolated result was applied
- remaining validator discrepancies stay visible under the remaining-discrepancies section instead of being silently dropped or auto-looped away
- cleanup reporting is concrete: it focuses on actionable cleanup appropriate to finish now, and the summary calls out when legacy or superseded code/files were actually removed

## `AGENTS.md` guidance behavior

For every changed file or touched path, the sub-agent workflow walks ancestor directories up to repo root and collects relevant `AGENTS.md` files.

Those instructions are passed into worker, remediation, cleanup, design review, checker, and validator passes so implementation and review stay aligned with repo-local coding guidance and explicit checks, even when the touched files are outside the original working-directory ancestor chain.

When those `AGENTS.md` files contain explicit check commands in recognizable validation/check sections (for example `Run: npm test` or fenced command blocks under a Checks heading), the workflow executes them in the isolated workspace and treats failures or blocked required checks as hard remediation-triggering findings instead of advisory notes.

Free-form repository workflow instructions that require higher-level orchestration steps (for example `jj new`, `jj describe`, `jj commit`, or `jj push`) are still guidance for the caller/orchestrator around the workflow; this extension currently enforces explicit runnable checks, not every prose workflow rule in `AGENTS.md`.

## Direct vs sub-agent mode

### Direct mode

- exits discovery mode
- sends an implementation prompt back into the main session
- if the approved plan lives in the isolated discovery workspace, the prompt inlines that plan so the discovery workspace can be cleaned up immediately instead of leaving a stray `PLAN.md` behind

### Sub-agent mode

- works from either the approved discovery-workspace `PLAN.md` or a raw prompt passed to `/implement-subagents`
- defaults to **fast** mode; **strict** mode is opt-in
- synthesizes a lightweight ephemeral plan for raw-prompt runs
- runs implementation in an isolated jj workspace or git worktree with bundled prompts
- keeps orchestration chatter out of the main session
- lets workers use `bash` inside the isolated workspace for focused inspection and verification
- runs `AGENTS.md`-required checks early in fast mode and still enforces them during final review
- keeps final checker remediation bounded and graceful when blockers still remain
- preserves stopped isolated implementation workspaces so you can continue with `/implement-subagents-resume`
- runs the validator once at the end as an advisory plan-coverage check
- cleans up the discovery-workspace `PLAN.md` after a successful implementation run so planning artifacts do not linger in the source checkout

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

Or opt into the heavier strict workflow:

```text
/discover-implement-strict Start with the smallest safe slice.
```

If a bounded sub-agent run stops, continue later from the preserved isolated workspace:

```text
/implement-subagents-resume Focus only on the remaining blockers.
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
