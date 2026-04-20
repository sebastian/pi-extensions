import test from "node:test";
import assert from "node:assert/strict";
import zaiCodingPlan, {
	registerZaiCodingPlan,
	ZAI_CODING_PLAN_API_KEY_ENV,
	ZAI_CODING_PLAN_BASE_URL,
	ZAI_CODING_PLAN_MODELS,
	ZAI_CODING_PLAN_PROVIDER_ID,
} from "../index.ts";

type BeforeAgentStartHandler = (
	event: { systemPrompt: string },
	ctx: { model?: { provider?: string; id?: string } },
) => Promise<{ systemPrompt: string } | undefined> | { systemPrompt: string } | undefined;

function createPiStub() {
	const providerRegistrations: Array<{ id: string; config: Record<string, unknown> }> = [];
	const beforeAgentStartHandlers: BeforeAgentStartHandler[] = [];

	return {
		pi: {
			registerProvider(id: string, config: Record<string, unknown>) {
				providerRegistrations.push({ id, config });
			},
			on(event: string, handler: BeforeAgentStartHandler) {
				if (event === "before_agent_start") beforeAgentStartHandlers.push(handler);
			},
		},
		providerRegistrations,
		beforeAgentStartHandlers,
	};
}

test("registerZaiCodingPlan registers the coding-plan provider with cloned models", () => {
	const providerRegistrations: Array<{ id: string; config: Record<string, unknown> }> = [];

	registerZaiCodingPlan({
		registerProvider(id, config) {
			providerRegistrations.push({ id, config: config as Record<string, unknown> });
		},
	} as never);

	assert.equal(providerRegistrations.length, 1);

	const [{ id, config }] = providerRegistrations;
	assert.equal(id, ZAI_CODING_PLAN_PROVIDER_ID);
	assert.equal(config.baseUrl, ZAI_CODING_PLAN_BASE_URL);
	assert.equal(config.apiKey, ZAI_CODING_PLAN_API_KEY_ENV);
	assert.equal(config.api, "openai-completions");
	assert.deepEqual(config.models, ZAI_CODING_PLAN_MODELS);
	assert.notEqual(config.models, ZAI_CODING_PLAN_MODELS);
	assert.notEqual((config.models as typeof ZAI_CODING_PLAN_MODELS)[0].compat, ZAI_CODING_PLAN_MODELS[0].compat);
});

test("glm-5.1 uses a conservative effective context window and Z.AI tool-call streaming compat", () => {
	const model = ZAI_CODING_PLAN_MODELS.find((entry) => entry.id === "glm-5.1");
	assert.ok(model);
	assert.equal(model.contextWindow, 116_384);
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

test("GLM-5.1 gets extra instructions to stay concise and less eager to please", async () => {
	const { pi, beforeAgentStartHandlers } = createPiStub();
	zaiCodingPlan(pi as never);

	assert.equal(beforeAgentStartHandlers.length, 1);

	const result = await beforeAgentStartHandlers[0](
		{ systemPrompt: "Base instructions" },
		{ model: { provider: ZAI_CODING_PLAN_PROVIDER_ID, id: "glm-5.1" } },
	);

	assert.ok(result);
	assert.ok(result.systemPrompt.startsWith("Base instructions\n\n- Be concise, direct, and matter-of-fact."));
	assert.match(result.systemPrompt, /Be concise, direct, and matter-of-fact\./);
	assert.match(result.systemPrompt, /Do not be flattering, sycophantic, or overly eager to please\./);
	assert.match(result.systemPrompt, /Avoid unnecessary praise, reassurance, or agreement\./);
});

test("non-GLM-5.1 turns are left unchanged", async () => {
	const { pi, beforeAgentStartHandlers } = createPiStub();
	zaiCodingPlan(pi as never);

	assert.equal(beforeAgentStartHandlers.length, 1);

	const handler = beforeAgentStartHandlers[0];
	assert.equal(
		await handler({ systemPrompt: "Base instructions" }, { model: { provider: ZAI_CODING_PLAN_PROVIDER_ID, id: "glm-5-turbo" } }),
		undefined,
	);
	assert.equal(
		await handler({ systemPrompt: "Base instructions" }, { model: { provider: "other-provider", id: "glm-5.1" } }),
		undefined,
	);
	assert.equal(await handler({ systemPrompt: "Base instructions" }, {}), undefined);
});
