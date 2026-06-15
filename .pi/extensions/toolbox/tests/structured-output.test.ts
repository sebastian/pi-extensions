import test from "node:test";
import assert from "node:assert/strict";
import { extractJsonValue, parseCheckerReport } from "../structured-output.ts";

test("extractJsonValue tolerates fenced JSON", () => {
	const value = extractJsonValue('```json\n{"ok":true}\n```') as { ok: boolean };
	assert.equal(value.ok, true);
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

test("parseCheckerReport normalizes useful aliases", () => {
	const report = parseCheckerReport(
		JSON.stringify({
			findings: [
				{ category: "accessibility", severity: "warning", summary: "Dense UI", details: "Hard to scan", suggestedFix: "Tighten it", paths: ["ui.ts"] },
				{ category: "legacy", severity: "minor", summary: "Old helper", details: "Left behind", suggestedFix: "Remove it", paths: ["old.ts"] },
				{ category: "workflow_violation", severity: "critical", summary: "Missed AGENTS", details: "Skipped guidance", suggestedFix: "Follow it", paths: ["AGENTS.md"] },
			],
		}),
	);

	assert.deepEqual(report.findings.map((finding) => finding.category), ["ui", "loose_ends", "guidance"]);
	assert.deepEqual(report.findings.map((finding) => finding.severity), ["medium", "low", "high"]);
});
