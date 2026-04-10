<!-- Generated automatically by guided-discovery on 2026-04-11T20:38:40.762Z -->

## Problem

Extend the guided-discovery sub-agent implementation workflow so that it is more generally usable, more isolated, more compliant with `AGENTS.md`, and less likely to fail unnecessarily at the quality-suite endgame.

Requested changes:

- make “implement with subagents” usable outside guided discovery too
- fix the discrepancy/finish-pass path that currently appears to do nothing in some cases
- ensure worker agents follow `AGENTS.md` rules and checks
- run all work in temporary workspaces
- isolate parallel sub-agent work in separate workspaces too
- mitigate repeated end-of-run failure from the quality suite exhausting 3 rounds, especially design review as a hard gate

## What I learned

- Sub-agent orchestration lives mainly in:
  - `.pi/extensions/guided-discovery/index.ts`
  - `.pi/extensions/guided-discovery/implement-workflow.ts`

- Today, sub-agent mode is only practically available through discovery:
  - `/discover-implement`
  - and `subagents` currently requires `PLAN.md`

- The workflow already has:
  - decomposition
  - workers
  - cleanup auditor
  - design reviewer
  - checker
  - validator

- The validator schema is already richer than the workflow currently uses:
  - `.pi/extensions/guided-discovery/structured-output.ts`
  - `.pi/extensions/guided-discovery/agents/validator.md`

- The current discrepancy handling is not a real loop.
  - It supports at most one finish pass.
  - After that, the code explicitly disallows another finish pass.
  - That likely explains the “continue and do discrepancies now” dead-end behavior.

- `AGENTS.md` guidance is discovered correctly for review stages, but not consistently passed to worker/editing stages based on touched paths.

- Parallel worker phases are concurrent, but not isolated.
  - They currently share the same working directory.
  - So they can still interfere.

- The current quality-suite policy is too rigid:
  - `QUALITY_SUITE_MAX_ROUNDS = 3`
  - `decideQualitySuiteRound()` treats remaining findings after the retry bound as a hard failure
  - design review is always treated as a hard gate
- That matches the failure you showed:
  - cleanup/design/checker findings remain
  - design findings force terminal failure
  - the run does not degrade gracefully

- Relevant external docs support the workspace approach:
  - jj supports multiple workspaces and stale-workspace recovery (`jj workspace add`, `jj workspace forget`, `jj workspace update-stale`)
  - git officially supports linked worktrees for isolated parallel work

- Your preference for outside-discovery entry is now clear:
  - support both approaches
  - prefer a new raw-prompt command
  - generate a lightweight ephemeral plan automatically for raw prompts

## Decision log

- **Add a standalone sub-agent command outside discovery.**
  - Recommended new command: `/implement-subagents [prompt]`
  - Keep `/discover-implement subagents` for discovery-driven runs.

- **For raw prompts, synthesize a lightweight temporary plan.**
  - This preserves the existing decomposition/validation pipeline.

- **Run all sub-agent work inside temporary workspaces.**
  - jj repo → jj workspace
  - git repo → git worktree

- **Use child workspaces for parallel-safe phases.**
  - This prevents sub-agents from stepping on each other.

- **Fix validator remediation by replacing the one-shot finish-pass tail with a real loop.**
  - Keep offering:
    - continue implementing discrepancies
    - reformulate
    - accept and finish

- **Pass relevant touched-path `AGENTS.md` files to all worker-like agents, not just reviewers.**
  - That includes:
    - implementation workers
    - remediation workers
    - finish-pass workers

- **Execute concrete `AGENTS.md` checks as part of validation, not just as advisory text.**

- **Relax the quality-suite endgame from an always-hard gate to a graded gate.**
  - This is the main amendment.
  - Recommendation:
    - keep truly risky findings as hard gates
    - treat lower-severity cleanup/polish/design issues as soft-gated after bounded retries
    - if the workflow is not converging, prompt instead of just failing

- **Do not make design review fully soft by default.**
  - Better policy:
    - hard gate for severe design/accessibility/usability regressions
    - soft gate for residual low/medium polish findings after repeated attempts
  - This reduces unnecessary failures without silently shipping obviously bad results.

## Recommended approach

### 1. Add `/implement-subagents` for use outside discovery

In `.pi/extensions/guided-discovery/index.ts`:

- add a new standalone command:
  - `/implement-subagents [prompt]`
- support:
  - raw prompt → synthesize lightweight temp plan
  - no prompt + `PLAN.md` exists → use `PLAN.md`

This keeps discovery optional, not mandatory.

### 2. Create an ephemeral lightweight plan for raw prompts

Add a small planner stage before decomposition when starting from a raw implementation prompt.

Use a concise bundled prompt that produces:
- scope
- constraints
- acceptance criteria
- implementation outline

Store it in temp workspace context rather than forcing a repo-root `PLAN.md`.

### 3. Introduce workspace orchestration

Add a helper module, e.g.:
- `.pi/extensions/guided-discovery/workspaces.ts`

It should manage:

- repo-type detection
- top-level temp workspace creation
- child workspace creation for parallel phases
- integration back into parent/original repo
- conflict handling
- cleanup/forget/remove at the end

#### jj
Use official jj workspace operations:
- create temp workspace
- do all work there
- integrate result back into the original intended line of history
- handle stale workspaces/conflicts
- forget workspace afterward

#### git
Use official git worktrees:
- create temp worktree on temp branch
- work there
- merge/cherry-pick back into original branch
- resolve conflicts if needed
- remove worktree afterward

### 4. Isolate parallel implementation in child workspaces

Keep `computeExecutionBatches()` from `.pi/extensions/guided-discovery/changes.ts`, but change execution semantics:

- sequential batches still use one parent workspace
- parallel-safe phases each get their own child workspace
- each child result is integrated back into the parent workspace
- integration conflicts are resolved explicitly

### 5. Upgrade AGENTS handling for workers and final verification

#### Worker context
Before each worker/remediation/finish pass:
- collect relevant touched-path `AGENTS.md` files
- pass them as explicit context files

#### Executable checks
Add helper logic to conservatively extract runnable checks from relevant `AGENTS.md` docs.

Then:
- run those checks inside the active workspace
- collect pass/fail results
- feed failures into remediation
- rerun them at the end

### 6. Replace the one-shot discrepancy finish pass with a true loop

Refactor the validator tail in `.pi/extensions/guided-discovery/implement-workflow.ts` into:

1. validate
2. if discrepancies remain:
   - continue implementing now
   - reformulate
   - accept and finish
3. if continue:
   - run finish pass
   - rerun quality suite + AGENTS checks
   - rerun validator
   - repeat

This fixes the current bug-prone endgame.

### 7. Mitigate repeated quality-suite exhaustion with a graded gate

This is the amendment for the failure mode you showed.

#### Current problem
Today, after 3 rounds:
- any remaining findings can fail the whole run
- design findings force terminal failure
- the workflow has no graceful “good enough but not perfect” path

#### Recommended graded-gate policy

##### Hard gate findings
These should still block completion:
- failed `AGENTS.md` required checks
- security findings
- regression/correctness findings
- guidance/process violations
- high-severity design/accessibility/discoverability issues
- unresolved merge conflicts

##### Soft gate findings
These can become acceptably non-blocking after retries:
- low/medium cleanup findings
- low/medium complexity findings
- low/medium design polish findings
- stale docs/copy/polish issues that do not violate acceptance criteria materially

#### Convergence-aware retry policy
Instead of always stopping at exactly 3 rounds:

- keep a base retry budget
- if findings are decreasing materially, allow a small number of extra rounds
- if findings stagnate or churn without improving, stop looping and prompt the user instead of hard-failing

Suggested policy:
- base rounds: 3
- up to 2 extra rounds if clear progress is happening
- if 2 consecutive rounds show no material improvement, stop remediation escalation

#### Endgame prompt on non-convergence
In interactive mode, when only soft-gate findings remain after retries, prompt:

- accept remaining soft findings and finish
- continue remediation anyway
- reformulate in discovery mode

If hard-gate findings remain, still fail clearly.

This keeps quality meaningful while avoiding repeated needless failure.

#### Final summary should distinguish:
- hard-gate issues: blocking
- soft-gate issues: accepted residual findings
- checks that passed
- checks that failed then were fixed
- checks still outstanding

### 8. Rerun checks after conflict resolution or integration

If any workspace integration required conflict resolution:
- rerun `AGENTS.md` checks
- rerun cleanup/design/checker
- rerun validator

That ensures the merged result, not just child workspaces, is actually good.

## Implementation plan

1. **Add standalone sub-agent entry**
   - Update `.pi/extensions/guided-discovery/index.ts`
   - Add `/implement-subagents [prompt]`
   - Support raw prompt and `PLAN.md` modes

2. **Add lightweight temp-plan synthesis**
   - Add a bundled planner prompt, e.g.:
     - `.pi/extensions/guided-discovery/agents/implementation-planner.md`
   - Extend workflow options to accept either:
     - `planPath`
     - or raw prompt → synthesized plan file

3. **Add workspace abstraction**
   - Create:
     - `.pi/extensions/guided-discovery/workspaces.ts`
   - Implement:
     - repo detection
     - top-level workspace lifecycle
     - child workspace lifecycle
     - integration and cleanup
     - conflict detection hooks

4. **Run the whole workflow inside the temp workspace**
   - Refactor `runGuidedDiscoveryImplementationWorkflow()` to operate on workspace cwd
   - Ensure changed-file detection and all subagents use workspace paths

5. **Isolate parallel-safe phases in child workspaces**
   - Replace same-cwd parallel execution with per-phase workspaces
   - Integrate child results back into the parent workspace safely

6. **Pass relevant `AGENTS.md` files to workers**
   - Extend worker/fix/finish code paths to use touched-path guidance discovery
   - Reuse `.pi/extensions/guided-discovery/guidance.ts`

7. **Add `AGENTS.md` check extraction and execution**
   - Create helper, e.g.:
     - `.pi/extensions/guided-discovery/agents-checks.ts`
   - Parse explicit check commands conservatively
   - Execute them in workspace cwd
   - Convert failures into remediation inputs and summary results

8. **Refactor validator discrepancy handling into a loop**
   - Update `.pi/extensions/guided-discovery/implement-workflow.ts`
   - Support repeated continue/remediate/revalidate cycles
   - Add regression tests for the current dead-end behavior

9. **Refactor quality-suite convergence policy**
   - Replace current always-hard failure in `decideQualitySuiteRound()`
   - Add severity-aware and stage-aware gating:
     - hard-gate vs soft-gate findings
   - Add convergence tracking:
     - progress detection
     - stagnation detection
     - optional extra rounds when improving
   - Add interactive prompt when only soft findings remain after retries

10. **Handle integration conflicts and reruns**
    - On conflict:
      - resolve
      - rerun checks/quality suite/validator
    - Ensure final merged result is verified

11. **Update docs and tests**
    - Update `.pi/extensions/guided-discovery/README.md`
    - Extend tests in:
      - `.pi/extensions/guided-discovery/tests/implement-workflow.test.ts`
      - `.pi/extensions/guided-discovery/tests/guidance.test.ts`
      - `.pi/extensions/guided-discovery/tests/changes.test.ts`
      - plus new tests for workspace/check helpers
    - Add tests for:
      - standalone sub-agent command
      - workspace selection
      - child-workspace parallel isolation
      - AGENTS-check parsing/execution
      - discrepancy loop
      - graded quality-gate behavior
      - soft-gate prompt when only polish findings remain
      - hard-gate failure for severe findings

## Acceptance criteria

- A new standalone sub-agent command works outside guided discovery.
- Raw prompts can be implemented via sub-agents using a lightweight synthesized plan.
- Existing discovery-driven sub-agent flow still works.
- All implementation work happens in temporary workspaces.
- jj repos use jj workspaces; git repos use git worktrees.
- Parallel-safe phases run in isolated child workspaces.
- Child workspace results are integrated back without collisions.
- If integration conflicts occur, they are resolved and validations rerun.
- Worker/remediation/finish subagents receive relevant touched-path `AGENTS.md` guidance.
- Concrete checks from relevant `AGENTS.md` files are executed before finishing.
- Failed AGENTS-required checks trigger remediation.
- Selecting discrepancy continuation actually performs another remediation cycle.
- The validator/discrepancy flow can repeat until resolved, accepted, or reformulated.
- The quality suite no longer fails unnecessarily just because low/medium residual findings remain after 3 rounds.
- Severe findings still block completion.
- When only soft findings remain after retries in interactive mode, the user is prompted instead of the run hard-failing.
- Final summaries clearly distinguish:
  - fixed issues
  - accepted residual soft issues
  - blocking hard issues
  - check results
- Temporary workspaces are cleaned up afterward.

## Risks / follow-ups

- **Softening the gate too much could hide real quality problems**
  - Mitigation: keep security, regression, guidance, AGENTS-check failures, conflict issues, and high-severity design problems as hard gates.

- **Design severity from model output may be noisy**
  - Mitigation: severity-aware policy should be conservative, and repeated non-converging low/medium design findings should prompt the user rather than silently pass.

- **AGENTS check extraction may miss free-form instructions**
  - Mitigation: conservative parser first; later, optionally define a more explicit convention for machine-runnable checks.

- **Workspace integration is still the most complex part**
  - Mitigation: isolate repo-specific logic behind one abstraction module and test it carefully.

- **Parallel workspaces improve isolation but not free mergeability**
  - Integration still needs careful conflict handling.
  - That is acceptable; safety matters more than maximum concurrency.

- **No more research is needed before implementation**
  - The repo structure, existing workflow code, pi docs, jj workspace docs, and git worktree docs are sufficient to start coding.

## Sources consulted

- [Jujutsu docs - docs.jj-vcs.dev](https://docs.jj-vcs.dev/latest/) — query: Jujutsu jj workspace official docs add workspace command • Documentation for the latest released version of jj . Documentation for the unreleased version of jj . This version of the docs corresponds to the main branch of the jj repo. Some…
- [Demystifying Jujutsu (jj) Workspaces - Joshua Lyman.com](https://www.joshualyman.com/2026/02/demystifying-jujutsu-jj-workspaces/) — query: Jujutsu jj workspace official docs add workspace command • With one command you spin up a copy of the entire Google monorepo in a new CitC client, which gives you complete filesystem isolation, and merge in any changes from HEAD super eas…
- [jj-workspace-add (1) — Arch manual pages](https://man.archlinux.org/man/extra/jujutsu/jj-workspace-add.1.en) — query: Jujutsu jj workspace official docs add workspace command • By default, Jujutsu snapshots the working copy at the beginning of every command . The working copy is also updated at the end of the command , if the command modified the working…
- [GitHub - jj-vcs/jj: A Git-compatible VCS that is both simple and ...](https://github.com/jj-vcs/jj) — query: site:docs.jj-vcs.dev jj rebase official docs revisions to rebase where to rebase • The FAQ. The Glossary. The jj help command (e.g. jj help rebase ). The jj help -k <keyword> command (e.g. jj help -k config). Use jj help --help to see what keywords are available…
- [Jujutsu VCS: My Personal Cheat Sheet | Rahul's Blog](https://www.rahuljuliato.com/posts/jj-cheat-sheet) — query: Jujutsu jj workspace official docs add workspace command • A practical quick-reference for the JJ ( Jujutsu ) version control system: not a tutorial, but a ready-to-use guide with the most essential commands and workflows.
- [Git - git-worktree Documentation](https://git-scm.com/docs/git-worktree)
- [git - How to move changes to new worktree? - Stack Overflow](https://stackoverflow.com/questions/78751157/how-to-move-changes-to-new-worktree) — query: git worktree official documentation merge changes back worktree • I want to put those existing changes in a different worktree , so that my main branch/folder stays clean. I've tried variations of git worktree add -b new-branch ../feature but it…
- [Use Git worktrees | IntelliJ IDEA Documentation - JetBrains](https://www.jetbrains.com/help/idea/use-git-worktrees.html) — query: git worktree official documentation merge changes back worktree • When you create a worktree , Git generates a new directory for your files. Instead of a full . git folder, this directory contains a . git file with a plain-text path pointing bac…
- [Git Worktrees: From Zero to Hero - A comprehensive guide to using Git ...](https://gist.github.com/ashwch/946ad983977c9107db7ee9abafeb95bd) — query: git worktree official documentation merge changes back worktree • Key Insight Think of worktrees as parallel universes of your code: Each universe ( worktree ) shows your project at a different point in time (branch/commit) Changes in one univer…
- [Fix Pushed Git Commits After Merge: Worktree Strategy | Cody Williamson](https://codywilliamson.com/blog/2026-01-26-git-rewrite-pushed-commits-after-merge/) — query: git worktree official documentation merge changes back worktree • Learn the surgical approach to rewording pushed commits after merging your target branch. Step-by-step guide using git worktrees and cherry-pick to avoid rebase hell.
- [CLI reference - Jujutsu docs](https://docs.jj-vcs.dev/latest/cli-reference/) — query: site:docs.jj-vcs.dev jj rebase official docs revisions to rebase where to rebase • jj rebase -s X is similar to jj rebase -r X:: and will behave the same if X is a single revision . However, if X is a set of multiple revisions , or if you passed multiple -s argu…
- [Working copy - Jujutsu docs](https://docs.jj-vcs.dev/latest/working-copy/) — query: site:docs.jj-vcs.dev jj workspace update-stale rebase official docs • When the working copy is stale , use jj workspace update-stale to update the files in the working copy. A common reason that step 3 doesn't happen for a working copy is that you r…
- [Changelog - Jujutsu docs](https://docs.jj-vcs.dev/latest/changelog/)
- [Working Copy - Jujutsu docs](https://docs.jj-vcs.dev/v0.21.0/working-copy/) — query: site:docs.jj-vcs.dev "workspace update-stale" jj • By "stale", we mean that the files in the working copy don't match the desired commit indicated by the @ symbol in jj log. When that happens, use jj workspace update-stale to upda…
- [Changelog - Jujutsu docs](https://docs.jj-vcs.dev/v0.32.0/changelog/) — query: site:docs.jj-vcs.dev "workspace update-stale" jj • Added the config setting snapshot.auto-update-stale for automatically running jj workspace update-stale when applicable. jj duplicate now accepts --destination, --insert-after and…
- [Settings - Jujutsu docs](https://docs.jj-vcs.dev/latest/config/) — query: site:docs.jj-vcs.dev "workspace update-stale" jj • When a working copy becomes stale (meaning the working copy's recorded commit is no longer the current commit for that workspace), jj will normally prompt you to update it with jj…
- [Jujutsu (jj) Workflow Skill for Claude Code | AI VCS Guide](https://mcpmarket.com/tools/skills/jujutsu-jj-workflow-guide) — query: site:docs.jj-vcs.dev jj workspace update-stale rebase official docs • Master Jujutsu ( jj ) version control with Claude Code. Learn stable change IDs, history rewriting, and non-blocking conflict resolution for AI development.
- [Working Copy - Jujutsu docs](https://docs.jj-vcs.dev/v0.17.1/working-copy/) — query: site:docs.jj-vcs.dev jj workspace update-stale rebase official docs • By " stale ", we mean that the files in the working copy don't match the desired commit indicated by the @ symbol in jj log. When that happens, use jj workspace update-stale to up…
- [CLI options for specifying revisions - Jujutsu docs (prerelease)](https://docs.jj-vcs.dev/prerelease/guides/cli-revision-options/) — query: site:docs.jj-vcs.dev jj rebase official docs revisions to rebase where to rebase • This doesn't use -r because jj restore -r REV might seem like it would restore files from REV into the working copy. jj rebase --branch REV (-b REV) rebases a topological branch o…
- [Bookmarks - Jujutsu docs](https://docs.jj-vcs.dev/latest/bookmarks/) — query: site:docs.jj-vcs.dev jj rebase official docs revisions to rebase where to rebase • Bookmarks Introduction Bookmarks are named pointers to revisions (just like branches are in Git). You can move them without affecting the target revision's identity. Bookmarks aut…
- [Revset language - Jujutsu docs](https://docs.jj-vcs.dev/v0.23.0/revsets/) — query: site:docs.jj-vcs.dev jj rebase official docs revisions to rebase where to rebase • The all: modifier Certain commands (such as jj rebase ) can take multiple revset arguments, and each of these may resolve to one-or-many revisions . By default, jj will not allow…
