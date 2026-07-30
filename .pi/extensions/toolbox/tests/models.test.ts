import test from "node:test";
import assert from "node:assert/strict";
import { resolveReviewModels, resolveReviewModelsFromRefs } from "../models.ts";

const preferredModels = [
	"openai-codex/gpt-5.6-sol",
	"openai-codex/gpt-5.5",
	"zai/glm-5.2",
	"openai-codex/gpt-5.4",
];

test("uses GPT-5.5 and GLM-5.2 to review GPT-5.6 Sol implementations", () => {
	const models = resolveReviewModelsFromRefs(preferredModels, "openai-codex/gpt-5.6-sol");
	assert.equal(models.implementation, "openai-codex/gpt-5.6-sol");
	assert.deepEqual(models.reviewers, ["zai/glm-5.2", "openai-codex/gpt-5.5"]);
});

test("uses GPT-5.6 Sol and GLM-5.2 to review GPT-5.5 implementations", () => {
	const models = resolveReviewModelsFromRefs(preferredModels, "openai-codex/gpt-5.5");
	assert.equal(models.implementation, "openai-codex/gpt-5.5");
	assert.deepEqual(models.reviewers, ["openai-codex/gpt-5.6-sol", "zai/glm-5.2"]);
});

test("uses GPT-5.6 Sol and GPT-5.5 to review GLM-5.2 implementations", () => {
	const models = resolveReviewModelsFromRefs(preferredModels, "zai/glm-5.2");
	assert.equal(models.implementation, "zai/glm-5.2");
	assert.deepEqual(models.reviewers, ["openai-codex/gpt-5.6-sol", "openai-codex/gpt-5.5"]);
});

test("keeps a custom implementation model and picks cross-provider preferred reviewers", () => {
	const models = resolveReviewModelsFromRefs(["custom/provider-model", ...preferredModels], "custom/provider-model");
	assert.equal(models.implementation, "custom/provider-model");
	assert.deepEqual(models.reviewers, ["openai-codex/gpt-5.6-sol", "zai/glm-5.2"]);
});

test("prefers Codex aliases and falls back to direct OpenAI without duplicate model families", () => {
	const withCodex = resolveReviewModelsFromRefs(
		["custom/provider-model", "openai/gpt-5.6-sol", "openai-codex/gpt-5.6-sol", "openai/gpt-5.5", "zai/glm-5.2"],
		"custom/provider-model",
	);
	assert.deepEqual(withCodex.reviewers, ["openai-codex/gpt-5.6-sol", "zai/glm-5.2"]);

	const directOnly = resolveReviewModelsFromRefs(
		["custom/provider-model", "openai/gpt-5.6-sol", "openai/gpt-5.5", "zai/glm-5.2"],
		"custom/provider-model",
	);
	assert.deepEqual(directOnly.reviewers, ["openai/gpt-5.6-sol", "zai/glm-5.2"]);
});

test("honors the current session model scope", () => {
	const models = resolveReviewModels({
		model: { provider: "openai-codex", id: "gpt-5.5" },
		scopedModels: [
			{ model: { provider: "openai-codex", id: "gpt-5.5" } },
			{ model: { provider: "zai", id: "glm-5.2" } },
			{ model: { provider: "openai-codex", id: "gpt-5.4" } },
		],
		modelRegistry: { getAvailable: () => { throw new Error("scope should be used"); } },
	} as never);

	assert.deepEqual(models.reviewers, ["zai/glm-5.2", "openai-codex/gpt-5.4"]);
});

test("falls back to older preferred models when the new pool is unavailable", () => {
	const models = resolveReviewModelsFromRefs(
		["openai-codex/gpt-5.4", "openai-codex/gpt-5.3-codex", "zai/glm-5.1"],
		"openai-codex/gpt-5.4",
	);
	assert.deepEqual(models.reviewers, ["zai/glm-5.1", "openai-codex/gpt-5.3-codex"]);
});
