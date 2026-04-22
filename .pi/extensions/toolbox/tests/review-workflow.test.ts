import test from "node:test";
import assert from "node:assert/strict";
import {
	buildFindingDecisionPrompt,
	buildFindingsOverviewPrompt,
	deduplicateReviewFindings,
} from "../review-workflow.ts";

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

test("review finding prompts include the full finding list and details", () => {
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

	const overviewPrompt = buildFindingsOverviewPrompt(findings);
	assert.match(overviewPrompt, /Review finished\. Deduplicated findings \(2\):/);
	assert.match(overviewPrompt, /\[HIGH\] \[security\] Input is interpolated into a shell command/);
	assert.match(overviewPrompt, /User-controlled text reaches bash without escaping\./);
	assert.match(overviewPrompt, /Quote or avoid the shell entirely\./);
	assert.match(overviewPrompt, /\[MEDIUM\] \[regression\] Retry handling dropped the original error message/);
	assert.match(overviewPrompt, /Preserve the original failure reason when retrying\./);
	assert.match(overviewPrompt, /What should happen with these findings\?/);

	const decisionPrompt = buildFindingDecisionPrompt(0, findings[0]!);
	assert.match(decisionPrompt, /Reported by: openai-codex\/gpt-5\.3-codex/);
	assert.match(decisionPrompt, /Combined suggested fix: Quote or avoid the shell entirely\./);
	assert.match(decisionPrompt, /Address this finding\?/);
});
