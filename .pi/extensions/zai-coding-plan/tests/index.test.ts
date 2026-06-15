import test from "node:test";
import assert from "node:assert/strict";
import zaiCodingPlan, {
	hasUsageError,
	registerZaiCodingPlan,
	ZAI_CODING_PLAN_API_KEY_CONFIG,
	ZAI_CODING_PLAN_API_KEY_ENV,
	ZAI_CODING_PLAN_BASE_URL,
	ZAI_CODING_PLAN_MODELS,
	ZAI_CODING_PLAN_PROVIDER_ID,
} from "../index.ts";

function createPiStub() {
	const providerRegistrations: Array<{ id: string; config: Record<string, unknown> }> = [];
	const handlers = new Map<string, Function[]>();

	return {
		pi: {
			registerProvider(id: string, config: Record<string, unknown>) {
				providerRegistrations.push({ id, config });
			},
			on(event: string, handler: Function) {
				handlers.set(event, [...(handlers.get(event) ?? []), handler]);
			},
		},
		providerRegistrations,
		getHandlers<T extends Function>(event: string): T[] {
			return (handlers.get(event) ?? []) as T[];
		},
	};
}

function createUsageCtx(overrides: Record<string, unknown> = {}) {
	return {
		hasUI: true,
		model: { provider: ZAI_CODING_PLAN_PROVIDER_ID, id: "glm-5.1", baseUrl: ZAI_CODING_PLAN_BASE_URL, reasoning: true },
		ui: {
			theme: { fg: (_color: string, text: string) => text, bold: (text: string) => text },
			setStatus(_key: string, _text: string | undefined) {},
		},
		modelRegistry: {
			async getApiKeyAndHeaders() {
				return { ok: false, error: "auth not configured" };
			},
		},
		...overrides,
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
	assert.equal(config.name, "Z.AI Coding Plan");
	assert.equal(config.baseUrl, ZAI_CODING_PLAN_BASE_URL);
	assert.equal(config.apiKey, `$${ZAI_CODING_PLAN_API_KEY_ENV}`);
	assert.equal(config.apiKey, ZAI_CODING_PLAN_API_KEY_CONFIG);
	assert.equal(config.api, "openai-completions");
	assert.deepEqual(config.models, ZAI_CODING_PLAN_MODELS);
	assert.notEqual(config.models, ZAI_CODING_PLAN_MODELS);
	assert.notEqual((config.models as typeof ZAI_CODING_PLAN_MODELS)[0].thinkingLevelMap, ZAI_CODING_PLAN_MODELS[0].thinkingLevelMap);
	assert.notEqual((config.models as typeof ZAI_CODING_PLAN_MODELS)[0].compat, ZAI_CODING_PLAN_MODELS[0].compat);
});

test("glm-5.2 mirrors glm-5.1: conservative context window, boolean thinking, tool streaming", () => {
	const model = ZAI_CODING_PLAN_MODELS.find((entry) => entry.id === "glm-5.2");
	assert.ok(model);
	assert.equal(model.contextWindow, 116_384);
	assert.deepEqual(model.thinkingLevelMap, { minimal: null, low: null, medium: null, xhigh: null });
	assert.deepEqual(model.compat, { supportsDeveloperRole: false, thinkingFormat: "zai", zaiToolStream: true });
});

test("glm-5.1 uses a conservative context window and Z.AI tool streaming compat", () => {
	const model = ZAI_CODING_PLAN_MODELS.find((entry) => entry.id === "glm-5.1");
	assert.ok(model);
	assert.equal(model.contextWindow, 116_384);
	assert.deepEqual(model.thinkingLevelMap, { minimal: null, low: null, medium: null, xhigh: null });
	assert.deepEqual(model.compat, { supportsDeveloperRole: false, thinkingFormat: "zai", zaiToolStream: true });
});

test("glm-4.5-air keeps the older non-tool-streaming compat shape", () => {
	const model = ZAI_CODING_PLAN_MODELS.find((entry) => entry.id === "glm-4.5-air");
	assert.ok(model);
	assert.deepEqual(model.compat, { supportsDeveloperRole: false, thinkingFormat: "zai" });
});

test("GLM-5.1 gets extra instructions to stay concise and less eager to please", async () => {
	const { pi, getHandlers } = createPiStub();
	zaiCodingPlan(pi as never);

	const [handler] = getHandlers<(event: { systemPrompt: string }, ctx: { model?: { provider?: string; id?: string } }) => Promise<{ systemPrompt: string } | undefined>>("before_agent_start");
	const result = await handler({ systemPrompt: "Base instructions" }, { model: { provider: ZAI_CODING_PLAN_PROVIDER_ID, id: "glm-5.1" } });

	assert.ok(result);
	assert.ok(result.systemPrompt.startsWith("Base instructions\n\n- Be concise, direct, and matter-of-fact."));
	assert.match(result.systemPrompt, /Do not be flattering, sycophantic, or overly eager to please\./);
});

test("non-GLM-5.1 turns are left unchanged", async () => {
	const { pi, getHandlers } = createPiStub();
	zaiCodingPlan(pi as never);

	const [handler] = getHandlers<(event: { systemPrompt: string }, ctx: { model?: { provider?: string; id?: string } }) => Promise<{ systemPrompt: string } | undefined>>("before_agent_start");
	assert.equal(await handler({ systemPrompt: "Base instructions" }, { model: { provider: ZAI_CODING_PLAN_PROVIDER_ID, id: "glm-5-turbo" } }), undefined);
	assert.equal(await handler({ systemPrompt: "Base instructions" }, { model: { provider: "other-provider", id: "glm-5.1" } }), undefined);
});

test("GLM-5.2 gets the same concise/in-less-sycophantic nudge as 5.1", async () => {
	const { pi, getHandlers } = createPiStub();
	zaiCodingPlan(pi as never);

	const [handler] = getHandlers<(event: { systemPrompt: string }, ctx: { model?: { provider?: string; id?: string } }) => Promise<{ systemPrompt: string } | undefined>>("before_agent_start");
	const result = await handler({ systemPrompt: "Base instructions" }, { model: { provider: ZAI_CODING_PLAN_PROVIDER_ID, id: "glm-5.2" } });
	assert.ok(result);
	assert.ok(result.systemPrompt.includes("Do not be flattering, sycophantic, or overly eager to please."));
});

test("hasUsageError accepts successful live quota payloads that use code 200", () => {
	assert.equal(hasUsageError({ code: 200, msg: "Operation successful", success: true }), false);
	assert.equal(hasUsageError({ code: 1001, msg: "Authentication parameter not received", success: false }), true);
});

test("usage tracker uses status only and clears it on shutdown", async () => {
	const { pi, getHandlers } = createPiStub();
	zaiCodingPlan(pi as never);

	const statuses: Array<{ key: string; text: string | undefined }> = [];
	const ctx = createUsageCtx({
		ui: {
			theme: { fg: (_color: string, text: string) => text, bold: (text: string) => text },
			setStatus(key: string, text: string | undefined) {
				statuses.push({ key, text });
			},
			setFooter() {
				throw new Error("footer should not be used");
			},
			setWidget() {
				throw new Error("widget should not be used");
			},
		},
	});

	await getHandlers<(event: unknown, ctx: any) => Promise<void>>("session_start")[0]({}, ctx);
	assert.deepEqual(statuses[0], { key: "zai-usage-indicator", text: "◌ z.ai quota…" });

	await getHandlers<(event: unknown, ctx: any) => Promise<void>>("session_shutdown")[0]({}, ctx);
	assert.deepEqual(statuses.at(-1), { key: "zai-usage-indicator", text: undefined });
});
