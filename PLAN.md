<!-- Generated automatically by toolbox on 2026-04-12T13:38:05.510Z -->

## Problem

The subagent workspace lifecycle currently has a jj-specific collision/leak risk:

- `.pi/extensions/toolbox/workspaces.ts` always creates the checkout at `join(cleanupRoot, "workspace")`
- for `jj workspace add`, the default workspace name is the basename of the destination directory
- that means every created jj workspace ends up named `workspace`
- stale failed runs can leave that name behind, and concurrent same-repo runs can collide immediately
- cleanup is also shaky because jj cleanup currently calls `jj workspace forget <workspacePath>`, while jj’s documented forget target is the workspace **name**
- there are a couple of early-failure paths where a created workspace can leak before the top-level `finally` runs

## What I learned

- Relevant code:
  - `.pi/extensions/toolbox/workspaces.ts`
  - `.pi/extensions/toolbox/implement-workflow.ts`
  - `.pi/extensions/toolbox/tests/workspaces.test.ts`
  - `.pi/extensions/toolbox/README.md`

- Current creation flow in `workspaces.ts`:
  - creates a unique temp root via `mkdtemp(...)`
  - then always uses `const workspacePath = join(cleanupRoot, "workspace")`

- Current cleanup flow for jj:
  - `cleanupJjWorkspace()` runs `jj workspace forget workspacePath`
  - then removes the directory from disk

- External docs implication:
  - jj docs/manpage say `jj workspace add` defaults the workspace name to the destination directory basename
  - jj docs/manpage say `jj workspace forget` takes workspace **names**
  - that strongly supports your concern: the fixed `workspace` basename is the real collision source, and forgetting by path is not the right contract

- Current lifecycle gaps:
  - `runToolboxImplementationWorkflow()` creates `runWorkspace` and calls `runWorkspace.refresh()` **before** entering its `try/finally`
  - `createChildWorkspace()` creates a managed workspace, then builds a baseline snapshot without its own cleanup guard
  - child workspaces are cleaned in the batch `finally`, which is good once they are fully returned, but not for setup failures before that point

## Decision log

- Use a unique workspace identity for every created workspace.
- Store the jj workspace name explicitly on `ManagedWorkspace`.
- Clean up jj workspaces by **name**, not by path.
- Make creation/setup paths cleanup-safe, not only the happy-path end of the run.
- Prefer the simplest compatible fix:
  - make the workspace directory basename unique
  - let jj derive the workspace name from that basename
  - this avoids depending on newer `jj workspace add --name` support unless you want extra explicitness
- Keep git worktree behavior path-based, but apply the same failure-safe cleanup discipline.

## Recommended approach

Refactor workspace creation so each workspace gets a generated name like:

- `toolbox-run-<shortid>`
- `toolbox-phase-1-<shortid>`

Then use that generated name consistently for:

- the workspace directory basename
- jj cleanup (`jj workspace forget <workspaceName>`)
- optional debug/status output

The minimal robust shape is:

1. generate `workspaceName = <sanitized label> + short random suffix`
2. create `workspacePath = join(cleanupRoot, workspaceName)` instead of `join(cleanupRoot, "workspace")`
3. store `workspaceName` on `ManagedWorkspace`
4. cleanup jj by workspace name
5. add cleanup-on-error in `createManagedWorkspace()`, `createChildWorkspace()`, and the top-level workflow setup path

That fixes both classes of problems you called out:

- stale failed runs no longer poison the repo with a reusable `workspace` name
- concurrent runs stop colliding on the same jj workspace name

## Implementation plan

1. **Change workspace identity in `.pi/extensions/toolbox/workspaces.ts`**
   - Add a helper that builds a unique workspace name from:
     - sanitized label
     - short random suffix
   - Change:
     - from `workspacePath = join(cleanupRoot, "workspace")`
     - to `workspacePath = join(cleanupRoot, workspaceName)`
   - Add `workspaceName` to `ManagedWorkspace`

2. **Fix jj cleanup semantics**
   - Update `cleanupJjWorkspace()` to accept both:
     - `workspaceName`
     - `workspacePath`
   - Run:
     - `jj workspace forget <workspaceName>`
   - Then remove the directory from disk as today

3. **Make `createManagedWorkspace()` failure-safe**
   - Wrap the post-`mkdtemp()` creation flow in cleanup-protected logic
   - If any of these fail after the temp root exists:
     - `createJjWorkspace()`
     - `createGitWorkspace()`
     - `findRepoRootOrSelf(workspacePath)`
     - `seedWorkspaceFromSource()`
   - Then best-effort cleanup the created workspace/worktree and remove `cleanupRoot` before rethrowing

4. **Make `createChildWorkspace()` failure-safe**
   - If `createWorkspaceSnapshot()` fails after the child workspace is created, clean up that child workspace before rethrowing

5. **Close the top-level workflow leak in `.pi/extensions/toolbox/implement-workflow.ts`**
   - Move the top-level run workspace lifecycle under `try/finally`
   - Specifically ensure `runWorkspace.refresh()` is covered by the same cleanup guard as the rest of the workflow
   - Use `await runWorkspace?.cleanup()` in `finally` only after successful creation

6. **Add regression tests in `.pi/extensions/toolbox/tests/workspaces.test.ts`**
   - Verify jj managed workspaces no longer use the literal name `workspace`
   - Verify two same-label workspaces get different names
   - Verify jj cleanup forgets by generated workspace name
   - Verify temp cleanup still removes `cleanupRoot`
   - Add a failure-path test where workspace creation succeeds but later setup fails, and assert cleanup still runs

7. **Optional small observability improvement**
   - Include the generated workspace name in startup/debug lines in `implement-workflow.ts`
   - Helpful for diagnosing future stale-workspace issues, but not required for correctness

## Acceptance criteria

- No jj workspace created by the subagent workflow is named exactly `workspace`
- Two runs with the same logical label can create workspaces concurrently without jj name collisions
- Failed runs do not leave a stale jj workspace named `workspace`
- jj cleanup uses the generated workspace name, not the path
- The top-level isolated workspace is cleaned up even if refresh or early setup fails
- Child workspaces are cleaned up if setup fails before they fully enter batch execution
- Existing workspace tests still pass, and new regression tests cover unique naming and cleanup-on-failure

## Risks / follow-ups

- If you choose to use `jj workspace add --name`, check your desired jj version floor first.  
  I’d avoid that unless you want extra explicitness; unique destination basenames already solve the problem.

- Keep generated names reasonably short to avoid unnecessary path-length growth.

- Current cleanup is intentionally best-effort; tests should verify the intended jj arguments so silent cleanup failures don’t regress unnoticed.

- No more research is needed before implementation.

## Sources consulted

- [Working on Windows - Jujutsu docs](https://jj-vcs.github.io/jj/v0.32.0/windows/) — query: site:jj-vcs.github.io workspace add --name jujutsu • Jujutsu may make incorrect decision on whether a file is a binary file and apply line conversion incorrectly, but currently, Jujutsu doesn't support configuring line endings conve…
- [Conflicts - Jujutsu docs](https://jj-vcs.github.io/jj/v0.24.0/technical/conflicts/) — query: site:jj-vcs.github.io workspace add --name jujutsu • For example, if you merge two branches in a repo, there may be conflicting changes between the two branches. Most DVCSs require you to resolve those conflicts before you can finis…
- [301 Moved Permanently](https://jj-vcs.github.io/jj/v0.33.0/guides/divergence/) — query: site:jj-vcs.github.io workspace add --name jujutsu • 301 Moved Permanently 301 Moved Permanently nginx
- [jj-workspace-add(1) — Arch manual pages](https://man.archlinux.org/man/jj-workspace-add.1.en)
- [Working branches and the JJ "way" · jj-vcs jj · Discussion #2425](https://github.com/jj-vcs/jj/discussions/2425) — query: jj workspace add command manual name • Something like jj workspace add -r name -of-branch path/to/ workspace should be OK, and will do what you ask. You can then just flip between the two folders as desired.
- [CLI reference - Jujutsu docs](https://docs.jj-vcs.dev/latest/cli-reference/)
- [Commands Reference | jj-vcs/jj | DeepWiki](https://deepwiki.com/jj-vcs/jj/5.2-commands-reference) — query: jj workspace forget path name manual • This page provides a comprehensive reference for all jj commands available to users. It covers core workflow commands (creating and modifying changes), Git integration commands (c…
- [Jujutsu VCS: My Personal Cheat Sheet | Rahul's Blog](https://www.rahuljuliato.com/posts/jj-cheat-sheet) — query: jj workspace add command manual name • A practical quick-reference for the JJ (Jujutsu) version control system: not a tutorial, but a ready-to-use guide with the most essential commands and workflows.
- [Working copy - Jujutsu docs](https://docs.jj-vcs.dev/latest/working-copy/)
- [Jujutsu Version Control System - tdudziak.com](https://tdudziak.com/2026/02/07/jujutsu-vcs.html) — query: jj workspace add command manual name • Another useful piece of jj functionality is the ability to use multiple workspaces , a feature similar to Git worktrees. With jj workspace add you can check out a working copy in…
- [Commands and Configuration | jj-vcs/jj | DeepWiki](https://deepwiki.com/jj-vcs/jj/5.2-commands-and-configuration) — query: jj workspace add command manual name • This page documents the major ` jj ` commands and their configuration options. It covers command categories, common usage patterns, and the configuration system that controls comm…
- [jj-workspace-forget(1) — Arch manual pages](https://man.archlinux.org/man/extra/jujutsu/jj-workspace-forget.1.en)
- [jj/docs/working-copy.md at main · jj-vcs/jj · GitHub](https://github.com/jj-vcs/jj/blob/main/docs/working-copy.md) — query: jj workspace forget path name manual • If needed, jj workspace root -- name < workspace > prints the root path of the specified workspace (defaults to the current one). When you're done using a workspace , use jj works…
- [jj-workspace-experiments | Skills Ma... · LobeHub](https://lobehub.com/skills/thoughtpolice-a-jj-workspace-experiments) — query: jj workspace forget path name manual • This Skill provides a disciplined workflow for creating isolated jj workspaces under a work/ directory to run experiments, test breaking changes, and develop alternative implement…
