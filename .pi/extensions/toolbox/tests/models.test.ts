import test from "node:test";
import assert from "node:assert/strict";
import { resolveReviewModelsFromRefs } from "../models.ts";

test("resolveReviewModelsFromRefs uses gpt-5.4 and GLM-5.2 when gpt-5.5 is the implementation model", () => {
	const models = resolveReviewModelsFromRefs(
		[
			"openai-codex/gpt-5.5",
			"openai-codex/gpt-5.4",
			"openai-codex/gpt-5.3-codex",
			"zai/glm-5.2",
			"huggingface/zai-org/GLM-5.2",
		],
		"openai-codex/gpt-5.5",
	);
	assert.equal(models.implementation, "openai-codex/gpt-5.5");
	assert.deepEqual(models.reviewers, ["openai-codex/gpt-5.4", "zai/glm-5.2"]);
});

test("resolveReviewModelsFromRefs falls back to GLM-5.1 when only 5.1 is available", () => {
	const models = resolveReviewModelsFromRefs(
		[
			"openai-codex/gpt-5.4",
			"openai-codex/gpt-5.3-codex",
			"zai/glm-5.1",
			"huggingface/zai-org/GLM-5.1",
		],
		"openai-codex/gpt-5.4",
	);
	assert.equal(models.implementation, "openai-codex/gpt-5.4");
	assert.deepEqual(models.reviewers, ["zai/glm-5.1", "openai-codex/gpt-5.3-codex"]);
});

test("resolveReviewModelsFromRefs prefers GLM-5.2 but never picks both 5.2 and 5.1 as reviewers", () => {
	const models = resolveReviewModelsFromRefs(
		[
			"openai-codex/gpt-5.4",
			"zai/glm-5.1",
			"zai/glm-5.2",
		],
		"openai-codex/gpt-5.4",
	);
	assert.deepEqual(models.reviewers, ["zai/glm-5.2", "zai/glm-5.1"].slice(0, 1));
	assert.equal(models.reviewers.length, 1);
	assert.equal(models.reviewers[0], "zai/glm-5.2");
});

test("resolveReviewModelsFromRefs keeps the current implementation model", () => {
	const models = resolveReviewModelsFromRefs(
		[
			"custom/provider-model",
			"openai-codex/gpt-5.5",
			"openai-codex/gpt-5.4",
			"zai/glm-5.2",
		],
		"custom/provider-model",
	);
	assert.equal(models.implementation, "custom/provider-model");
	assert.deepEqual(models.reviewers, ["openai-codex/gpt-5.4", "zai/glm-5.2"]);
});
