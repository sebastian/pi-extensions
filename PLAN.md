<!-- Generated automatically by guided-discovery on 2026-04-12T11:47:59.585Z -->

## Problem

The current sub-agent implementation workflow is still too heavy at the endgame.

Today, `.pi/extensions/guided-discovery/implement-workflow.ts` runs a merged-result quality suite that loops:

- cleanup
- design review
- checker
- fix
- restart from cleanup

That same pattern also reruns after validator-driven finish work. Even with the newer graded gating, this can still burn rounds and feel endless.

Your requested direction is:

- move cleanup into the implementation loop
- move design review into the implementation loop when visible/user-facing elements are altered
- scope both to the affected code and immediate surroundings only
- do only one final holistic cleanup/design pass for glaring feature-level issues
- let only the final checker loop
- checker should focus on logic/regressions/side effects
- after 2 checker passes, leftover non-critical comments are not blocking
- checker should use only one companion model: prefer `openai-codex/gpt-5.3-codex`, else `GLM-5.1`

You also clarified two important decisions:

- the embedded loop should be **per phase**
- validator remediation should reuse that **same targeted loop**

## What I learned

- The main orchestration is in:
  - `.pi/extensions/guided-discovery/implement-workflow.ts`
  - `.pi/extensions/guided-discovery/models.ts`
  - `.pi/extensions/guided-discovery/implementation-progress.ts`

- The current workflow is still centered on a reusable whole-run `runQualitySuite()` that:
  - runs after implementation
  - reruns after validator remediation
  - loops `cleanup -> design -> checker -> fix -> cleanup`

- Current review prompts are broader than what you want:
  - `.pi/extensions/guided-discovery/agents/cleanup-auditor.md` explicitly allows nearby code and even concrete repo-wide cleanup opportunities
  - `.pi/extensions/guided-discovery/agents/design-reviewer.md` and `checker.md` say they may inspect nearby code paths as needed

- Design review is currently triggered by:
  - decomposer `designSensitive`
  - changed-file heuristics
  - discrepancy text
  - prior findings
  via `shouldRunDesignReview()` in `implement-workflow.ts`

- Worker routing already supports:
  - normal worker
  - design worker
  via `pickWorkerPromptForPhase()` and `pickRemediationPrompt()`

- The current checker model resolution is broader than you want:
  - `.pi/extensions/guided-discovery/models.ts` currently builds a checker list that can include:
    - primary
    - `gpt-5.4`
    - `gpt-5.3-codex`
    - `GLM-5.1`
  - tests in `.pi/extensions/guided-discovery/tests/models.test.ts` assert that wider behavior

- The progress UI and docs still describe the heavier loop:
  - `.pi/extensions/guided-discovery/README.md`
  - `.pi/extensions/guided-discovery/implementation-progress.ts`
  - related progress tests

- There is no existing “affected + immediate surroundings/callsites” scope helper yet; current scoping is mostly prompt-driven plus changed-file context.

## Decision log

- **Embed cleanup/design follow-through per phase.**
  - After each implementation phase, run targeted cleanup.
  - Run targeted design review only when that phase is design-sensitive / user-visible.

- **Reuse the same targeted loop for validator remediation.**
  - Validator-selected follow-up work should behave like a new implementation phase, not jump straight into a heavy global quality suite.

- **Limit targeted review scope.**
  - Targeted cleanup/design should focus on:
    - files changed by that phase
    - the phase’s declared touched paths
    - immediate surrounding code only when directly relevant
    - callsites/importers/tests/config around that area as needed
  - No repo-wide cleanup hunting in targeted mode.

- **Keep a final holistic cleanup/design pass, but single-shot only.**
  - Purpose: catch glaring feature-level mistakes.
  - No remediation loop from these passes.

- **Make the checker the only looping final gate.**
  - Checker should focus on:
    - logic bugs
    - regressions
    - unintended side effects
    - correctness/security/guidance issues
  - Residual non-critical comments after 2 passes are non-blocking.

- **Checker model policy should be capped to one companion model.**
  - Use:
    - primary checker model
    - plus at most one secondary:
      - `openai-codex/gpt-5.3-codex`
      - else `GLM-5.1`
  - Do not run both secondary models.

- **Do not add heavy static analysis for “surrounding code” in v1.**
  - Start with explicit scope context + prompt constraints.
  - Keep it simple and robust.

## Recommended approach

Refactor the workflow from a single global quality-suite loop into three smaller behaviors:

1. **Phase-local follow-through loop**
   - Runs immediately after each phase.
   - Handles targeted cleanup and targeted design review.
   - Applies fixes locally until the phase is acceptable.

2. **Final holistic review pass**
   - Runs once after all implementation is done.
   - Cleanup + conditional design review.
   - Feature-level, glaring issues only.
   - No loop.

3. **Final checker loop**
   - Runs after the holistic pass.
   - Bounded to 2 passes.
   - Only this stage loops.

That gives you the behavior you asked for while staying close to the current architecture:

- existing decomposition stays
- existing worker/design-worker routing stays
- validator loop stays
- but the heavy merged-result quality suite becomes much lighter and more focused

The simplest robust implementation is to keep the current agent model and prompt system, but introduce explicit **review scope context** so each review knows whether it is:

- a **targeted phase follow-through review**
- or a **final holistic feature review**

That is preferable to building new repo-analysis machinery first.

## Implementation plan

1. **Refactor workflow structure in `.pi/extensions/guided-discovery/implement-workflow.ts`**
   - Extract a new per-phase helper, e.g.:
     - `runPhaseFollowThroughLoop()`
   - Use it:
     - after each `runWorkerPhase()`
     - after each validator remediation pass
   - Remove the current dependency on one big post-implementation `runQualitySuite()` loop as the main quality mechanism.

2. **Add explicit scope/context builders**
   - Introduce targeted review context for a single phase:
     - phase metadata
     - changed files since phase start
     - phase touched paths
     - explicit scope rules: changed files + immediate surrounding code/callsites only
   - Introduce final holistic context:
     - whole changed feature
     - aggregate worker summaries
     - explicit rule: only glaring feature-level mistakes, no wishlist
   - Reuse `prepareReviewContextFiles()` patterns, but split targeted vs final behavior.

3. **Implement targeted cleanup/design follow-through**
   - For each phase:
     - run worker
     - detect phase-local changed files
     - run targeted cleanup
     - if phase is design-sensitive, run targeted design review
     - if findings remain, run fix worker and repeat
   - Keep this bounded and convergence-aware so it cannot become another endless loop.
   - Recommended default:
     - targeted phase loop can retry a small fixed number of times
     - if only minor polish remains, defer it to final holistic pass instead of thrashing

4. **Replace final quality suite with single-pass cleanup/design + checker loop**
   - Add:
     - `runFinalHolisticCleanupPass()`
     - `runFinalHolisticDesignPass()`
     - `runCheckerLoop()`
   - Final cleanup/design:
     - run once
     - no automatic loop
     - only hard/glaring issues should be considered blocking
   - Final checker:
     - focus prompt on logic/regression/side-effect review
     - run at most 2 passes total
     - after pass 2, residual soft/non-critical comments are informational

5. **Tighten checker model selection in `.pi/extensions/guided-discovery/models.ts`**
   - Change checker resolution to:
     - primary
     - plus one secondary only:
       - prefer `openai-codex/gpt-5.3-codex`
       - else `huggingface/zai-org/GLM-5.1` / `zai/zai-org/GLM-5.1`
   - Update:
     - `.pi/extensions/guided-discovery/tests/models.test.ts`

6. **Update prompts to match the new scope**
   - `.pi/extensions/guided-discovery/agents/cleanup-auditor.md`
     - targeted mode: no repo-wide cleanup exploration
     - final mode: whole-feature glaring cleanup only
   - `.pi/extensions/guided-discovery/agents/design-reviewer.md`
     - targeted mode: only changed phase + immediate surrounding UI/code
     - final mode: whole-feature glaring design mistakes only
   - `.pi/extensions/guided-discovery/agents/checker.md`
     - de-emphasize cleanup/polish
     - emphasize logic bugs, regressions, side effects, correctness

7. **Adjust validator remediation flow**
   - In `runTargetedValidatorRemediation()` and its callers:
     - after implementing selected discrepancies, run the same targeted phase follow-through loop
     - then run final holistic cleanup/design pass
     - then run final checker loop
     - then validator again

8. **Update progress UI and docs**
   - `.pi/extensions/guided-discovery/implementation-progress.ts`
   - `.pi/extensions/guided-discovery/implementation-progress.test.ts`
   - `.pi/extensions/guided-discovery/README.md`
   - Make the top-level flow reflect:
     - implementation (with embedded follow-through)
     - final cleanup
     - final design
     - checker
     - validator
   - Avoid showing the old global cleanup/design/checker loop as the default spine.

9. **Update workflow tests**
   - `.pi/extensions/guided-discovery/tests/implement-workflow.test.ts`
   - Add/replace tests for:
     - per-phase cleanup loop
     - per-phase design review only for design-sensitive/user-visible phases
     - validator remediation reusing the same targeted loop
     - final cleanup/design being single-pass and non-looping
     - checker stopping after 2 passes
     - non-critical checker findings not blocking after pass 2
     - hard checker findings still blocking

## Acceptance criteria

- After each implementation phase, the workflow runs targeted cleanup on that phase’s changes.
- After each design-sensitive/user-visible phase, the workflow also runs targeted design review.
- Targeted cleanup/design are explicitly limited to:
  - changed phase files
  - touched paths
  - immediate surrounding code/callsites/tests/config only
- Targeted cleanup/design no longer roam into repo-wide cleanup work.
- Validator-driven follow-up implementation reuses the same targeted per-phase follow-through behavior.
- After the overall implementation is done, the workflow runs:
  - one final holistic cleanup pass
  - one final holistic design pass when relevant
  - no loop from those passes
- The final checker is the only looping end-stage reviewer.
- Final checker runs at most 2 passes.
- After 2 checker passes, remaining non-critical findings do not block completion.
- Checker model selection uses only:
  - primary
  - plus one preferred secondary (`gpt-5.3-codex`, else `GLM-5.1`)
- README, progress UI, and tests all match the new workflow semantics.

## Risks / follow-ups

- The phrase “immediately surrounding code / callsites” is inherently fuzzy.
  Recommended v1: enforce it through context and prompts, not heavy static analysis.

- Refactoring away from `runQualitySuite()` will likely touch many tests and progress-state assumptions.
  This is more of a structural simplification than a tiny patch.

- Final holistic cleanup/design needs a clear blocking rule.
  My recommendation: only truly glaring hard issues block there; otherwise findings are reported and the checker remains the main loop.

- Some existing quality-budget helpers may become dead code and should be removed rather than half-reused.

- **No more research is needed before implementation.**
