import test from "node:test";
import assert from "node:assert/strict";
import {
	extractJsonValue,
	hasMaterialDiscrepancies,
	parseCheckerReport,
	parseDecompositionPlan,
	parseValidationReport,
	resolveValidationDiscrepancyId,
} from "../structured-output.ts";

test("extractJsonValue tolerates fenced JSON", () => {
	const value = extractJsonValue('```json\n{"ok":true}\n```') as { ok: boolean };
	assert.equal(value.ok, true);
});

test("parseDecompositionPlan accepts alias fields and normalizes phases", () => {
	const plan = parseDecompositionPlan(
		JSON.stringify({
			phases: [
				{
					name: "Phase 1",
					objective: "Do the work",
					steps: ["Step A"],
					dependencies: ["phase-0"],
					paths: ["src/index.ts"],
					canParallelize: false,
				},
			],
			notes: ["note"],
		}),
	);

	assert.equal(plan.phases[0].title, "Phase 1");
	assert.equal(plan.phases[0].goal, "Do the work");
	assert.deepEqual(plan.phases[0].instructions, ["Step A"]);
	assert.deepEqual(plan.phases[0].dependsOn, ["phase-0"]);
	assert.deepEqual(plan.phases[0].touchedPaths, ["src/index.ts"]);
	assert.equal(plan.phases[0].parallelSafe, false);
	assert.equal(plan.phases[0].designSensitive, false);
});

test("parseDecompositionPlan normalizes design-sensitive metadata conservatively", () => {
	const plan = parseDecompositionPlan(
		JSON.stringify({
			phases: [
				{
					title: "Refresh onboarding UI",
					goal: "Improve onboarding clarity",
					instructions: ["Update the onboarding screen"],
					touchedPaths: ["src/ui/onboarding.tsx"],
					designSensitive: true,
					parallelSafe: false,
				},
				{
					title: "Tighten navigation affordances",
					goal: "Make the next step clearer",
					instructions: ["Adjust navigation labels and affordances"],
					touchedPaths: ["src/ui/navigation.tsx"],
					needsDesignReview: "true",
					parallelSafe: false,
				},
				{
					title: "Refactor helper",
					goal: "Simplify a non-UI helper",
					instructions: ["Refactor helper"],
					touchedPaths: ["src/lib/helper.ts"],
					parallelSafe: true,
				},
			],
		}),
	);

	assert.equal(plan.phases[0].designSensitive, true);
	assert.equal(plan.phases[1].designSensitive, true);
	assert.equal(plan.phases[2].designSensitive, false);
});

test("parseCheckerReport validates findings and check runs", () => {
	const report = parseCheckerReport(
		JSON.stringify({
			findings: [
				{
					category: "security",
					severity: "high",
					summary: "Escaped issue",
					details: "Missing validation",
					suggestedFix: "Validate input",
					paths: ["src/app.ts"],
				},
			],
			checksRun: [
				{ command: "model-review", source: "openai-codex/gpt-5.4", status: "passed", summary: "all green" },
			],
			unresolvedRisks: ["watch migrations"],
			overallAssessment: "Looks mostly good",
		}),
	);

	assert.equal(report.findings.length, 1);
	assert.equal(report.checksRun[0].status, "passed");
	assert.equal(report.unresolvedRisks[0], "watch migrations");
});

test("parseCheckerReport normalizes category and severity aliases", () => {
	const report = parseCheckerReport(
		JSON.stringify({
			findings: [
				{
					category: "guidance",
					severity: "critical",
					summary: "Repo instruction missed",
					details: "AGENTS guidance was ignored",
					suggestedFix: "Follow AGENTS",
					paths: ["src/app.ts"],
				},
			],
			checksRun: [],
			unresolvedRisks: [],
			overallAssessment: "Needs a follow-up",
		}),
	);

	assert.equal(report.findings[0].category, "guidance");
	assert.equal(report.findings[0].severity, "high");
});

test("parseCheckerReport normalizes design-review and cleanup aliases", () => {
	const report = parseCheckerReport(
		JSON.stringify({
			findings: [
				{
					category: "accessibility",
					severity: "warning",
					summary: "Text is hard to scan",
					details: "The new UI copy is overly dense",
					suggestedFix: "Tighten the copy and improve hierarchy",
					paths: ["src/ui/screen.tsx"],
				},
				{
					category: "legacy",
					severity: "minor",
					summary: "Old helper is still wired in",
					details: "Superseded cleanup code was left behind",
					suggestedFix: "Remove the legacy helper",
					paths: ["src/lib/legacy.ts"],
				},
				{
					category: "cognitive-load",
					severity: "major",
					summary: "Too many competing controls",
					details: "The flow adds unnecessary decision points",
					suggestedFix: "Reduce the number of controls and steps",
					paths: ["src/ui/flow.tsx"],
				},
			],
			checksRun: [],
			unresolvedRisks: [],
			overallAssessment: "Needs cleanup and polish",
		}),
	);

	assert.deepEqual(
		report.findings.map((finding) => finding.category),
		["ui", "loose_ends", "complexity"],
	);
	assert.deepEqual(
		report.findings.map((finding) => finding.severity),
		["medium", "low", "high"],
	);
});


test("parseCheckerReport recognizes usability and workflow aliases as ui and guidance", () => {
	const report = parseCheckerReport(
		JSON.stringify({
			findings: [
				{
					category: "usability",
					severity: "warning",
					summary: "The primary action is easy to miss",
					details: "Wayfinding is still weak",
					suggestedFix: "Clarify the primary action",
					paths: ["src/ui/home.tsx"],
				},
				{
					category: "workflow_violation",
					severity: "critical",
					summary: "Required repository process was skipped",
					details: "A required repository-authored check was ignored",
					suggestedFix: "Follow the documented workflow",
					paths: ["AGENTS.md"],
				},
			],
			checksRun: [],
			unresolvedRisks: [],
			overallAssessment: "Needs a follow-up",
		}),
	);

	assert.equal(report.findings[0].category, "ui");
	assert.equal(report.findings[1].category, "guidance");
	assert.equal(report.findings[1].severity, "high");
});

test("parseValidationReport keeps explicit discrepancy ids and worthiness metadata", () => {
	const report = parseValidationReport(
		JSON.stringify({
			coverage: [{ item: "Docs", status: "implemented", evidence: "Updated README", paths: ["README.md"] }],
			discrepancies: [
				{
					id: "D-tests",
					item: "Tests",
					status: "missing",
					reason: "No tests added",
					worthImplementingNow: true,
					worthwhileRationale: "Small, direct follow-up that closes the requested scope.",
					suggestedAction: "Add tests",
				},
			],
			summary: "Implementation missed the tests",
			recommendation: "finish",
			materialDiscrepancies: true,
		}),
	);

	assert.equal(report.recommendation, "finish");
	assert.equal(report.discrepancies[0].id, "D-tests");
	assert.equal(report.discrepancies[0].worthImplementingNow, true);
	assert.equal(report.discrepancies[0].worthwhileRationale, "Small, direct follow-up that closes the requested scope.");
	assert.equal(hasMaterialDiscrepancies(report), true);
});

test("resolveValidationDiscrepancyId uses explicit ids first and stable fallbacks otherwise", () => {
	assert.equal(resolveValidationDiscrepancyId({ id: "D-tests", item: "Tests" }, 0), "D-tests");
	assert.equal(resolveValidationDiscrepancyId({ id: "", item: "Tests" }, 0), "discrepancy-tests");
	assert.equal(resolveValidationDiscrepancyId({ item: "" }, 2), "discrepancy-3");
});

test("parseValidationReport normalizes discrepancy aliases and defaults", () => {
	const report = parseValidationReport(
		JSON.stringify({
			coverage: [],
			discrepancies: [
				{
					discrepancyId: "D-docs",
					planItem: "Docs",
					status: "partial",
					whyNotDone: "Runtime behavior landed first.",
					worthwhileNow: "yes",
					recommendedAction: "Document the final behavior",
				},
			],
			summary: "Docs are incomplete",
			recommendation: "finish",
			materialDiscrepancies: true,
		}),
	);

	assert.equal(report.discrepancies[0].id, "D-docs");
	assert.equal(report.discrepancies[0].item, "Docs");
	assert.equal(report.discrepancies[0].reason, "Runtime behavior landed first.");
	assert.equal(report.discrepancies[0].suggestedAction, "Document the final behavior");
	assert.equal(report.discrepancies[0].worthImplementingNow, true);
	assert.equal(report.discrepancies[0].worthwhileRationale, "Marked worthwhile to implement now, but no rationale was provided.");
});

test("parseValidationReport remains backward compatible with older discrepancy output", () => {
	const report = parseValidationReport(
		JSON.stringify({
			coverage: [{ item: "Docs", status: "implemented", evidence: "Updated README", paths: ["README.md"] }],
			discrepancies: [{ item: "Tests", status: "missing", reason: "No tests added", suggestedAction: "Add tests" }],
			summary: "Implementation missed the tests",
			recommendation: "finish",
			materialDiscrepancies: true,
		}),
	);

	assert.equal(report.discrepancies[0].id, "discrepancy-tests");
	assert.equal(report.discrepancies[0].worthImplementingNow, false);
	assert.equal(
		report.discrepancies[0].worthwhileRationale,
		"No worthwhile-now judgment was provided, so this item should not be auto-implemented without review.",
	);
	assert.equal(hasMaterialDiscrepancies(report), true);
});

test("parseValidationReport makes fallback discrepancy ids unique", () => {
	const report = parseValidationReport(
		JSON.stringify({
			coverage: [],
			discrepancies: [
				{ item: "Tests", status: "missing", reason: "No tests added", suggestedAction: "Add tests" },
				{ item: "Tests", status: "partial", reason: "Only one test added", suggestedAction: "Add more tests" },
			],
			summary: "Tests are incomplete",
			recommendation: "finish",
			materialDiscrepancies: true,
		}),
	);

	assert.deepEqual(
		report.discrepancies.map((discrepancy) => discrepancy.id),
		["discrepancy-tests", "discrepancy-tests-2"],
	);
});
