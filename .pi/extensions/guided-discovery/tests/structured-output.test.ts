import test from "node:test";
import assert from "node:assert/strict";
import {
	extractJsonValue,
	hasMaterialDiscrepancies,
	parseCheckerReport,
	parseDecompositionPlan,
	parseValidationReport,
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
				{ command: "npm test", source: "CHECKS.md", status: "passed", summary: "all green" },
			],
			unresolvedRisks: ["watch migrations"],
			overallAssessment: "Looks mostly good",
		}),
	);

	assert.equal(report.findings.length, 1);
	assert.equal(report.checksRun[0].status, "passed");
	assert.equal(report.unresolvedRisks[0], "watch migrations");
});

test("parseValidationReport and hasMaterialDiscrepancies reflect missing work", () => {
	const report = parseValidationReport(
		JSON.stringify({
			coverage: [{ item: "Docs", status: "implemented", evidence: "Updated README", paths: ["README.md"] }],
			discrepancies: [{ item: "Tests", status: "missing", reason: "No tests added", suggestedAction: "Add tests" }],
			summary: "Implementation missed the tests",
			recommendation: "finish",
			materialDiscrepancies: true,
		}),
	);

	assert.equal(report.recommendation, "finish");
	assert.equal(hasMaterialDiscrepancies(report), true);
});
