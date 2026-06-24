import test from "node:test";
import assert from "node:assert/strict";
import zaiCodingPlan, {
	applyConservativeZaiContextWindow,
	GLM_5_EFFECTIVE_CONTEXT_WINDOW,
	hasUsageError,
	ZAI_CODING_PLAN_BASE_URL,
	ZAI_PROVIDER_ID,
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
		model: { provider: ZAI_PROVIDER_ID, id: "glm-5.1", baseUrl: ZAI_CODING_PLAN_BASE_URL, reasoning: true, contextWindow: 200_000 },
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

test("uses the built-in zai provider instead of registering a custom provider", () => {
	const { pi, providerRegistrations } = createPiStub();
	zaiCodingPlan(pi as never);
	assert.deepEqual(providerRegistrations, []);
});

test("clamps only built-in zai/glm-5.1 and zai/glm-5.2 context windows", () => {
	const glm52 = { provider: ZAI_PROVIDER_ID, id: "glm-5.2", contextWindow: 1_000_000 };
	assert.equal(applyConservativeZaiContextWindow(glm52), true);
	assert.equal(glm52.contextWindow, GLM_5_EFFECTIVE_CONTEXT_WINDOW);

	const glm51 = { provider: ZAI_PROVIDER_ID, id: "glm-5.1", contextWindow: 200_000 };
	assert.equal(applyConservativeZaiContextWindow(glm51), true);
	assert.equal(glm51.contextWindow, GLM_5_EFFECTIVE_CONTEXT_WINDOW);

	const alreadySmaller = { provider: ZAI_PROVIDER_ID, id: "glm-5.2", contextWindow: 80_000 };
	assert.equal(applyConservativeZaiContextWindow(alreadySmaller), false);
	assert.equal(alreadySmaller.contextWindow, 80_000);

	const otherZai = { provider: ZAI_PROVIDER_ID, id: "glm-5-turbo", contextWindow: 200_000 };
	assert.equal(applyConservativeZaiContextWindow(otherZai), false);
	assert.equal(otherZai.contextWindow, 200_000);

	const legacyCustomProvider = { provider: "zai-coding-plan", id: "glm-5.2", contextWindow: 1_000_000 };
	assert.equal(applyConservativeZaiContextWindow(legacyCustomProvider), false);
	assert.equal(legacyCustomProvider.contextWindow, 1_000_000);
});

test("built-in zai/glm-5.1 gets concise and less-sycophantic prompt nudging plus conservative window", async () => {
	const { pi, getHandlers } = createPiStub();
	zaiCodingPlan(pi as never);

	const model = { provider: ZAI_PROVIDER_ID, id: "glm-5.1", contextWindow: 200_000 };
	const [handler] = getHandlers<(event: { systemPrompt: string }, ctx: { model?: typeof model }) => Promise<{ systemPrompt: string } | undefined>>("before_agent_start");
	const result = await handler({ systemPrompt: "Base instructions" }, { model });

	assert.ok(result);
	assert.equal(model.contextWindow, GLM_5_EFFECTIVE_CONTEXT_WINDOW);
	assert.ok(result.systemPrompt.startsWith("Base instructions\n\n- Be concise, direct, and matter-of-fact."));
	assert.match(result.systemPrompt, /Do not be flattering, sycophantic, or overly eager to please\./);
});

test("built-in zai/glm-5.2 gets the same prompt nudge as 5.1", async () => {
	const { pi, getHandlers } = createPiStub();
	zaiCodingPlan(pi as never);

	const [handler] = getHandlers<(event: { systemPrompt: string }, ctx: { model?: { provider?: string; id?: string; contextWindow?: number } }) => Promise<{ systemPrompt: string } | undefined>>("before_agent_start");
	const result = await handler({ systemPrompt: "Base instructions" }, { model: { provider: ZAI_PROVIDER_ID, id: "glm-5.2", contextWindow: 1_000_000 } });
	assert.ok(result);
	assert.ok(result.systemPrompt.includes("Do not be flattering, sycophantic, or overly eager to please."));
});

test("non-tuned models are left unchanged", async () => {
	const { pi, getHandlers } = createPiStub();
	zaiCodingPlan(pi as never);

	const [handler] = getHandlers<(event: { systemPrompt: string }, ctx: { model?: { provider?: string; id?: string; contextWindow?: number } }) => Promise<{ systemPrompt: string } | undefined>>("before_agent_start");
	assert.equal(await handler({ systemPrompt: "Base instructions" }, { model: { provider: ZAI_PROVIDER_ID, id: "glm-5-turbo", contextWindow: 200_000 } }), undefined);
	assert.equal(await handler({ systemPrompt: "Base instructions" }, { model: { provider: "other-provider", id: "glm-5.1", contextWindow: 200_000 } }), undefined);
});

test("hasUsageError accepts successful live quota payloads that use code 200", () => {
	assert.equal(hasUsageError({ code: 200, msg: "Operation successful", success: true }), false);
	assert.equal(hasUsageError({ code: 1001, msg: "Authentication parameter not received", success: false }), true);
});

test("usage tracker uses status only, clamps official GLM context, and clears it on shutdown", async () => {
	const { pi, getHandlers } = createPiStub();
	zaiCodingPlan(pi as never);

	const statuses: Array<{ key: string; text: string | undefined }> = [];
	const model = { provider: ZAI_PROVIDER_ID, id: "glm-5.2", baseUrl: ZAI_CODING_PLAN_BASE_URL, reasoning: true, contextWindow: 1_000_000 };
	const ctx = createUsageCtx({
		model,
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
	assert.equal(model.contextWindow, GLM_5_EFFECTIVE_CONTEXT_WINDOW);
	assert.deepEqual(statuses[0], { key: "zai-usage-indicator", text: "◌ z.ai quota…" });

	await getHandlers<(event: unknown, ctx: any) => Promise<void>>("session_shutdown")[0]({}, ctx);
	assert.deepEqual(statuses.at(-1), { key: "zai-usage-indicator", text: undefined });
});
