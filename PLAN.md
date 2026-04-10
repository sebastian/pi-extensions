<!-- Generated automatically by guided-discovery on 2026-04-10T08:53:16.543Z -->

## Problem

Add a sub-agent implementation mode to the packaged guided-discovery extension in `.pi/extensions/guided-discovery/` so an approved `PLAN.md` can be executed with isolated contexts and a disciplined pipeline:

- break the plan into actionable, sequenced steps
- parallelize only when useful and safe
- review for security, regressions, UI consistency, performance, loose ends, dead code, and unnecessary complexity
- discover and honor relevant `CHECKS.md` files for changed areas
- automatically apply check findings, then re-check
- validate that the plan was actually implemented
- surface discrepancies with a smart recommendation, then ask the user whether to finish, reformulate, or accept them

Per your choice, this should be offered as a mode choice in the approval UI, not as a forced replacement of the current `/discover-implement` flow.

## What I learned

- This repo is intentionally small. The only shipped extension is `.pi/extensions/guided-discovery/`.
- Current guided discovery already does these parts well:
  - read-only discovery tooling
  - structured questionnaire
  - web research
  - final-plan detection
  - `PLAN.md` autosave
  - `/discover-implement`
- Today, `/discover-implement` is a thin handoff in `.pi/extensions/guided-discovery/index.ts`: it exits discovery mode and sends a normal user message back into the main session. There is no isolated implementation workflow yet.
- There are no repo-local `CHECKS.md` files right now, so the feature needs to be generic and tested with fixtures/synthetic cases.
- pi’s own docs/examples strongly support this direction:
  - `docs/extensions.md` shows the right primitives: commands, UI, tool gating, subprocess execution, state persistence
  - `examples/extensions/plan-mode/` is the closest pattern for phase switching
  - `examples/extensions/subagent/` shows how to spawn isolated `pi` subprocesses with separate prompts and stream results
- The pi philosophy explicitly treats subagents and plan mode as extension/package territory, so implementing this inside the package is the intended model.
- For clean context, an extension-owned orchestrator is a better fit than teaching the main agent to use a generic subagent tool. The latter still pollutes the main conversation with orchestration chatter.

## Decision log

- **Entrypoint:** keep `/discover-implement`, but when UI is available, offer a choice between direct implementation and sub-agent implementation.
- **Architecture:** implement sub-agent mode as an **extension-owned workflow**, not as “ask the main agent to orchestrate subagents”.
- **Isolation:** use spawned `pi` subprocesses with `--no-session`, package-owned prompts, and minimal enabled resources/tools.
- **Agent source:** bundle internal implementation prompts with this package; do not depend on user/global/project `.pi/agents`.
- **Parallelism:** default to sequential for mutating work; only parallelize write phases when steps are explicitly independent and file scopes do not overlap. Read-only checking can parallelize more aggressively.
- **CHECKS.md:** collect relevant files by walking from each changed file’s directory up to repo root; treat them as guidance, not blindly trusted shell scripts.
- **Checks loop:** findings should trigger an automatic fix pass and then a re-check pass.
- **Plan validation:** make this a dedicated final stage with structured discrepancy output and an explicit user decision.
- **Simplicity bias:** prefer a small fixed workflow over a generic multi-agent framework.

## Recommended approach

Build a second implementation path beside the current direct handoff.

### 1. Add a sub-agent implementation option to the existing approval flow

In `.pi/extensions/guided-discovery/index.ts`:

- expand the approval UI from:
  - approve and implement now
  - keep refining
  - leave with plan only
- to something like:
  - implement directly
  - implement with sub-agents
  - keep refining
  - leave with plan only

Also make `/discover-implement` show the same mode choice when UI is present. In non-UI mode, preserve today’s direct behavior unless the mode is explicitly requested.

### 2. Run implementation outside the main agent context

Instead of sending “Implement the plan…” back into the main session, the extension should orchestrate a fixed sub-agent pipeline itself.

That gives you:
- isolated context windows
- less main-session pollution
- predictable sequencing
- easier review/fix/recheck loops

### 3. Use a small set of internal agent roles

Bundle prompts for these roles inside the package:

- **decomposer**  
  Turns `PLAN.md` into structured actionable steps, dependencies, likely touched areas, and safe parallel groups.
- **worker**  
  Implements one phase/group.
- **checker**  
  Reviews changed code and runs/verifies applicable checks:
  - security
  - unintended breakage
  - UI consistency
  - performance degradation
  - dead code / loose ends
  - overscoping / unnecessary complexity
  - `CHECKS.md` guidance
- **validator**  
  Compares the final result to the approved plan and classifies discrepancies:
  - implemented
  - partially implemented
  - not implemented
  - superseded by new learning
  - should be reformulated

Use the **worker** again as the fixer for checker findings.

### 4. Use structured outputs for orchestration stages

For `decomposer`, `checker`, and `validator`, require strict JSON-only output so the extension can parse results reliably.

Examples:
- decomposer: phases, dependencies, candidate parallel groups, touched paths
- checker: findings, severity, suggested fixes, checks run, unresolved risks
- validator: plan-item coverage matrix, discrepancies, recommendation

That avoids brittle markdown parsing and keeps the workflow robust.

### 5. Add a bounded workflow loop

Recommended sub-agent pipeline:

1. load approved `PLAN.md`
2. run **decomposer**
3. execute worker phases
4. run checker stage
5. if findings exist, run fixer worker
6. re-run checker once
7. run validator
8. if validator reports material discrepancies, ask user:
   - implement remaining items
   - reformulate in discovery mode
   - accept and finish

Keep this bounded:
- one initial implementation pass
- one automatic fix/recheck pass
- user decision if material gaps remain

That is the simplest version that still honors your “results from the checks implemented” requirement.

### 6. Make CHECKS.md part of the checker stage

Implement a helper that:

- determines changed files after worker phases
- for each changed file, walks ancestors to repo root
- collects all `CHECKS.md`
- dedupes them
- passes them to the checker with file-to-check mapping

Important: if a `CHECKS.md` suggests shell commands, do **not** blindly execute arbitrary commands. Treat them as suggested checks and apply a safety policy:
- allow ordinary test/lint/build/verification commands
- block obviously destructive or deployment commands
- ask before running anything questionable

### 7. Keep the “zero slop” requirement explicit in prompts

The worker and checker prompts should both explicitly prefer:

- reusing existing abstractions over adding new ones
- deleting dead code when replacing behavior
- removing temporary helpers/flags left after refactors
- collapsing unnecessary indirection
- keeping naming and UI patterns consistent
- avoiding “just in case” code

This should be a core prompt rule, not an afterthought.

## Implementation plan

1. **Create a new jj change**
   - Start with `jj new` before editing.

2. **Refactor implementation entry logic**
   - Update `.pi/extensions/guided-discovery/index.ts`
   - separate:
     - direct implementation handoff
     - sub-agent implementation orchestration
   - update approval UI and `/discover-implement` behavior

3. **Add a subagent runner module**
   - New file, e.g. `.pi/extensions/guided-discovery/subagent-runner.ts`
   - Adapt the reliable parts of pi’s `examples/extensions/subagent/index.ts`:
     - spawn `pi`
     - `--mode json`
     - `--no-session`
     - temp prompt file handling
     - streamed event parsing
     - cleanup on abort
   - Prefer spawning with disabled extras like `--no-extensions --no-skills --no-prompt-templates` unless a specific need appears

4. **Add internal agent prompts**
   - New directory, e.g. `.pi/extensions/guided-discovery/agents/`
   - Add:
     - `decomposer.md`
     - `worker.md`
     - `checker.md`
     - `validator.md`
   - Keep them package-owned and focused on this workflow only

5. **Add orchestration module**
   - New file, e.g. `.pi/extensions/guided-discovery/implement-workflow.ts`
   - Responsibilities:
     - load `PLAN.md`
     - combine extra instructions
     - call decomposer
     - compute execution batches
     - run workers
     - run checker/fixer/recheck
     - run validator
     - return a compact final summary

6. **Add diff and change-scope helpers**
   - New file, e.g. `.pi/extensions/guided-discovery/changes.ts`
   - Detect changed files using:
     - prefer `jj diff --summary` when in a jj repo
     - fallback to `git diff --name-only --relative`
   - Add overlap detection for touched paths to decide whether a batch is safe to parallelize

7. **Add CHECKS.md discovery + safety filtering**
   - New file, e.g. `.pi/extensions/guided-discovery/checks.ts`
   - Implement:
     - ancestor walk
     - dedupe
     - path-to-check mapping
     - command safety filter for suggested checks

8. **Add structured parsing/validation helpers**
   - New file, e.g. `.pi/extensions/guided-discovery/structured-output.ts`
   - Parse and validate JSON from decomposer/checker/validator
   - retry once on malformed output, then fail clearly

9. **Add final discrepancy UX**
   - In `index.ts` or a small UI helper module
   - Present validator results and ask user whether to:
     - finish missing items now
     - go back into discovery to reformulate
     - accept the discrepancy set
   - If reformulate is chosen, send a compact discovery prompt rather than dumping full subagent transcripts

10. **Update package metadata**
    - Update `.pi/extensions/guided-discovery/package.json`
    - Include new files/directories in `files`
    - bump version
    - update description if needed

11. **Update docs**
    - Update `.pi/extensions/guided-discovery/README.md`
    - document:
      - direct vs sub-agent implementation choice
      - sub-agent workflow stages
      - CHECKS.md behavior
      - discrepancy handling
      - limits on parallel writes

12. **Add lightweight tests for pure helpers**
    - Focus on:
      - changed-file parsing
      - CHECKS.md ancestor discovery
      - path-overlap safety decisions
      - structured output parsing
      - final-plan / plan-item extraction helpers if touched
    - If TS test execution is awkward in this repo, keep tests minimal and JS-based rather than introducing heavy tooling

13. **Manual smoke-test the workflow**
    - Discovery → save `PLAN.md`
    - approval UI offers both implementation modes
    - sub-agent mode runs end-to-end
    - checker loop can trigger and fix findings
    - validator can surface a discrepancy and ask for next action

## Acceptance criteria

- `PLAN.md` approval UI offers a sub-agent implementation option alongside the direct path.
- `/discover-implement` can invoke that same choice when UI is available.
- Choosing sub-agent mode does **not** rely on the main agent to orchestrate the workflow.
- The sub-agent workflow:
  - decomposes the plan into actionable steps
  - sequences them
  - parallelizes only safe batches
- Worker batches do not run in parallel when file scopes overlap or safety is uncertain.
- Checker stage explicitly evaluates:
  - security
  - unintended breakage
  - UI consistency
  - performance regression risk
  - dead code / loose ends
  - simplification / superfluous code
- Relevant `CHECKS.md` files are discovered from changed-file ancestor paths and incorporated into the checker stage.
- Check findings trigger an automatic fix pass and a re-check pass.
- Final validator reports plan coverage and discrepancies in a structured way.
- If material discrepancies remain, the user is asked whether to:
  - finish them
  - reformulate them
  - accept them
- README and package metadata are updated to reflect the new mode.
- Existing direct implementation flow still works.

## Risks / follow-ups

- **Biggest implementation risk:** subprocess orchestration and structured-output parsing. Keep the first version narrow and deterministic.
- **Parallel write safety:** true concurrent file mutation across separate `pi` processes is risky. Default to sequential unless independence is explicit.
- **CHECKS.md trust model:** repo-controlled check docs may contain unsafe commands. Safety filtering and approval for questionable commands is important.
- **Non-UI behavior:** approval-choice UX is interactive. In print/JSON mode, require an explicit mode or fall back to the current direct path.
- **Model variability:** structured JSON prompts should include a retry/fail-fast path.
- **No current fixture coverage for CHECKS.md:** you’ll likely want a small synthetic test fixture repo or temp-dir tests.
- **Future split opportunity:** if this grows beyond guided-discovery, the subagent runner/orchestrator could be extracted into a shared pi package later.
