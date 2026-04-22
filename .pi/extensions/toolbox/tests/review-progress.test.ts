import test from "node:test";
import assert from "node:assert/strict";
import {
	createEmptyReviewUsageTotals,
	formatReviewProgressLines,
	summarizeReviewTool,
	type ReviewProgressSnapshot,
} from "../review-progress.ts";

test("formatReviewProgressLines shows reviewer state, reasoning, output, and usage", () => {
	const snapshot: ReviewProgressSnapshot = {
		targetLabel: "uncommitted changes",
		implementationModel: "anthropic/claude-sonnet-4-5",
		reviewerModels: ["openai/gpt-5.4", "zai/glm-5.1"],
		startedAt: 2_000,
		models: [
			{
				model: "openai/gpt-5.4",
				state: "running",
				currentTool: "read review-diff.patch",
				latestActivity: "reasoning about read review-diff.patch",
				latestOutput: "Still checking the rename path for regressions.",
				usage: { input: 400, output: 120, cacheRead: 0, cacheWrite: 0, totalTokens: 520, cost: 0, turns: 1 },
			},
			{
				model: "zai/glm-5.1",
				state: "done",
				findings: 2,
				overallAssessment: "Found two concrete regression risks.",
				latestOutput: "Found two concrete regression risks.",
				usage: { input: 800, output: 220, cacheRead: 0, cacheWrite: 0, totalTokens: 1020, cost: 0, turns: 2 },
			},
		],
	};

	const lines = formatReviewProgressLines(snapshot, 12_000);
	const rendered = lines.join("\n");

	assert.match(rendered, /Scope: uncommitted changes/);
	assert.match(rendered, /Implementation: anthropic\/claude-sonnet-4-5/);
	assert.match(rendered, /Progress: 1\/2 reviewers finished • elapsed 10s/);
	assert.match(rendered, /◉ openai\/gpt-5.4 — running • 1 turn • 520 tok/);
	assert.match(rendered, /Reasoning: reasoning about read review-diff.patch/);
	assert.match(rendered, /Tool: read review-diff.patch/);
	assert.match(rendered, /Output: Still checking the rename path for regressions\./);
	assert.match(rendered, /✓ zai\/glm-5.1 — done • 2 findings • 2 turns • 1.0k tok/);
	assert.match(rendered, /Reasoning: Found two concrete regression risks\./);
});

test("summarizeReviewTool prefers the most useful argument for reviewer progress", () => {
	assert.equal(summarizeReviewTool("read", { path: "src/review.ts" }), "read src/review.ts");
	assert.equal(summarizeReviewTool("bash", { command: "rg -n review src" }), "bash rg -n review src");
	assert.equal(summarizeReviewTool("grep", { pattern: "guided-review" }), "grep guided-review");
	assert.equal(summarizeReviewTool("find", { pattern: "*.md" }), "find *.md");
	assert.equal(summarizeReviewTool("custom", { query: "nearby flows" }), "custom nearby flows");
	assert.deepEqual(createEmptyReviewUsageTotals(), {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: 0,
		turns: 0,
	});
});
