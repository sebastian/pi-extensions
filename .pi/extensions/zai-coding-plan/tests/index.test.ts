import test from "node:test";
import assert from "node:assert/strict";
import zaiCodingPlan, {
	registerZaiCodingPlan,
	ZAI_CODING_PLAN_API_KEY_ENV,
	ZAI_CODING_PLAN_BASE_URL,
	ZAI_CODING_PLAN_MODELS,
	ZAI_CODING_PLAN_PROVIDER_ID,
} from "../index.ts";

test("registerZaiCodingPlan registers an explicit coding-plan provider", () => {
	let captured:
		| {
				name: string;
				config: Record<string, unknown>;
		  }
		| undefined;

	registerZaiCodingPlan({
		registerProvider(name, config) {
			captured = { name, config: config as Record<string, unknown> };
		},
	} as never);

	assert.ok(captured);
	assert.equal(captured.name, ZAI_CODING_PLAN_PROVIDER_ID);
	assert.equal(captured.config.baseUrl, ZAI_CODING_PLAN_BASE_URL);
	assert.equal(captured.config.apiKey, ZAI_CODING_PLAN_API_KEY_ENV);
	assert.equal(captured.config.api, "openai-completions");
	assert.deepEqual(
		(captured.config.models as Array<{ id: string }>).map((model) => model.id),
		ZAI_CODING_PLAN_MODELS.map((model) => model.id),
	);
});

test("newer coding-plan models enable Z.AI tool-call streaming compat", () => {
	const model = ZAI_CODING_PLAN_MODELS.find((entry) => entry.id === "glm-5.1");
	assert.ok(model);
	assert.deepEqual(model.compat, {
		supportsDeveloperRole: false,
		thinkingFormat: "zai",
		zaiToolStream: true,
	});
});

test("glm-4.5-air keeps the older non-tool-streaming compat shape", () => {
	const model = ZAI_CODING_PLAN_MODELS.find((entry) => entry.id === "glm-4.5-air");
	assert.ok(model);
	assert.deepEqual(model.compat, {
		supportsDeveloperRole: false,
		thinkingFormat: "zai",
	});
});

test("default export delegates to registerZaiCodingPlan", () => {
	let providerName: string | undefined;

	zaiCodingPlan({
		registerProvider(name) {
			providerName = name;
		},
	} as never);

	assert.equal(providerName, ZAI_CODING_PLAN_PROVIDER_ID);
});
