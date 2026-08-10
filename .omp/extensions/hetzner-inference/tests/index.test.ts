import assert from "node:assert/strict";
import test from "node:test";
import hetznerInference from "../index.ts";

interface RegisteredProvider {
	baseUrl: string;
	apiKey: string;
	api: string;
	authHeader: boolean;
	fetchDynamicModels: (apiKey: string | undefined) => Promise<readonly unknown[]>;
}

test("registers every model returned by Hetzner", async (t) => {
	let providerName: string | undefined;
	let providerConfig: RegisteredProvider | undefined;
	hetznerInference({
		registerProvider(name: string, config: RegisteredProvider) {
			providerName = name;
			providerConfig = config;
		},
	} as never);

	t.mock.method(globalThis, "fetch", async (input, init) => {
		assert.equal(input, "https://inference.hetzner.com/api/v1/models");
		assert.equal(
			new Headers(init?.headers).get("Authorization"),
			"Bearer test-key",
		);
		return new Response(
			JSON.stringify({
				data: [
					{
						id: "Qwen/Qwen3.6-35B-A3B-FP8",
						max_model_len: 262_144,
					},
				],
			}),
		);
	});

	assert.equal(providerName, "hetzner");
	assert.ok(providerConfig);
	assert.equal(providerConfig.baseUrl, "https://inference.hetzner.com/api/v1");
	assert.equal(providerConfig.apiKey, "HETZNER_API_KEY");
	assert.equal(providerConfig.api, "openai-completions");
	assert.equal(providerConfig.authHeader, true);
	assert.deepEqual(await providerConfig.fetchDynamicModels("test-key"), [
		{
			id: "Qwen/Qwen3.6-35B-A3B-FP8",
			name: "Qwen3.6-35B-A3B-FP8",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 262_144,
			maxTokens: 32_768,
		},
	]);
});
