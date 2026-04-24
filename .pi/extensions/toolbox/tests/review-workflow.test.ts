import test from "node:test";
import assert from "node:assert/strict";
import {
	buildFindingDecisionPrompt,
	buildFindingsOverviewPrompt,
	buildModelReviewPrompt,
	chooseBestReferenceMatch,
	getReviewThinkingLevel,
	deduplicateReviewFindings,
	parseRecentChangeCount,
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

test("getReviewThinkingLevel forces gpt-5.4 reviewers to xhigh", () => {
	assert.equal(getReviewThinkingLevel("openai-codex/gpt-5.4", "high"), "xhigh");
	assert.equal(getReviewThinkingLevel("OPENAI-CODEX/GPT-5.4", "low"), "xhigh");
	assert.equal(getReviewThinkingLevel("zai-coding-plan/glm-5.1", "high"), "high");
	assert.equal(getReviewThinkingLevel("zai-coding-plan/glm-5.1"), undefined);
});

test("parseReviewRequest splits optional scope and focus text", () => {
	assert.deepEqual(parseReviewRequest(""), { rawText: "", scopeText: "", focusText: "" });
	assert.deepEqual(parseReviewRequest("for security"), { rawText: "for security", scopeText: "", focusText: "security" });
	assert.deepEqual(parseReviewRequest("the two last changes"), {
		rawText: "the two last changes",
		scopeText: "the two last changes",
		focusText: "",
	});
	assert.deepEqual(
		parseReviewRequest("all changes since the past prod bookmark with an extra focus on security"),
		{
			rawText: "all changes since the past prod bookmark with an extra focus on security",
			scopeText: "all changes since the past prod bookmark",
			focusText: "security",
		},
	);
});

test("parseRecentChangeCount understands common recent-change phrasings", () => {
	assert.equal(parseRecentChangeCount("latest change"), 1);
	assert.equal(parseRecentChangeCount("last 3 commits"), 3);
	assert.equal(parseRecentChangeCount("the two last changes"), 2);
	assert.equal(parseRecentChangeCount("all changes since main"), null);
});

test("chooseBestReferenceMatch favors exact and fuzzy local ref matches", () => {
	assert.equal(chooseBestReferenceMatch("main", ["origin/main", "main"]), "main");
	assert.equal(chooseBestReferenceMatch("the past prod bookmark", ["origin/past-prod", "past-prod", "main"]), "past-prod");
	assert.equal(chooseBestReferenceMatch("missing ref", ["main", "origin/main"]), null);
});

test("buildModelReviewPrompt includes requested scope and focus instructions", () => {
	const prompt = buildModelReviewPrompt({
		label: "changes since past-prod",
		repoRoot: "/repo",
		reviewCwd: "/repo",
		changedFiles: ["src/run.ts"],
		attachments: [],
		requestedScope: "all changes since the past prod bookmark",
		focusText: "security",
	});
	assert.match(prompt, /attached diff already reflects this requested scope: all changes since the past prod bookmark/i);
	assert.match(prompt, /Extra requested review focus: security/i);
	assert.match(prompt, /Return JSON only\.$/);
});
