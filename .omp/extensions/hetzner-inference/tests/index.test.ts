import assert from "node:assert/strict";
import test from "node:test";
import hetznerInference from "../index.ts";

interface RegisteredProvider {
	baseUrl: string;
	apiKey: string;
	api: string;
	authHeader: boolean;
	models: ReadonlyArray<{
		id: string;
		contextWindow: number;
		maxTokens: number;
	}>;
	fetchDynamicModels?: unknown;
}

test("registers picker-visible Hetzner models synchronously", () => {
	let providerName: string | undefined;
	let providerConfig: RegisteredProvider | undefined;
	hetznerInference({
		registerProvider(name: string, config: RegisteredProvider) {
			providerName = name;
			providerConfig = config;
		},
	} as never);

	assert.equal(providerName, "hetzner");
	assert.ok(providerConfig);
	assert.equal(providerConfig.baseUrl, "https://inference.hetzner.com/api/v1");
	assert.equal(providerConfig.apiKey, "HETZNER_API_KEY");
	assert.equal(providerConfig.api, "openai-completions");
	assert.equal(providerConfig.authHeader, true);
	assert.equal(providerConfig.fetchDynamicModels, undefined);
	assert.deepEqual(
		providerConfig.models.map(({ id, contextWindow, maxTokens }) => ({
			id,
			contextWindow,
			maxTokens,
		})),
		[
			{
				id: "DeepSeek-V4-Flash-0731",
				contextWindow: 512_000,
				maxTokens: 32_768,
			},
			{ id: "GLM-5.2-NVFP4", contextWindow: 512_000, maxTokens: 32_768 },
			{ id: "Kimi-K2.7-Code", contextWindow: 262_144, maxTokens: 32_768 },
			{
				id: "Qwen/Qwen3.6-35B-A3B-FP8",
				contextWindow: 262_144,
				maxTokens: 32_768,
			},
		],
	);
});
