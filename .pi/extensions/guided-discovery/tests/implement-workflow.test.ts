import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	QUALITY_SUITE_MAX_EXTRA_ROUNDS,
	QUALITY_SUITE_MAX_ROUNDS,
	buildSummary,
	collectWorkerAgentFiles,
	decideQualitySuiteRound,
	decideValidatorDiscrepancyHandling,
	discrepancyAttemptSignature,
	hasVerifiedLegacyCleanupRemoval,
	materializeWorkflowPlan,
	parseImplementationRequest,
	partitionValidationDiscrepancies,
	pickRemediationPrompt,
	pickWorkerPromptForPhase,
	renderTargetedDiscrepancyContext,
	renderUnresolvedDiscrepancySummary,
	resolveStandaloneSubagentRequest,
	runValidatorDiscrepancyLoop,
	shouldRunDesignReview,
	summarizeAgentsCheckHistory,
	type ValidationResolutionSummary,
	type WorkflowQualitySummary,
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

function validationResolution(): ValidationResolutionSummary {
	return {
		autoRemediationPasses: 0,
		autoRemediatedDiscrepancyIds: [] as string[],
		manualRemediationPasses: 0,
		manuallyTargetedDiscrepancyIds: [] as string[],
		acceptedRemainingDiscrepancies: false,
	};
}

function qualitySummary(overrides: Partial<WorkflowQualitySummary> = {}): WorkflowQualitySummary {
	return {
		cleanupRuns: overrides.cleanupRuns ?? 1,
		designReviewRuns: overrides.designReviewRuns ?? 1,
		designReviewSkips: overrides.designReviewSkips ?? 0,
		checkerRuns: overrides.checkerRuns ?? 1,
		remediationPasses: overrides.remediationPasses ?? 0,
		fixedFindings:
			overrides.fixedFindings ??
			({ cleanup: 1, design: 0, checker: 1, total: 2 } satisfies WorkflowQualitySummary["fixedFindings"]),
		agentsChecks:
			overrides.agentsChecks ??
			{
				trackedCommands: 1,
				finalPassed: 1,
				finalFailed: 0,
				finalBlocked: 0,
				finalErrored: 0,
				failedAtLeastOnce: 1,
				blockedAtLeastOnce: 0,
				erroredAtLeastOnce: 0,
				failedThenFixed: 1,
			},
		legacyCodeOrFilesRemoved: overrides.legacyCodeOrFilesRemoved ?? true,
		mergedResultVerificationRuns: overrides.mergedResultVerificationRuns ?? 2,
		mergedResultVerificationReasons:
			overrides.mergedResultVerificationReasons ?? [
				"merged implementation result after child-workspace conflict resolution",
				"merged result after selected validator remediation",
			],
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

test("decideQualitySuiteRound fails clearly when hard findings remain after the bounded retries", () => {
	const history = [
		{ round: 1, hardFindingCount: 1, softFindingCount: 0, totalFindingCount: 1, weightedScore: 23 },
		{ round: 2, hardFindingCount: 1, softFindingCount: 0, totalFindingCount: 1, weightedScore: 23 },
	];
	const decision = decideQualitySuiteRound({
		round: QUALITY_SUITE_MAX_ROUNDS,
		maxRounds: QUALITY_SUITE_MAX_ROUNDS,
		history,
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
	assert.equal(decision.hardGateFindings.length, 1);
	assert.equal(decision.softGateFindings.length, 0);
	assert.match(decision.message ?? "", /Hard-blocking findings remain/);
	assert.match(decision.message ?? "", /not materially improved/i);
});


test("decideQualitySuiteRound grants extra rounds when only soft findings are materially improving", () => {
	const decision = decideQualitySuiteRound({
		round: QUALITY_SUITE_MAX_ROUNDS,
		maxRounds: QUALITY_SUITE_MAX_ROUNDS,
		history: [
			{ round: 1, hardFindingCount: 0, softFindingCount: 3, totalFindingCount: 3, weightedScore: 6 },
			{ round: 2, hardFindingCount: 0, softFindingCount: 2, totalFindingCount: 2, weightedScore: 4 },
		],
		cleanupReport: report([
			{
				id: "finding-1",
				category: "loose_ends",
				severity: "low",
				summary: "Old helper remains",
				details: "A tiny cleanup item remains",
				suggestedFix: "Remove the helper",
				paths: ["src/lib/helper.ts"],
			},
		]),
		designRequired: false,
		designReport: null,
		checkerReport: report(),
	});

	assert.equal(decision.action, "remediate");
	assert.equal(decision.materialProgress, true);
	assert.equal(decision.roundBudget.total, QUALITY_SUITE_MAX_ROUNDS + QUALITY_SUITE_MAX_EXTRA_ROUNDS);
	assert.equal(decision.hardGateFindings.length, 0);
	assert.equal(decision.softGateFindings.length, 1);
	assert.match(decision.message ?? "", /latest round improved materially/i);
});


test("decideQualitySuiteRound prompts instead of failing when only soft findings remain without convergence", () => {
	const decision = decideQualitySuiteRound({
		round: QUALITY_SUITE_MAX_ROUNDS,
		maxRounds: QUALITY_SUITE_MAX_ROUNDS,
		history: [
			{ round: 1, hardFindingCount: 0, softFindingCount: 1, totalFindingCount: 1, weightedScore: 2 },
			{ round: 2, hardFindingCount: 0, softFindingCount: 1, totalFindingCount: 1, weightedScore: 2 },
		],
		cleanupReport: report([
			{
				id: "finding-1",
				category: "loose_ends",
				severity: "medium",
				summary: "One stale helper remains",
				details: "Low-risk cleanup remains",
				suggestedFix: "Remove the helper",
				paths: ["src/lib/helper.ts"],
			},
		]),
		designRequired: false,
		designReport: null,
		checkerReport: report(),
	});

	assert.equal(decision.action, "prompt");
	assert.equal(decision.hardGateFindings.length, 0);
	assert.equal(decision.softGateFindings.length, 1);
	assert.equal(decision.stagnationCount, 2);
	assert.match(decision.message ?? "", /Only soft quality findings remain/);
	assert.match(decision.message ?? "", /accept the remaining polish issues/i);
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

test("runValidatorDiscrepancyLoop remediates a selected discrepancy instead of stalling after continue", async () => {
	const initialValidation = validation([discrepancy({ id: "D1", item: "Add tests", worthImplementingNow: false })]);
	const resolution = validationResolution();
	const remediationKinds: string[] = [];

	const result = await runValidatorDiscrepancyLoop({
		initialValidation,
		hasUI: true,
		validationResolution: resolution,
		promptForChoice: async () => "Select items to implement now",
		selectDiscrepancies: async ({ handling, initialSelectedIds }) => {
			assert.deepEqual(initialSelectedIds, []);
			return [handling.remainingActionableDiscrepancies[0]];
		},
		runRemediation: async ({ kind, discrepancies, passNumber }) => {
			remediationKinds.push(`${kind}:${passNumber}:${discrepancies.map((item) => item.id).join(",")}`);
			return validation([]);
		},
	});

	assert.equal(result.decision, "continue");
	assert.equal(result.validation.discrepancies.length, 0);
	assert.deepEqual(remediationKinds, ["manual:1:D1"]);
	assert.equal(resolution.manualRemediationPasses, 1);
	assert.deepEqual(resolution.manuallyTargetedDiscrepancyIds, ["D1"]);
});

test("runValidatorDiscrepancyLoop supports repeated continue cycles across auto and manual remediation", async () => {
	const autoOnly = discrepancy({ id: "D1", item: "Add tests", worthImplementingNow: true });
	const manualOne = discrepancy({ id: "D2", item: "Update docs", status: "partial" });
	const manualTwo = discrepancy({ id: "D3", item: "Tighten examples", status: "partial" });
	const resolution = validationResolution();
	const remediationKinds: string[] = [];
	const selectionStates: Array<{ pass: number; initialSelectedIds: string[]; ids: string[] }> = [];
	let promptCount = 0;
	let manualPass = 0;

	const result = await runValidatorDiscrepancyLoop({
		initialValidation: validation([autoOnly, manualOne]),
		hasUI: true,
		validationResolution: resolution,
		promptForChoice: async () => {
			promptCount += 1;
			return "Select items to implement now";
		},
		selectDiscrepancies: async ({ handling, initialSelectedIds }) => {
			manualPass += 1;
			selectionStates.push({
				pass: manualPass,
				initialSelectedIds,
				ids: handling.remainingActionableDiscrepancies.map((item) => item.id || ""),
			});
			return manualPass === 1 ? [handling.remainingActionableDiscrepancies[0]] : [handling.remainingActionableDiscrepancies[1]];
		},
		runRemediation: async ({ kind, discrepancies, passNumber }) => {
			remediationKinds.push(`${kind}:${passNumber}:${discrepancies.map((item) => item.id).join(",")}`);
			if (kind === "auto") {
				return validation([
					discrepancy({ id: "D2", item: "Update docs", status: "partial", worthImplementingNow: false }),
					discrepancy({ id: "D3", item: "Tighten examples", status: "partial", worthImplementingNow: false }),
				]);
			}
			if (discrepancies[0]?.id === "D2") {
				return validation([
					discrepancy({ id: "D2", item: "Update docs", status: "partial", worthImplementingNow: false }),
					discrepancy({ id: "D3", item: "Tighten examples", status: "partial", worthImplementingNow: false }),
				]);
			}
			return validation([]);
		},
	});

	assert.equal(result.decision, "continue");
	assert.equal(result.validation.discrepancies.length, 0);
	assert.deepEqual(remediationKinds, ["auto:1:D1", "manual:1:D2", "manual:2:D3"]);
	assert.equal(promptCount, 2);
	assert.deepEqual(selectionStates, [
		{ pass: 1, initialSelectedIds: [], ids: ["D2", "D3"] },
		{ pass: 2, initialSelectedIds: ["D2"], ids: ["D2", "D3"] },
	]);
	assert.equal(resolution.autoRemediationPasses, 1);
	assert.equal(resolution.manualRemediationPasses, 2);
	assert.deepEqual(resolution.autoRemediatedDiscrepancyIds, ["D1"]);
	assert.deepEqual(resolution.manuallyTargetedDiscrepancyIds, ["D2", "D3"]);
});

test("runValidatorDiscrepancyLoop distinguishes accept and reformulate outcomes", async () => {
	const unresolved = validation([discrepancy({ id: "D1", item: "Add tests", worthImplementingNow: false })]);

	const acceptedResolution = validationResolution();
	const accepted = await runValidatorDiscrepancyLoop({
		initialValidation: unresolved,
		hasUI: true,
		validationResolution: acceptedResolution,
		promptForChoice: async () => "Accept the discrepancies and finish",
		selectDiscrepancies: async () => {
			throw new Error("selection should not run when accepting");
		},
		runRemediation: async () => {
			throw new Error("remediation should not run when accepting");
		},
	});
	assert.equal(accepted.decision, "continue");
	assert.equal(accepted.validation.discrepancies.length, 1);
	assert.equal(acceptedResolution.acceptedRemainingDiscrepancies, true);

	const reformulateResolution = validationResolution();
	const reformulated = await runValidatorDiscrepancyLoop({
		initialValidation: unresolved,
		hasUI: true,
		validationResolution: reformulateResolution,
		promptForChoice: async () => "Reformulate in discovery mode",
		selectDiscrepancies: async () => {
			throw new Error("selection should not run when reformulating");
		},
		runRemediation: async () => {
			throw new Error("remediation should not run when reformulating");
		},
	});
	assert.equal(reformulated.decision, "reformulate");
	assert.equal(reformulated.validation.discrepancies.length, 1);
	assert.equal(reformulateResolution.acceptedRemainingDiscrepancies, false);
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

test("summarizeAgentsCheckHistory records AGENTS reruns separately from model reviews", () => {
	const history = summarizeAgentsCheckHistory([
		{ command: "model-review", source: "default", status: "passed", summary: "Looks good" },
		{ command: "pnpm test", source: "AGENTS.md", status: "failed", summary: "1 failing test" },
		{ command: "pnpm lint", source: "src/AGENTS.md", status: "blocked", summary: "Approval not granted" },
		{ command: "pnpm test", source: "AGENTS.md", status: "passed", summary: "All tests passed" },
		{ command: "pnpm lint", source: "src/AGENTS.md", status: "passed", summary: "Lint clean" },
		{ command: "jj status", source: "AGENTS.md", status: "error", summary: "spawn jj ENOENT" },
	]);

	assert.deepEqual(history, {
		trackedCommands: 3,
		finalPassed: 2,
		finalFailed: 0,
		finalBlocked: 0,
		finalErrored: 1,
		failedAtLeastOnce: 1,
		blockedAtLeastOnce: 1,
		erroredAtLeastOnce: 1,
		failedThenFixed: 1,
	});
});


test("buildSummary distinguishes fixed issues, accepted residual soft issues, and blocking hard issues", () => {
	const summary = buildSummary(
		["src/ui/screen.tsx", "README.md"],
		[
			{ command: "model-review", source: "default", status: "failed", summary: "1 polish finding" },
			{ command: "pnpm test", source: "AGENTS.md", status: "passed", summary: "All tests passed" },
		],
		validation([discrepancy({ id: "D1", item: "Document the edge case", status: "partial" })]),
		report([
			{
				id: "finding-1",
				category: "ui",
				severity: "medium",
				summary: "Button copy could be clearer",
				details: "The button still needs a tighter label",
				suggestedFix: "Tighten the copy",
				paths: ["src/ui/screen.tsx"],
			},
		]),
		qualitySummary(),
		validationResolution(),
		{
			acceptedResidualSoftFindings: [
				{
					stage: "design",
					category: "ui",
					severity: "medium",
					summary: "Button copy could be clearer",
					paths: ["src/ui/screen.tsx"],
					classification: "soft",
				},
			],
			blockingHardFindings: [
				{
					stage: "checker",
					category: "guidance",
					severity: "high",
					summary: "Required AGENTS.md check failed: pnpm lint",
					paths: [],
					classification: "hard",
				},
			],
		},
	);

	assert.match(summary, /Fixed quality findings: cleanup 1, design 0, checker 1, total 2/);
	assert.match(summary, /Accepted residual soft quality issues: 1/);
	assert.match(summary, /Blocking hard quality issues: 1/);
	assert.match(summary, /Merged-result verification passes: 2/);
	assert.match(summary, /child-workspace conflict resolution/);
	assert.match(summary, /## Accepted residual soft quality issues/);
	assert.match(summary, /design\/ui: Button copy could be clearer/);
	assert.match(summary, /## Blocking hard quality issues/);
	assert.match(summary, /checker\/guidance: Required AGENTS.md check failed: pnpm lint/);
});

test("collectWorkerAgentFiles includes touched-path AGENTS guidance once", async () => {
	const root = await mkdtemp(join(tmpdir(), "guided-discovery-worker-guidance-"));
	await mkdir(join(root, ".jj"));
	await mkdir(join(root, "src", "feature"), { recursive: true });
	await writeFile(join(root, "AGENTS.md"), "root guidance\n", "utf8");
	await writeFile(join(root, "src", "AGENTS.md"), "src guidance\n", "utf8");

	const baseAgentFiles = [join(root, "AGENTS.md")];
	const contextPath = join(root, "phase.md");
	await writeFile(contextPath, "context\n", "utf8");

	assert.deepEqual(
		collectWorkerAgentFiles(baseAgentFiles, root, ["src/feature/index.ts"], [contextPath]),
		[await realpath(join(root, "AGENTS.md")), await realpath(join(root, "src", "AGENTS.md")), await realpath(contextPath)],
	);
});

test("parseImplementationRequest extracts implementation mode prefixes without dropping free-form instructions", () => {
	assert.deepEqual(parseImplementationRequest("subagents Keep changes minimal."), {
		mode: "subagents",
		extraInstructions: "Keep changes minimal.",
	});
	assert.deepEqual(parseImplementationRequest("--mode subagent Start with tests."), {
		mode: "subagents",
		extraInstructions: "Start with tests.",
	});
	assert.deepEqual(parseImplementationRequest("direct: Ship the smallest safe slice."), {
		mode: "direct",
		extraInstructions: "Ship the smallest safe slice.",
	});
	assert.deepEqual(parseImplementationRequest("Add a standalone /sync command"), {
		mode: undefined,
		extraInstructions: "Add a standalone /sync command",
	});
});

test("resolveStandaloneSubagentRequest prefers raw prompts and falls back to PLAN.md", () => {
	assert.deepEqual(
		resolveStandaloneSubagentRequest({
			rawArgs: "Add a standalone /sync command",
			planPath: "/repo/PLAN.md",
			hasPlanFile: true,
		}),
		{ kind: "raw-prompt", rawPrompt: "Add a standalone /sync command" },
	);
	assert.deepEqual(
		resolveStandaloneSubagentRequest({
			rawArgs: "   ",
			planPath: "/repo/PLAN.md",
			hasPlanFile: true,
		}),
		{ kind: "plan", planPath: "/repo/PLAN.md" },
	);
	assert.deepEqual(resolveStandaloneSubagentRequest({ rawArgs: "", planPath: "/repo/PLAN.md", hasPlanFile: false }), {
		kind: "missing-plan",
		message: "No PLAN.md found. Pass a raw prompt or create PLAN.md first.",
	});
});

test("materializeWorkflowPlan copies an existing plan into a workflow-local PLAN.md", async () => {
	const root = await mkdtemp(join(tmpdir(), "guided-discovery-plan-copy-"));
	const tempDir = join(root, "workflow");
	await mkdir(tempDir, { recursive: true });
	await mkdir(join(root, "plans"), { recursive: true });
	const sourcePlanPath = join(root, "plans", "PLAN.md");
	await writeFile(sourcePlanPath, "## Problem\n\nCopy me\n", "utf8");

	const result = await materializeWorkflowPlan({
		cwd: root,
		tempDir,
		agentFiles: [],
		planPath: "plans/PLAN.md",
		plannerPrompt: "planner",
		extraInstructions: "",
	});

	assert.equal(result.planPath, join(tempDir, "PLAN.md"));
	assert.equal(result.label, sourcePlanPath);
	assert.equal(await readFile(result.planPath, "utf8"), "## Problem\n\nCopy me\n");
});

test("materializeWorkflowPlan synthesizes a workflow-local plan from a raw prompt", async () => {
	const root = await mkdtemp(join(tmpdir(), "guided-discovery-plan-synth-"));
	const tempDir = join(root, "workflow");
	await mkdir(tempDir, { recursive: true });
	const agentsPath = join(root, "AGENTS.md");
	await writeFile(agentsPath, "Use jj.\n", "utf8");

	let invocation:
		| {
				cwd: string;
				systemPrompt: string;
				prompt: string;
				files?: string[];
				tools?: string[];
			}
		| undefined;
	const synthesizedPlan = [
		"## Problem",
		"",
		"Implement the request.",
		"",
		"## What I learned",
		"",
		"The repo already has a guided workflow.",
		"",
		"## Decision log",
		"",
		"- Keep the change minimal.",
		"",
		"## Recommended approach",
		"",
		"Use the existing implementation flow.",
		"",
		"## Implementation plan",
		"",
		"1. Add the entrypoint.",
		"",
		"## Acceptance criteria",
		"",
		"- The command works.",
		"",
		"## Risks / follow-ups",
		"",
		"- None.",
	].join("\n");

	const result = await materializeWorkflowPlan({
		cwd: root,
		tempDir,
		agentFiles: [agentsPath],
		rawPrompt: "Add a standalone /sync command and keep the UI minimal.",
		plannerPrompt: "planner",
		extraInstructions: "Reuse the existing command patterns.",
		runSubagentFn: async (call) => {
			invocation = {
				cwd: call.cwd,
				systemPrompt: call.systemPrompt,
				prompt: call.prompt,
				files: call.files,
				tools: call.tools,
			};
			return {
				exitCode: 0,
				stderr: "",
				messages: [],
				assistantText: synthesizedPlan,
			};
		},
	});

	assert.equal(result.label, "the synthesized lightweight plan");
	assert.equal(result.planPath, join(tempDir, "PLAN.md"));
	assert.equal((await readFile(result.planPath, "utf8")).trim(), synthesizedPlan);
	assert.equal(invocation?.cwd, root);
	assert.equal(invocation?.systemPrompt, "planner");
	assert.equal(invocation?.prompt, "Create a lightweight implementation plan for the attached request. Output markdown only.");
	assert.deepEqual(invocation?.tools, ["read", "grep", "find", "ls"]);
	assert.equal(invocation?.files?.length, 2);
	assert.equal(invocation?.files?.[0], agentsPath);
	const requestPath = invocation?.files?.[1];
	assert.ok(requestPath);
	const requestContext = await readFile(requestPath as string, "utf8");
	assert.match(requestContext, /## Raw implementation request/);
	assert.match(requestContext, /Add a standalone \/sync command and keep the UI minimal\./);
	assert.match(requestContext, /## Additional instructions/);
	assert.match(requestContext, /Reuse the existing command patterns\./);
});
