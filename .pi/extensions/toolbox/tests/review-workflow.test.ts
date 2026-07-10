import test from "node:test";
import assert from "node:assert/strict";
import {
	buildFindingDecisionPrompt,
	buildFindingsOverviewPrompt,
	buildModelReviewPrompt,
	getReviewThinkingLevel,
	deduplicateReviewFindings,
	parseReviewRequest,
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
			model: "zai/glm-5.2",
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
	assert.deepEqual(findings[0].reporters.map((reporter) => reporter.model), ["openai-codex/gpt-5.3-codex", "zai/glm-5.2"]);
});

test("deduplicateReviewFindings keeps distinct categories separate", () => {
	const findings = deduplicateReviewFindings([
		{
			model: "openai-codex/gpt-5.3-codex",
			findings: [{ id: "a", category: "security", severity: "high", summary: "Shell injection", details: "Input reaches bash.", suggestedFix: "Avoid shell.", paths: ["src/run.ts"] }],
		},
		{
			model: "zai/glm-5.2",
			findings: [{ id: "b", category: "regression", severity: "medium", summary: "Retry loses error", details: "Throws generic timeout.", suggestedFix: "Preserve reason.", paths: ["src/run.ts"] }],
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
			findings: [{ id: "a", category: "security", severity: "high", summary: "Input is interpolated into a shell command", details: "User-controlled text reaches bash without escaping.", suggestedFix: "Quote or avoid the shell entirely.", paths: ["src/run.ts"] }],
		},
	]);

	assert.match(buildFindingsOverviewPrompt(findings), /Deduplicated findings \(1\):/);
	assert.match(buildFindingsOverviewPrompt(findings), /Quote or avoid the shell entirely\./);
	assert.match(buildFindingDecisionPrompt(0, findings[0]!), /Address this finding\?/);
});

test("getReviewThinkingLevel uses xhigh for GPT and max for GLM-5.2", () => {
	assert.equal(getReviewThinkingLevel("openai-codex/gpt-5.6-sol", "high"), "xhigh");
	assert.equal(getReviewThinkingLevel("openai/gpt-5.6-sol", "high"), "xhigh");
	assert.equal(getReviewThinkingLevel("OPENAI-CODEX/GPT-5.5", "low"), "xhigh");
	assert.equal(getReviewThinkingLevel("zai/glm-5.2", "high"), "max");
	assert.equal(getReviewThinkingLevel("openai-codex/gpt-5.4", "high"), "high");
	assert.equal(getReviewThinkingLevel("zai/glm-5.1"), undefined);
});

test("parseReviewRequest splits explicit scope and focus text", () => {
	assert.deepEqual(parseReviewRequest(""), { rawText: "", scopeText: "", focusText: "" });
	assert.deepEqual(parseReviewRequest("for security"), { rawText: "for security", scopeText: "", focusText: "security" });
	assert.deepEqual(parseReviewRequest("main..HEAD"), { rawText: "main..HEAD", scopeText: "main..HEAD", focusText: "" });
	assert.deepEqual(parseReviewRequest("main..HEAD with an extra focus on security"), {
		rawText: "main..HEAD with an extra focus on security",
		scopeText: "main..HEAD",
		focusText: "security",
	});
});

test("buildModelReviewPrompt includes requested scope and focus instructions", () => {
	const prompt = buildModelReviewPrompt({
		label: "main..HEAD",
		repoRoot: "/repo",
		reviewCwd: "/repo",
		changedFiles: ["src/run.ts"],
		attachments: [],
		requestedScope: "main..HEAD",
		focusText: "security",
	});
	assert.match(prompt, /attached diff already reflects this requested scope: main\.\.HEAD/i);
	assert.match(prompt, /Extra requested review focus: security/i);
	assert.match(prompt, /Return JSON only\.$/);
});
