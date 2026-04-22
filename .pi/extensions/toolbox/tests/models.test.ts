import test from "node:test";
import assert from "node:assert/strict";
import { resolveReviewModelsFromRefs, resolveWorkflowModelsFromRefs } from "../models.ts";

test("resolveWorkflowModelsFromRefs prefers gpt-5.4 as the primary workflow model", () => {
	const models = resolveWorkflowModelsFromRefs(
		[
			"openai-codex/gpt-5.3-codex",
			"openai-codex/gpt-5.4",
			"huggingface/zai-org/GLM-5.1",
		],
		"openai-codex/gpt-5.3-codex",
	);

	assert.equal(models.primary, "openai-codex/gpt-5.4");
	assert.deepEqual(models.checkers, ["openai-codex/gpt-5.4", "openai-codex/gpt-5.3-codex"]);
});

test("resolveWorkflowModelsFromRefs falls back to current model when gpt-5.4 is unavailable", () => {
	const models = resolveWorkflowModelsFromRefs(["openai-codex/gpt-5.3-codex"], "openai-codex/gpt-5.3-codex");
	assert.equal(models.primary, "openai-codex/gpt-5.3-codex");
	assert.deepEqual(models.checkers, ["openai-codex/gpt-5.3-codex"]);
});

test("resolveWorkflowModelsFromRefs uses GLM-5.1 as the lone checker when it is the only available model", () => {
	const models = resolveWorkflowModelsFromRefs(["huggingface/zai-org/GLM-5.1"], undefined);
	assert.equal(models.primary, "huggingface/zai-org/GLM-5.1");
	assert.deepEqual(models.checkers, ["huggingface/zai-org/GLM-5.1"]);
});

test("resolveWorkflowModelsFromRefs recognizes the dedicated Z.AI coding-plan provider", () => {
	const models = resolveWorkflowModelsFromRefs(["zai-coding-plan/glm-5.1"], undefined);
	assert.equal(models.primary, "zai-coding-plan/glm-5.1");
	assert.deepEqual(models.checkers, ["zai-coding-plan/glm-5.1"]);
});

test("resolveWorkflowModelsFromRefs prefers the dedicated coding-plan GLM-5.1 before other GLM providers", () => {
	const models = resolveWorkflowModelsFromRefs(
		["openai-codex/gpt-5.4", "huggingface/zai-org/GLM-5.1", "zai-coding-plan/glm-5.1"],
		"openai-codex/gpt-5.4",
	);
	assert.equal(models.primary, "openai-codex/gpt-5.4");
	assert.deepEqual(models.checkers, ["openai-codex/gpt-5.4", "zai-coding-plan/glm-5.1"]);
});

test("resolveReviewModelsFromRefs picks the two other strongest models besides the current implementation model", () => {
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
	assert.deepEqual(models.reviewers, ["openai-codex/gpt-5.3-codex", "zai-coding-plan/glm-5.1"]);
});

test("resolveReviewModelsFromRefs keeps the current implementation model even when it is not the top-ranked default", () => {
	const models = resolveReviewModelsFromRefs(
		[
			"custom/provider-model",
			"openai-codex/gpt-5.4",
			"openai-codex/gpt-5.3-codex",
			"zai-coding-plan/glm-5.1",
		],
		"custom/provider-model",
	);
	assert.equal(models.implementation, "custom/provider-model");
	assert.deepEqual(models.reviewers, ["openai-codex/gpt-5.4", "openai-codex/gpt-5.3-codex"]);
});
