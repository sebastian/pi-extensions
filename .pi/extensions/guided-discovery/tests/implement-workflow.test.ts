import test from "node:test";
import assert from "node:assert/strict";
import {
	QUALITY_SUITE_MAX_ROUNDS,
	decideQualitySuiteRound,
	decideValidatorDiscrepancyHandling,
	discrepancyAttemptSignature,
	hasVerifiedLegacyCleanupRemoval,
	partitionValidationDiscrepancies,
	pickRemediationPrompt,
	pickWorkerPromptForPhase,
	renderTargetedDiscrepancyContext,
	renderUnresolvedDiscrepancySummary,
	shouldRunDesignReview,
} from "../implement-workflow.ts";
import type { CheckerReport, DecompositionPhase, ValidationDiscrepancy, ValidationReport } from "../structured-output.ts";

function phase(overrides: Partial<DecompositionPhase> = {}): DecompositionPhase {
	return {
		id: overrides.id ?? "phase-1",
		title: overrides.title ?? "Refine flow",
		goal: overrides.goal ?? "Refine the implementation",
		instructions: overrides.instructions ?? ["Implement the change"],
		dependsOn: overrides.dependsOn ?? [],
		touchedPaths: overrides.touchedPaths ?? ["src/lib/helper.ts"],
		parallelSafe: overrides.parallelSafe ?? false,
		designSensitive: overrides.designSensitive ?? false,
	};
}

function report(findings: CheckerReport["findings"] = []): CheckerReport {
	return {
		findings,
		checksRun: [],
		unresolvedRisks: [],
		overallAssessment: findings.length > 0 ? "Needs work" : "Looks good",
	};
}

function discrepancy(overrides: Partial<ValidationDiscrepancy> = {}): ValidationDiscrepancy {
	const worthImplementingNow = overrides.worthImplementingNow ?? false;
	return {
		id: overrides.id ?? "discrepancy-1",
		item: overrides.item ?? "Add tests",
		status: overrides.status ?? "missing",
		reason: overrides.reason ?? "The worker focused on core behavior first.",
		suggestedAction: overrides.suggestedAction ?? "Add the missing implementation.",
		worthImplementingNow,
		worthwhileRationale:
			overrides.worthwhileRationale ??
			(worthImplementingNow ? "Small, low-risk, and directly requested." : "Useful, but not urgent for this pass."),
	};
}

function validation(discrepancies: ValidationDiscrepancy[] = []): ValidationReport {
	return {
		coverage: [],
		discrepancies,
		summary: discrepancies.length > 0 ? "Implementation needs follow-up." : "Implementation matches the plan.",
		recommendation: discrepancies.length > 0 ? "finish" : "accept",
		materialDiscrepancies: discrepancies.some((item) => item.status === "missing" || item.status === "partial"),
	};
}

test("shouldRunDesignReview honors explicit design metadata and fallback heuristics", () => {
	assert.equal(
		shouldRunDesignReview({
			phases: [phase({ designSensitive: true })],
		}),
		true,
	);
	assert.equal(
		shouldRunDesignReview({
			changedFiles: ["src/ui/onboarding.tsx"],
		}),
		true,
	);
	assert.equal(
		shouldRunDesignReview({
			phases: [phase({ title: "Clarify onboarding flow", touchedPaths: [] })],
		}),
		true,
	);
	assert.equal(
		shouldRunDesignReview({
			discrepancyText: "Tighten navigation copy and make the next action more discoverable.",
		}),
		true,
	);
	assert.equal(
		shouldRunDesignReview({
			findings: [
				{
					id: "finding-1",
					category: "ui",
					severity: "medium",
					summary: "Discoverability is weak",
					details: "The primary action is hard to find",
					suggestedFix: "Clarify hierarchy and the button affordance",
					paths: ["src/cli.ts"],
				},
			],
		}),
		true,
	);
	assert.equal(
		shouldRunDesignReview({
			phases: [phase({ title: "Refactor helper", touchedPaths: ["src/lib/helper.ts"] })],
		}),
		false,
	);
	assert.equal(
		shouldRunDesignReview({
			discrepancyText: "Improve database design clarity and simplify the migration planner.",
			changedFiles: ["src/server/migrations.ts"],
		}),
		false,
	);
	assert.equal(
		shouldRunDesignReview({
			phases: [
				phase({
					title: "Tighten API interaction semantics",
					goal: "Reduce ambiguity in a backend contract",
					instructions: ["Clarify the service-to-service interaction semantics"],
					touchedPaths: ["src/server/api.ts"],
				}),
			],
		}),
		false,
	);
});

test("pickWorkerPromptForPhase routes UI-like work through the design worker", () => {
	const selection = pickWorkerPromptForPhase(
		phase({
			title: "Refresh onboarding screen",
			touchedPaths: ["src/ui/onboarding.tsx"],
		}),
		{ workerPrompt: "worker", designWorkerPrompt: "design-worker" },
	);

	assert.equal(selection.kind, "design-worker");
	assert.equal(selection.systemPrompt, "design-worker");
	assert.equal(selection.designSensitive, true);
	assert.match(selection.reason, /UI|interaction|design/i);

	const backendSelection = pickWorkerPromptForPhase(
		phase({
			title: "Tighten API interaction semantics",
			goal: "Reduce ambiguity in a backend contract",
			instructions: ["Clarify the service-to-service interaction semantics"],
			touchedPaths: ["src/server/api.ts"],
		}),
		{ workerPrompt: "worker", designWorkerPrompt: "design-worker" },
	);
	assert.equal(backendSelection.kind, "worker");
	assert.equal(backendSelection.designSensitive, false);
});

test("pickRemediationPrompt chooses the design worker for design-sensitive findings and discrepancies", () => {
	const designSelection = pickRemediationPrompt({
		workerPrompt: "worker",
		designWorkerPrompt: "design-worker",
		findings: [
			{
				id: "finding-1",
				category: "ui",
				severity: "high",
				summary: "Hierarchy is unclear",
				details: "The action order is difficult to scan",
				suggestedFix: "Simplify the layout and promote the primary action",
				paths: ["src/screens/home.tsx"],
			},
		],
	});
	assert.equal(designSelection.kind, "design-worker");
	assert.equal(designSelection.designSensitive, true);

	const discrepancySelection = pickRemediationPrompt({
		workerPrompt: "worker",
		designWorkerPrompt: "design-worker",
		discrepancyText: "Clarify the onboarding copy and make the next action more discoverable.",
	});
	assert.equal(discrepancySelection.kind, "design-worker");
	assert.equal(discrepancySelection.designSensitive, true);

	const defaultSelection = pickRemediationPrompt({
		workerPrompt: "worker",
		designWorkerPrompt: "design-worker",
		findings: [
			{
				id: "finding-2",
				category: "loose_ends",
				severity: "low",
				summary: "Unused helper remains",
				details: "A dead helper was left behind",
				suggestedFix: "Remove the helper",
				paths: ["src/lib/cleanup.ts"],
			},
		],
	});
	assert.equal(defaultSelection.kind, "worker");
	assert.equal(defaultSelection.designSensitive, false);

	const backendSelection = pickRemediationPrompt({
		workerPrompt: "worker",
		designWorkerPrompt: "design-worker",
		discrepancyText: "Improve database design clarity and simplify cache invalidation.",
		changedFiles: ["src/server/cache.ts"],
	});
	assert.equal(backendSelection.kind, "worker");
	assert.equal(backendSelection.designSensitive, false);
});

test("decideQualitySuiteRound requests remediation and restarts from cleanup when findings remain", () => {
	const decision = decideQualitySuiteRound({
		round: 1,
		maxRounds: QUALITY_SUITE_MAX_ROUNDS,
		cleanupReport: report([
			{
				id: "finding-1",
				category: "loose_ends",
				severity: "medium",
				summary: "Legacy state is still wired in",
				details: "Old state survives the refactor",
				suggestedFix: "Remove the stale branch",
				paths: ["src/state.ts"],
			},
		]),
		designRequired: false,
		designReport: null,
		checkerReport: report([
			{
				id: "finding-2",
				category: "regression",
				severity: "high",
				summary: "Regression risk remains",
				details: "The guard is missing",
				suggestedFix: "Restore the guard",
				paths: ["src/api.ts"],
			},
		]),
	});

	assert.equal(decision.action, "remediate");
	assert.equal(decision.designReviewStatus, "skipped");
	assert.deepEqual(decision.triggerStages, ["cleanup", "checker"]);
	assert.equal(decision.restartStage, "cleanup");
	assert.deepEqual(decision.findingCounts, {
		cleanup: 1,
		design: 0,
		checker: 1,
	});
});

test("decideQualitySuiteRound fails clearly when the retry bound is exhausted with design findings", () => {
	const decision = decideQualitySuiteRound({
		round: QUALITY_SUITE_MAX_ROUNDS,
		maxRounds: QUALITY_SUITE_MAX_ROUNDS,
		cleanupReport: report(),
		designRequired: true,
		designReport: report([
			{
				id: "finding-1",
				category: "ui",
				severity: "high",
				summary: "Too many competing controls",
				details: "The flow still creates cognitive load",
				suggestedFix: "Reduce the number of controls and choices",
				paths: ["src/ui/flow.tsx"],
			},
		]),
		checkerReport: report(),
	});

	assert.equal(decision.action, "fail");
	assert.equal(decision.designReviewStatus, "ran");
	assert.deepEqual(decision.triggerStages, ["design"]);
	assert.match(decision.message ?? "", /Quality suite exhausted/);
	assert.match(decision.message ?? "", /Design review is a hard gate/);
});

test("partitionValidationDiscrepancies separates automatic, manual, and informational items", () => {
	const triage = partitionValidationDiscrepancies({
		discrepancies: [
			discrepancy({ id: "D1", item: "Add tests", worthImplementingNow: true }),
			discrepancy({ id: "D2", item: "Update docs", status: "partial" }),
			discrepancy({ id: "D3", item: "Remove obsolete branch", status: "superseded", worthImplementingNow: true }),
		],
	});

	assert.deepEqual(triage.actionableDiscrepancies.map((item) => item.id), ["D1", "D2"]);
	assert.deepEqual(triage.autoDiscrepancies.map((item) => item.id), ["D1"]);
	assert.deepEqual(triage.remainingActionableDiscrepancies.map((item) => item.id), ["D2"]);
	assert.deepEqual(triage.informationalDiscrepancies.map((item) => item.id), ["D3"]);
});

test("decideValidatorDiscrepancyHandling auto-remediates worthwhile items before prompting", () => {
	const decision = decideValidatorDiscrepancyHandling({
		validation: validation([
			discrepancy({ id: "D1", item: "Add tests", worthImplementingNow: true }),
			discrepancy({ id: "D2", item: "Update docs", status: "partial" }),
		]),
		hasUI: true,
		stage: "initial",
	});

	assert.equal(decision.action, "auto-remediate");
	assert.deepEqual(decision.autoDiscrepancies.map((item) => item.id), ["D1"]);
	assert.deepEqual(decision.remainingActionableDiscrepancies.map((item) => item.id), ["D2"]);
});

test("decideValidatorDiscrepancyHandling does not auto-retry already-attempted worthwhile items", () => {
	const worthwhile = discrepancy({
		id: "D1",
		item: "Add tests",
		status: "missing",
		worthImplementingNow: true,
	});
	const sameItemAfterPartialProgress = { ...worthwhile, status: "partial" as const };

	assert.equal(discrepancyAttemptSignature(worthwhile), discrepancyAttemptSignature(sameItemAfterPartialProgress));

	const decision = decideValidatorDiscrepancyHandling({
		validation: validation([
			sameItemAfterPartialProgress,
			discrepancy({ id: "D2", item: "Update docs", status: "partial" }),
		]),
		hasUI: true,
		attemptedAutoSignatures: [discrepancyAttemptSignature(worthwhile)],
		stage: "post-remediation",
	});

	assert.equal(decision.action, "prompt");
	assert.deepEqual(decision.autoDiscrepancies, []);
	assert.deepEqual(decision.attemptedAutoDiscrepancies.map((item) => item.id), ["D1"]);
	assert.deepEqual(decision.remainingActionableDiscrepancies.map((item) => item.id), ["D1", "D2"]);
});

test("renderTargetedDiscrepancyContext scopes remediation to the selected subset", () => {
	const selected = discrepancy({
		id: "D1",
		item: "Add validator tests",
		worthImplementingNow: true,
	});
	const outOfScope = discrepancy({
		id: "D2",
		item: "Update README",
		status: "partial",
		reason: "Documentation was deferred until behavior settled.",
		suggestedAction: "Document the final behavior after the runtime changes land.",
	});

	const context = renderTargetedDiscrepancyContext({
		selectedDiscrepancies: [selected],
		allDiscrepancies: [selected, outOfScope],
		summary: "Two discrepancies remain.",
		recommendation: "finish",
	});

	assert.match(context, /Implement only the selected discrepancies in this pass/);
	assert.match(context, /Do not implement any other unresolved validator discrepancies/i);
	assert.match(context, /## Selected discrepancies to implement now/);
	assert.match(context, /D1 — missing: Add validator tests/);
	assert.match(context, /## Other unresolved discrepancies not in scope for this pass/);
	assert.match(context, /D2 — partial: Update README/);
});

test("renderUnresolvedDiscrepancySummary includes why-not-done and worthwhile judgments", () => {
	const summary = renderUnresolvedDiscrepancySummary([
		discrepancy({
			id: "D1",
			item: "Add validator tests",
			worthImplementingNow: true,
			worthwhileRationale: "Small, low-risk, and directly improves the requested behavior.",
			suggestedAction: "Add focused workflow tests.",
		}),
		discrepancy({
			id: "D2",
			item: "Remove obsolete prompt path",
			status: "superseded",
			reason: "The prior prompt path is no longer relevant after the new flow.",
			worthImplementingNow: false,
			worthwhileRationale: "Purely informational; no new work is needed.",
			suggestedAction: "Leave it reported for context.",
		}),
	]);

	assert.match(summary, /## Remaining validator discrepancies/);
	assert.match(summary, /Actionable: 1/);
	assert.match(summary, /Informational \(superseded\): 1/);
	assert.match(summary, /why not done: The worker focused on core behavior first\./);
	assert.match(summary, /worth implementing now: yes/);
	assert.match(summary, /worthwhile rationale: Small, low-risk, and directly improves the requested behavior\./);
	assert.match(summary, /suggested action: Add focused workflow tests\./);
	assert.match(summary, /D2 — superseded: Remove obsolete prompt path/);
});

test("decideValidatorDiscrepancyHandling fails clearly without UI when actionable discrepancies remain", () => {
	const decision = decideValidatorDiscrepancyHandling({
		validation: validation([
			discrepancy({ id: "D1", item: "Add tests", worthImplementingNow: false }),
			discrepancy({ id: "D2", item: "Update docs", status: "partial", worthImplementingNow: true }),
		]),
		hasUI: false,
		attemptedAutoSignatures: [discrepancyAttemptSignature(discrepancy({ id: "D2", item: "Update docs", worthImplementingNow: true }))],
		stage: "post-remediation",
	});

	assert.equal(decision.action, "fail");
	assert.match(decision.message ?? "", /non-interactive mode/);
	assert.match(decision.message ?? "", /no interactive selection path is available/);
	assert.match(decision.message ?? "", /Automatic remediation was already attempted/);
	assert.match(decision.message ?? "", /Remaining actionable discrepancies: missing: Add tests • partial: Update docs/);
});

test("decideValidatorDiscrepancyHandling continues for accepted or informational-only discrepancies", () => {
	assert.equal(
		decideValidatorDiscrepancyHandling({
			validation: validation([discrepancy({ id: "D1", item: "Old fallback", status: "superseded" })]),
			hasUI: false,
			stage: "initial",
		}).action,
		"continue",
	);
	assert.equal(
		decideValidatorDiscrepancyHandling({
			validation: validation([discrepancy({ id: "D2", item: "Add tests" })]),
			hasUI: false,
			discrepanciesAccepted: true,
			stage: "post-remediation",
		}).action,
		"continue",
	);
});

test("hasVerifiedLegacyCleanupRemoval requires a legacy cleanup finding to disappear", () => {
	const legacyFinding: CheckerReport["findings"][number] = {
		id: "finding-1",
		category: "loose_ends",
		severity: "medium",
		summary: "Legacy branch is still wired in",
		details: "A superseded state branch still exists",
		suggestedFix: "Retire the old branch",
		paths: ["src/state.ts"],
	};
	const nonLegacyFinding: CheckerReport["findings"][number] = {
		id: "finding-2",
		category: "regression",
		severity: "high",
		summary: "Missing guard",
		details: "The refactor dropped a guard",
		suggestedFix: "Restore the guard",
		paths: ["src/api.ts"],
	};

	assert.equal(
		hasVerifiedLegacyCleanupRemoval({
			previousFindings: [legacyFinding, nonLegacyFinding],
			currentFindings: [nonLegacyFinding],
		}),
		true,
	);
	assert.equal(
		hasVerifiedLegacyCleanupRemoval({
			previousFindings: [legacyFinding],
			currentFindings: [legacyFinding],
		}),
		false,
	);
	assert.equal(
		hasVerifiedLegacyCleanupRemoval({
			previousFindings: [legacyFinding],
			currentFindings: [
				{
					...legacyFinding,
					summary: "Superseded branch remains wired differently",
					details: "The old state branch is still present in the same file",
				},
			],
		}),
		false,
	);
	assert.equal(
		hasVerifiedLegacyCleanupRemoval({
			previousFindings: [nonLegacyFinding],
			currentFindings: [],
		}),
		false,
	);
	assert.equal(
		hasVerifiedLegacyCleanupRemoval({
			previousFindings: [{ ...legacyFinding, paths: [] }],
			currentFindings: [],
		}),
		false,
	);
});
