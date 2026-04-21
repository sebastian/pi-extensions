import test from "node:test";
import assert from "node:assert/strict";
import { deduplicateReviewFindings } from "../review-workflow.ts";

test("deduplicateReviewFindings merges overlapping findings from different reviewer models", () => {
	const findings = deduplicateReviewFindings([
		{
			model: "openai-codex/gpt-5.3-codex",
			findings: [
				{
					id: "a",
					category: "regression",
					severity: "medium",
					summary: "Skipping empty arrays breaks the zero-result UI",
					details: "The new guard returns early and never renders the empty state.",
					suggestedFix: "Keep the empty-state branch reachable.",
					paths: ["src/ui.ts"],
				},
			],
		},
		{
			model: "zai-coding-plan/glm-5.1",
			findings: [
				{
					id: "b",
					category: "regression",
					severity: "high",
					summary: "Zero-result state no longer renders for empty arrays",
					details: "The early return skips the existing empty-state rendering path.",
					suggestedFix: "Preserve the empty-state render path when the collection is empty.",
					paths: ["src/ui.ts"],
				},
			],
		},
	]);

	assert.equal(findings.length, 1);
	assert.equal(findings[0].severity, "high");
	assert.deepEqual(
		findings[0].reporters.map((reporter) => reporter.model),
		["openai-codex/gpt-5.3-codex", "zai-coding-plan/glm-5.1"],
	);
	assert.deepEqual(findings[0].paths, ["src/ui.ts"]);
});

test("deduplicateReviewFindings keeps distinct categories separate", () => {
	const findings = deduplicateReviewFindings([
		{
			model: "openai-codex/gpt-5.3-codex",
			findings: [
				{
					id: "a",
					category: "security",
					severity: "high",
					summary: "Input is interpolated into a shell command",
					details: "User-controlled text reaches bash without escaping.",
					suggestedFix: "Quote or avoid the shell entirely.",
					paths: ["src/run.ts"],
				},
			],
		},
		{
			model: "zai-coding-plan/glm-5.1",
			findings: [
				{
					id: "b",
					category: "regression",
					severity: "medium",
					summary: "Retry handling dropped the original error message",
					details: "The retry wrapper now throws a generic timeout error.",
					suggestedFix: "Preserve the original failure reason when retrying.",
					paths: ["src/run.ts"],
				},
			],
		},
	]);

	assert.equal(findings.length, 2);
	assert.equal(findings[0].category, "security");
	assert.equal(findings[1].category, "regression");
});
