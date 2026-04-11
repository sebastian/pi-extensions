import test from "node:test";
import assert from "node:assert/strict";
import { resolveWorkflowModelsFromRefs } from "../models.ts";

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

test("resolveWorkflowModelsFromRefs prefers GLM-5.1 only when gpt-5.3-codex is unavailable", () => {
	const models = resolveWorkflowModelsFromRefs(
		["openai-codex/gpt-5.4", "huggingface/zai-org/GLM-5.1"],
		"openai-codex/gpt-5.4",
	);
	assert.equal(models.primary, "openai-codex/gpt-5.4");
	assert.deepEqual(models.checkers, ["openai-codex/gpt-5.4", "huggingface/zai-org/GLM-5.1"]);
});
