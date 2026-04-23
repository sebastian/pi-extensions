import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import zaiCodingPlan, {
	hasUsageError,
	registerZaiCodingPlan,
	ZAI_CODING_PLAN_API_KEY_ENV,
	ZAI_CODING_PLAN_BASE_URL,
	ZAI_CODING_PLAN_MODELS,
	ZAI_CODING_PLAN_PROVIDER_ID,
} from "../index.ts";

function createPiStub(options?: {
	exec?: (command: string, args: string[], params?: { cwd?: string; timeout?: number }) => Promise<{
		stdout: string;
		stderr: string;
		code: number;
	}>;
}) {
	const providerRegistrations: Array<{ id: string; config: Record<string, unknown> }> = [];
	const handlers = new Map<string, Function[]>();

	return {
		pi: {
			registerProvider(id: string, config: Record<string, unknown>) {
				providerRegistrations.push({ id, config });
			},
			on(event: string, handler: Function) {
				const eventHandlers = handlers.get(event) ?? [];
				eventHandlers.push(handler);
				handlers.set(event, eventHandlers);
			},
			exec: options?.exec,
		},
		providerRegistrations,
		handlers,
		getHandlers<T extends Function>(event: string): T[] {
			return (handlers.get(event) ?? []) as T[];
		},
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
	const { pi, getHandlers } = createPiStub();
	zaiCodingPlan(pi as never);

	const beforeAgentStartHandlers = getHandlers<(
		event: { systemPrompt: string },
		ctx: { model?: { provider?: string; id?: string } },
	) => Promise<{ systemPrompt: string } | undefined>>("before_agent_start");
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
	const { pi, getHandlers } = createPiStub();
	zaiCodingPlan(pi as never);

	const beforeAgentStartHandlers = getHandlers<(
		event: { systemPrompt: string },
		ctx: { model?: { provider?: string; id?: string } },
	) => Promise<{ systemPrompt: string } | undefined>>("before_agent_start");
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

test("hasUsageError accepts successful live quota payloads that use code 200", () => {
	assert.equal(
		hasUsageError({
			code: 200,
			msg: "Operation successful",
			success: true,
			data: { limits: [{ type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 20 }] },
		}),
		false,
	);
	assert.equal(
		hasUsageError({
			code: 1001,
			msg: "Authentication parameter not received in Header, unable to authenticate",
			success: false,
		}),
		true,
	);
});

test("usage tracker uses footer integration and no widget row", async () => {
	const { pi, getHandlers } = createPiStub();
	zaiCodingPlan(pi as never);

	const sessionStartHandlers = getHandlers<(event: unknown, ctx: any) => Promise<void>>("session_start");
	assert.equal(sessionStartHandlers.length, 1);

	const statuses: Array<{ key: string; text: string | undefined }> = [];
	const widgets: Array<{ key: string; content: unknown }> = [];
	const footers: unknown[] = [];
	await sessionStartHandlers[0](
		{},
		{
			hasUI: true,
			model: { provider: ZAI_CODING_PLAN_PROVIDER_ID, id: "glm-5.1", baseUrl: ZAI_CODING_PLAN_BASE_URL, reasoning: true, contextWindow: 131072 },
			ui: {
				theme: { fg: (_color: string, text: string) => text, bold: (text: string) => text },
				setStatus(key: string, text: string | undefined) {
					statuses.push({ key, text });
				},
				setWidget(key: string, content: unknown) {
					widgets.push({ key, content });
				},
				setFooter(factory: unknown) {
					footers.push(factory);
				},
			},
			getContextUsage() {
				return { tokens: 1000, contextWindow: 131072, percent: 0.8 };
			},
			sessionManager: {
				getEntries() {
					return [];
				},
				getBranch() {
					return [];
				},
				getCwd() {
					return "/tmp/project";
				},
				getSessionName() {
					return undefined;
				},
			},
			modelRegistry: {
				isUsingOAuth() {
					return false;
				},
				async getApiKeyAndHeaders() {
					return { ok: false, error: "auth not configured" };
				},
			},
		},
	);

	assert.deepEqual(statuses[0], { key: "zai-usage-indicator", text: "◌ z.ai quota…" });
	assert.equal(widgets.length, 0);
	assert.equal(typeof footers[0], "function");
});

test("usage tracker does not touch stale session ui after shutdown", async () => {
	const { pi, getHandlers } = createPiStub();
	zaiCodingPlan(pi as never);

	const sessionStartHandlers = getHandlers<(event: unknown, ctx: any) => Promise<void>>("session_start");
	const sessionShutdownHandlers = getHandlers<(event: unknown, ctx: any) => Promise<void>>("session_shutdown");
	assert.equal(sessionStartHandlers.length, 1);
	assert.equal(sessionShutdownHandlers.length, 1);

	let resolveAuth:
		| ((value: { ok: false; error: string }) => void)
		| undefined;
	let staleStatusCalls = 0;
	let stale = false;
	const ctx = {
		hasUI: true,
		model: { provider: ZAI_CODING_PLAN_PROVIDER_ID, id: "glm-5.1", baseUrl: ZAI_CODING_PLAN_BASE_URL, reasoning: true, contextWindow: 131072 },
		ui: {
			theme: { fg: (_color: string, text: string) => text, bold: (text: string) => text },
			setStatus() {
				if (stale) staleStatusCalls += 1;
			},
			setWidget() {},
			setFooter() {},
		},
		getContextUsage() {
			return { tokens: 1000, contextWindow: 131072, percent: 0.8 };
		},
		sessionManager: {
			getEntries() {
				return [];
			},
			getBranch() {
				return [];
			},
			getCwd() {
				return "/tmp/project";
			},
			getSessionName() {
				return undefined;
			},
		},
		modelRegistry: {
			isUsingOAuth() {
				return false;
			},
			getApiKeyAndHeaders() {
				return new Promise<{ ok: false; error: string }>((resolve) => {
					resolveAuth = resolve;
				});
			},
		},
	};

	await sessionStartHandlers[0]({}, ctx);
	await sessionShutdownHandlers[0]({}, ctx);
	stale = true;
	resolveAuth?.({ ok: false, error: "auth not configured" });
	await new Promise((resolve) => setTimeout(resolve, 0));

	assert.equal(staleStatusCalls, 0);
});

test("non-z.ai session start does not clear another extension footer", async () => {
	const { pi, getHandlers } = createPiStub();
	zaiCodingPlan(pi as never);

	const sessionStartHandlers = getHandlers<(event: unknown, ctx: any) => Promise<void>>("session_start");
	assert.equal(sessionStartHandlers.length, 1);

	const footers: unknown[] = [];
	await sessionStartHandlers[0](
		{},
		{
			hasUI: true,
			model: { provider: "other-provider", id: "other-model", reasoning: true, contextWindow: 131072 },
			ui: {
				theme: { fg: (_color: string, text: string) => text, bold: (text: string) => text },
				setStatus() {},
				setWidget() {},
				setFooter(factory: unknown) {
					footers.push(factory);
				},
			},
			getContextUsage() {
				return { tokens: 1000, contextWindow: 131072, percent: 0.8 };
			},
			sessionManager: {
				getEntries() {
					return [];
				},
				getBranch() {
					return [];
				},
				getCwd() {
					return "/tmp/project";
				},
				getSessionName() {
					return undefined;
				},
			},
			modelRegistry: {
				isUsingOAuth() {
					return false;
				},
				async getApiKeyAndHeaders() {
					return { ok: false, error: "auth not configured" };
				},
			},
		},
	);

	assert.deepEqual(footers, []);
});

test("custom footer merges z.ai status into the main stats line", async () => {
	const { pi, getHandlers } = createPiStub();
	zaiCodingPlan(pi as never);

	const sessionStartHandlers = getHandlers<(event: unknown, ctx: any) => Promise<void>>("session_start");
	assert.equal(sessionStartHandlers.length, 1);

	let footerFactory: any;
	await sessionStartHandlers[0](
		{},
		{
			hasUI: true,
			model: { provider: ZAI_CODING_PLAN_PROVIDER_ID, id: "glm-5.1", baseUrl: ZAI_CODING_PLAN_BASE_URL, reasoning: true, contextWindow: 131072 },
			ui: {
				theme: { fg: (_color: string, text: string) => text, bold: (text: string) => text },
				setStatus() {},
				setWidget() {},
				setFooter(factory: unknown) {
					footerFactory = factory;
				},
			},
			getContextUsage() {
				return { tokens: 1000, contextWindow: 131072, percent: 12.3 };
			},
			sessionManager: {
				getEntries() {
					return [];
				},
				getBranch() {
					return [{ type: "thinking_level_change", thinkingLevel: "high" }];
				},
				getCwd() {
					return "/tmp/project";
				},
				getSessionName() {
					return undefined;
				},
			},
			modelRegistry: {
				isUsingOAuth() {
					return false;
				},
				async getApiKeyAndHeaders() {
					return { ok: false, error: "auth not configured" };
				},
			},
		},
	);

	const component = footerFactory(
		{ requestRender() {} },
		{ fg: (_color: string, text: string) => text, bold: (text: string) => text },
		{
			getGitBranch() {
				return "main";
			},
			getExtensionStatuses() {
				return new Map([["zai-usage-indicator", "● z.ai 5h 78% · 7d 96%"]]);
			},
			getAvailableProviderCount() {
				return 2;
			},
			onBranchChange() {
				return () => {};
			},
		},
	);
	const lines = component.render(120);
	assert.equal(lines.length, 2);
	assert.match(lines[1], /z\.ai 5h 78% · 7d 96%/);
	assert.match(lines[1], /glm-5\.1 • high/);
});

test("custom footer suppresses detached git chrome in jj repositories", async () => {
	const repoRoot = await mkdtemp(join(tmpdir(), "zai-coding-plan-jj-"));
	await mkdir(join(repoRoot, ".jj"), { recursive: true });

	const { pi, getHandlers } = createPiStub({
		exec: async (command, args, options) => {
			assert.equal(command, "jj");
			assert.deepEqual(args, [
				"log",
				"-r",
				"@",
				"--no-graph",
				"-T",
				'change_id.short(8) ++ "\\n" ++ commit_id.short(8) ++ "\\n" ++ description.first_line()',
			]);
			assert.equal(options?.cwd, repoRoot);
			return {
				stdout: "pzzzuuol\n39cc93d2\nShow jj change metadata instead of detached git head\n",
				stderr: "",
				code: 0,
			};
		},
	});
	zaiCodingPlan(pi as never);

	const sessionStartHandlers = getHandlers<(event: unknown, ctx: any) => Promise<void>>("session_start");
	assert.equal(sessionStartHandlers.length, 1);

	let footerFactory: any;
	await sessionStartHandlers[0](
		{},
		{
			hasUI: true,
			model: { provider: ZAI_CODING_PLAN_PROVIDER_ID, id: "glm-5.1", baseUrl: ZAI_CODING_PLAN_BASE_URL, reasoning: true, contextWindow: 131072 },
			ui: {
				theme: { fg: (_color: string, text: string) => text, bold: (text: string) => text },
				setStatus() {},
				setWidget() {},
				setFooter(factory: unknown) {
					footerFactory = factory;
				},
			},
			getContextUsage() {
				return { tokens: 1000, contextWindow: 131072, percent: 12.3 };
			},
			sessionManager: {
				getEntries() {
					return [];
				},
				getBranch() {
					return [];
				},
				getCwd() {
					return repoRoot;
				},
				getSessionName() {
					return undefined;
				},
			},
			modelRegistry: {
				isUsingOAuth() {
					return false;
				},
				async getApiKeyAndHeaders() {
					return { ok: false, error: "auth not configured" };
				},
			},
		},
	);

	let renderCount = 0;
	const component = footerFactory(
		{ requestRender() {
			renderCount += 1;
		} },
		{ fg: (_color: string, text: string) => text, bold: (text: string) => text },
		{
			getGitBranch() {
				return "detached";
			},
			getExtensionStatuses() {
				return new Map();
			},
			getAvailableProviderCount() {
				return 1;
			},
			onBranchChange() {
				return () => {};
			},
		},
	);

	assert.match(component.render(240)[0], /\(jj …\)/);
	await new Promise((resolve) => setTimeout(resolve, 0));
	const rendered = component.render(240)[0];
	assert.match(rendered, /\(jj pzzzuuol • Show jj change metadata instead of detached git head\)/);
	assert.doesNotMatch(rendered, /\(detached\)/);
	assert.ok(renderCount >= 1);
});
