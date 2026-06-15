import test from "node:test";
import assert from "node:assert/strict";
import { resolveReviewModelsFromRefs } from "../models.ts";

test("resolveReviewModelsFromRefs uses gpt-5.4 and GLM-5.1 when gpt-5.5 is the implementation model", () => {
	const models = resolveReviewModelsFromRefs(
		[
			"openai-codex/gpt-5.5",
			"openai-codex/gpt-5.4",
			"openai-codex/gpt-5.3-codex",
			"zai-coding-plan/glm-5.1",
			"huggingface/zai-org/GLM-5.1",
		],
		"openai-codex/gpt-5.5",
	);
	assert.equal(models.implementation, "openai-codex/gpt-5.5");
	assert.deepEqual(models.reviewers, ["openai-codex/gpt-5.4", "zai-coding-plan/glm-5.1"]);
});

test("resolveReviewModelsFromRefs avoids selecting multiple GLM-5.1 provider aliases", () => {
	const models = resolveReviewModelsFromRefs(
		[
			"openai-codex/gpt-5.4",
			"openai-codex/gpt-5.3-codex",
			"zai-coding-plan/glm-5.1",
			"huggingface/zai-org/GLM-5.1",
		],
		"openai-codex/gpt-5.4",
	);
	assert.equal(models.implementation, "openai-codex/gpt-5.4");
	assert.deepEqual(models.reviewers, ["zai-coding-plan/glm-5.1", "openai-codex/gpt-5.3-codex"]);
});

test("resolveReviewModelsFromRefs keeps the current implementation model", () => {
	const models = resolveReviewModelsFromRefs(
		[
			"custom/provider-model",
			"openai-codex/gpt-5.5",
			"openai-codex/gpt-5.4",
			"zai-coding-plan/glm-5.1",
		],
		"custom/provider-model",
	);
	assert.equal(models.implementation, "custom/provider-model");
	assert.deepEqual(models.reviewers, ["openai-codex/gpt-5.4", "zai-coding-plan/glm-5.1"]);
});
