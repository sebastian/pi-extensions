import test from "node:test";
import assert from "node:assert/strict";
import reasoningQueueExtension, { type ReasoningModel, clampReasoningLevel, getSupportedReasoningLevels, parseReasoningDirective, rewriteProviderPayload } from "../index.ts";

function registerExtension(thinking = "medium") {
	const handlers = new Map<string, Function[]>();
	let thinkingLevel = thinking;
	const setCalls: string[] = [];
	const pi = {
		on(name: string, handler: Function) {
			handlers.set(name, [...(handlers.get(name) ?? []), handler]);
		},
		getThinkingLevel() {
			return thinkingLevel;
		},
		setThinkingLevel(level: string) {
			setCalls.push(level);
			thinkingLevel = level;
		},
	};
	reasoningQueueExtension(pi as never);
	return { handlers, setCalls, get thinkingLevel() { return thinkingLevel; } };
}

const reasoningModel = {
	api: "openai-responses",
	id: "gpt-5.4-codex",
	name: "GPT-5.4 Codex",
	provider: "openai-codex",
	reasoning: true,
	maxTokens: 128000,
	baseUrl: "https://api.openai.com/v1",
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	input: ["text"],
} as const;

const glmReasoningModel = {
	...reasoningModel,
	api: "openai-completions",
	id: "glm-5.1",
	name: "GLM-5.1",
	provider: "zai-coding-plan",
	compat: { thinkingFormat: "zai" },
} as const;

function ctx(overrides: Record<string, unknown> = {}) {
	return {
		hasUI: false,
		model: reasoningModel,
		modelRegistry: {
			getAvailable() {
				return [reasoningModel, glmReasoningModel];
			},
			find(provider: string, id: string) {
				return [reasoningModel, glmReasoningModel].find((model) => model.provider === provider && model.id === id);
			},
		},
		isIdle() {
			return true;
		},
		ui: { notify() {}, theme: { fg: (_color: string, text: string) => text }, setStatus() {}, addAutocompleteProvider() {} },
		...overrides,
	};
}

test("registers without invoking runtime action methods during extension loading", () => {
	const registeredEvents: string[] = [];
	const pi = {
		on(name: string) {
			registeredEvents.push(name);
		},
		getThinkingLevel() {
			throw new Error("getThinkingLevel should not be called during registration");
		},
		setThinkingLevel() {
			throw new Error("setThinkingLevel should not be called during registration");
		},
	};

	assert.doesNotThrow(() => reasoningQueueExtension(pi as never));
	assert.deepEqual(registeredEvents, ["session_start", "model_select", "thinking_level_select", "input", "message_start", "before_provider_request", "session_shutdown"]);
});

test("parses slash, colon, and bracket reasoning directives", () => {
	assert.deepEqual(parseReasoningDirective("/think high fix the tests"), { kind: "directive", level: "high", rest: "fix the tests", syntax: "slash" });
	assert.deepEqual(parseReasoningDirective(":xh plan carefully"), { kind: "directive", level: "xhigh", rest: "plan carefully", syntax: "colon" });
	assert.deepEqual(parseReasoningDirective("[r:low] do the cheap thing"), { kind: "directive", level: "low", rest: "do the cheap thing", syntax: "bracket" });
});

test("handles standalone and invalid slash directives", () => {
	assert.deepEqual(parseReasoningDirective("/reason off"), { kind: "directive", level: "off", rest: "", syntax: "slash" });
	assert.deepEqual(parseReasoningDirective("/thinking nope"), { kind: "invalid", token: "nope", syntax: "slash" });
	assert.equal(parseReasoningDirective(":not-a-level keep literal"), undefined);
});

test("clamps reasoning levels to the closest level supported by the model", () => {
	assert.deepEqual(getSupportedReasoningLevels(glmReasoningModel), ["off", "high"]);
	assert.equal(clampReasoningLevel("xhigh", glmReasoningModel), "high");
	assert.equal(clampReasoningLevel("medium", glmReasoningModel), "high");
	assert.equal(clampReasoningLevel("off", glmReasoningModel), "off");

	const mappedModel = { ...reasoningModel, thinkingLevelMap: { off: null, minimal: "low", low: null, medium: null, xhigh: "max" } } as ReasoningModel;
	assert.deepEqual(getSupportedReasoningLevels(mappedModel), ["minimal", "high", "xhigh"]);
	assert.equal(clampReasoningLevel("off", mappedModel), "minimal");

	// GLM-5.2 maps low/medium/high all to "high" and xhigh to "max"; only the equivalent
	// match (high) plus the distinct top tier (xhigh=max) are advertised, the collapsing
	// low/medium are dropped.
	const glm52Model = { ...reasoningModel, api: "openai-completions", id: "glm-5.2", name: "GLM-5.2", provider: "zai", thinkingLevelMap: { minimal: null, low: "high", medium: "high", high: "high", xhigh: "max" }, compat: { thinkingFormat: "zai", supportsReasoningEffort: true } } as ReasoningModel;
	assert.deepEqual(getSupportedReasoningLevels(glm52Model), ["off", "high", "xhigh"]);
	assert.equal(clampReasoningLevel("low", glm52Model), "high");
	assert.equal(clampReasoningLevel("medium", glm52Model), "high");
	assert.equal(clampReasoningLevel("xhigh", glm52Model), "xhigh");
});

test("model selection applies the closest supported reasoning level", async () => {
	const runtime = registerExtension("medium");
	await runtime.handlers.get("model_select")![0]({}, ctx({ model: glmReasoningModel }) as never);
	assert.equal(runtime.thinkingLevel, "high");
	assert.deepEqual(runtime.setCalls, ["high"]);
});

test("thinking level selection event refreshes the inherited default", async () => {
	const runtime = registerExtension("medium");
	let status = "";
	const testCtx = ctx({
		hasUI: true,
		ui: {
			theme: { fg: (_color: string, text: string) => text },
			setStatus(_key: string, text: string | undefined) { status = text ?? ""; },
			addAutocompleteProvider() {},
		},
	});

	await runtime.handlers.get("session_start")![0]({}, testCtx as never);
	await runtime.handlers.get("thinking_level_select")![0]({ level: "xhigh", previousLevel: "medium" }, testCtx as never);
	assert.equal(status, "reasoning:xhigh");
});

test("reasoning directive autocomplete declares natural trigger characters", async () => {
	const runtime = registerExtension("medium");
	const autocompleteProviders: Function[] = [];
	const testCtx = ctx({
		mode: "tui",
		hasUI: true,
		ui: {
			theme: { fg: (_color: string, text: string) => text },
			setStatus() {},
			addAutocompleteProvider(factory: Function) { autocompleteProviders.push(factory); },
		},
	});

	await runtime.handlers.get("session_start")![0]({}, testCtx as never);
	assert.equal(autocompleteProviders.length, 1);

	const current = {
		getSuggestions() { return { prefix: "delegated", items: [] }; },
		applyCompletion() {},
		shouldTriggerFileCompletion() { return true; },
	};
	const provider = autocompleteProviders[0]!(current);
	assert.deepEqual(provider.triggerCharacters, ["/", ":", "["]);
	const colon = await provider.getSuggestions([":h"], 0, 2, { signal: new AbortController().signal });
	assert.equal(colon.prefix, ":h");
	assert.deepEqual(colon.items.map((item: { value: string }) => item.value), [":high"]);
});

test("streamingBehavior keeps queued reasoning from changing the active in-flight request", async () => {
	const runtime = registerExtension("medium");
	const testCtx = ctx();
	await runtime.handlers.get("session_start")![0]({}, testCtx as never);
	const inputResult = await runtime.handlers.get("input")![0]({ text: "/r xhigh queued task", source: "interactive", streamingBehavior: "followUp" }, testCtx as never);
	assert.deepEqual(inputResult, { action: "transform", text: "queued task", images: undefined });

	const inFlight = runtime.handlers.get("before_provider_request")![0]({ payload: { model: "gpt-5.4-codex", input: [], reasoning: { effort: "low", summary: "auto" } } }, testCtx as never) as { reasoning: { effort: string } };
	assert.equal(inFlight.reasoning.effort, "medium");
	assert.equal(runtime.thinkingLevel, "medium");

	await runtime.handlers.get("message_start")![0]({ message: { role: "user", content: "queued task" } }, testCtx as never);
	const queuedTurn = runtime.handlers.get("before_provider_request")![0]({ payload: { model: "gpt-5.4-codex", input: [], reasoning: { effort: "low", summary: "auto" } } }, testCtx as never) as { reasoning: { effort: string } };
	assert.equal(queuedTurn.reasoning.effort, "xhigh");
	assert.equal(runtime.thinkingLevel, "xhigh");
});

test("provider payload rewriting follows the request payload model when context model differs", async () => {
	const runtime = registerExtension("xhigh");
	let currentModel: typeof reasoningModel | typeof glmReasoningModel = reasoningModel;
	const testCtx = ctx({
		get model() {
			return currentModel;
		},
	});
	await runtime.handlers.get("session_start")![0]({}, testCtx as never);
	currentModel = glmReasoningModel;

	const rewritten = runtime.handlers.get("before_provider_request")![0]({ payload: { model: "gpt-5.4-codex", input: [], reasoning: { effort: "low", summary: "auto" } } }, testCtx as never) as { reasoning: { effort: string }; include?: string[]; enable_thinking?: boolean };
	assert.equal(rewritten.reasoning.effort, "xhigh");
	assert.deepEqual(rewritten.include, ["reasoning.encrypted_content"]);
	assert.equal("enable_thinking" in rewritten, false);
});

test("rewrites OpenAI Responses reasoning without mutating original payload", () => {
	const payload = { model: "gpt-5.4-codex", input: [], reasoning: { effort: "low", summary: "auto" } };
	const rewritten = rewriteProviderPayload(payload, "xhigh", reasoningModel) as { reasoning: { effort: string }; include: string[] };
	assert.equal(payload.reasoning.effort, "low");
	assert.equal(rewritten.reasoning.effort, "xhigh");
	assert.deepEqual(rewritten.include, ["reasoning.encrypted_content"]);
});

test("rewrites Anthropic payloads to enabled and disabled thinking", () => {
	const model = { ...reasoningModel, api: "anthropic-messages", id: "claude-sonnet-4-5", provider: "anthropic", maxTokens: 64000 };
	const enabled = rewriteProviderPayload({ model: model.id, max_tokens: 4096, thinking: { type: "disabled" } }, "high", model) as { thinking: { type: string; budget_tokens: number }; max_tokens: number };
	assert.equal(enabled.thinking.type, "enabled");
	assert.equal(enabled.thinking.budget_tokens, 16384);
	assert.ok(enabled.max_tokens > enabled.thinking.budget_tokens);
	const disabled = rewriteProviderPayload(enabled, "off", model) as { thinking: { type: string }; output_config?: unknown };
	assert.deepEqual(disabled.thinking, { type: "disabled" });
	assert.equal(disabled.output_config, undefined);
});

test("honors Anthropic adaptive-thinking compat metadata", () => {
	const model = { ...reasoningModel, api: "anthropic-messages", id: "proxy-claude-opus", name: "Proxy Claude Opus", provider: "anthropic-proxy", maxTokens: 64000, thinkingLevelMap: { xhigh: "max" }, compat: { forceAdaptiveThinking: true } } as ReasoningModel;
	const enabled = rewriteProviderPayload({ model: model.id, max_tokens: 4096, thinking: { type: "disabled" } }, "xhigh", model) as { thinking: { type: string; display: string }; output_config: { effort: string }; max_tokens: number };
	assert.deepEqual(enabled.thinking, { type: "adaptive", display: "summarized" });
	assert.deepEqual(enabled.output_config, { effort: "max" });
	assert.equal(enabled.max_tokens, 4096);
});

test("honors Claude Fable 5 adaptive-thinking xhigh metadata", () => {
	const model = { ...reasoningModel, api: "anthropic-messages", id: "claude-fable-5", name: "Claude Fable 5", provider: "anthropic", maxTokens: 64000, thinkingLevelMap: { off: null, xhigh: "xhigh" }, compat: { forceAdaptiveThinking: true } } as ReasoningModel;
	assert.deepEqual(getSupportedReasoningLevels(model), ["minimal", "low", "medium", "high", "xhigh"]);
	assert.equal(clampReasoningLevel("off", model), "minimal");
	const enabled = rewriteProviderPayload({ model: model.id, max_tokens: 4096, thinking: { type: "disabled" } }, "xhigh", model) as { thinking: { type: string; display: string }; output_config: { effort: string } };
	assert.deepEqual(enabled.thinking, { type: "adaptive", display: "summarized" });
	assert.deepEqual(enabled.output_config, { effort: "xhigh" });
});

test("allows Anthropic adaptive-thinking compat metadata to opt out", () => {
	const model = { ...reasoningModel, api: "anthropic-messages", id: "claude-opus-4-7", name: "Claude Opus 4.7", provider: "anthropic", maxTokens: 64000, compat: { forceAdaptiveThinking: false } } as ReasoningModel;
	const payload = rewriteProviderPayload({ model: model.id, max_tokens: 4096, thinking: { type: "disabled" } }, "xhigh", model) as { thinking: { type: string; budget_tokens: number }; output_config?: unknown };
	assert.equal(payload.thinking.type, "enabled");
	assert.equal(payload.thinking.budget_tokens, 16384);
	assert.equal(payload.output_config, undefined);
});

test("rewrites Google thinking config", () => {
	const model = { ...reasoningModel, api: "google", id: "gemini-2.5-pro", provider: "google" };
	const payload = rewriteProviderPayload({ model: model.id, contents: [], config: {} }, "medium", model) as { config: { thinkingConfig: { includeThoughts: boolean; thinkingBudget: number } } };
	assert.equal(payload.config.thinkingConfig.includeThoughts, true);
	assert.equal(payload.config.thinkingConfig.thinkingBudget, 8192);
});

test("preserves Google abort signals while rewriting thinking config", () => {
	const model = { ...reasoningModel, api: "google", id: "gemini-3.5-flash", provider: "google" };
	const controller = new AbortController();
	const original = { model: model.id, contents: [], config: { abortSignal: controller.signal } };
	const payload = rewriteProviderPayload(original, "high", model) as { config: { abortSignal: AbortSignal; thinkingConfig: { includeThoughts: boolean; thinkingLevel: string } } };
	assert.equal(payload.config.abortSignal, controller.signal);
	assert.equal(typeof payload.config.abortSignal.addEventListener, "function");
	assert.equal(payload.config.thinkingConfig.thinkingLevel, "HIGH");
	assert.equal("thinkingConfig" in original.config, false);
});

test("rewrites OpenAI-compatible provider shapes based on existing fields", () => {
	const deepseek = { ...reasoningModel, api: "openai-completions", provider: "deepseek", id: "deepseek-v4-pro", compat: { thinkingFormat: "deepseek", reasoningEffortMap: { high: "high", xhigh: "max" } } };
	const payload = rewriteProviderPayload({ model: deepseek.id, messages: [], thinking: { type: "disabled" } }, "xhigh", deepseek) as { thinking: { type: string }; reasoning_effort: string };
	assert.equal(payload.thinking.type, "enabled");
	assert.equal(payload.reasoning_effort, "max");
});

test("rewrites Together reasoning payloads from thinkingFormat metadata", () => {
	const together = { ...reasoningModel, api: "openai-completions", provider: "together", id: "deepseek-ai/DeepSeek-V3.2-Exp", thinkingLevelMap: { minimal: null, low: null, medium: null, high: "high", xhigh: "max" }, compat: { thinkingFormat: "together", supportsReasoningEffort: true } } as ReasoningModel;
	const enabled = rewriteProviderPayload({ model: together.id, messages: [] }, "xhigh", together) as { reasoning: { enabled: boolean }; reasoning_effort: string };
	assert.deepEqual(enabled.reasoning, { enabled: true });
	assert.equal(enabled.reasoning_effort, "max");
	const disabled = rewriteProviderPayload(enabled, "off", together) as { reasoning: { enabled: boolean }; reasoning_effort?: string };
	assert.deepEqual(disabled.reasoning, { enabled: false });
	assert.equal(disabled.reasoning_effort, undefined);
});

test("leaves pi 0.79.9+ chat-template kwargs intact instead of clobbering them", () => {
	// pi-ai builds chat_template_kwargs for thinkingFormat:"chat-template" from compat.chatTemplateKwargs
	// + the active thinking level. reasoning-queue must not overwrite that with the qwen shape.
	const model = {
		...reasoningModel,
		api: "openai-completions",
		provider: "vllm",
		id: "deepseek-v4",
		thinkingLevelMap: { off: null, low: "low", medium: "medium", high: "high", xhigh: "max" },
		compat: { thinkingFormat: "chat-template", chatTemplateKwargs: { thinking: { $var: "thinking.enabled" }, effort: "high" } },
	} as ReasoningModel;
	const original = { model: model.id, messages: [], chat_template_kwargs: { thinking: true, effort: "high" } } as Record<string, unknown>;
	const payload = rewriteProviderPayload(original, "high", model) as { chat_template_kwargs: { thinking: boolean; effort: string } };
	assert.deepEqual(payload.chat_template_kwargs, { thinking: true, effort: "high" });
});

test("still rewrites explicit qwen-chat-template kwargs", () => {
	const model = { ...reasoningModel, api: "openai-completions", provider: "qwen", id: "qwen3", compat: { thinkingFormat: "qwen-chat-template" } } as ReasoningModel;
	const payload = rewriteProviderPayload({ model: model.id, messages: [] }, "high", model) as { chat_template_kwargs: { enable_thinking: boolean; preserve_thinking: boolean } };
	assert.deepEqual(payload.chat_template_kwargs, { enable_thinking: true, preserve_thinking: true });
});

test("prefers model-level thinkingLevelMap over compat.reasoningEffortMap", () => {
	const model = { ...reasoningModel, api: "openai-completions", provider: "deepseek", id: "deepseek-v4-pro", thinkingLevelMap: { minimal: null, low: null, medium: null, high: "default", xhigh: "max" }, compat: { thinkingFormat: "deepseek", reasoningEffortMap: { high: "high", xhigh: "max" } } } as ReasoningModel;
	const payload = rewriteProviderPayload({ model: model.id, messages: [], thinking: { type: "disabled" } }, "xhigh", model) as { thinking: { type: string }; reasoning_effort: string };
	assert.equal(payload.thinking.type, "enabled");
	assert.equal(payload.reasoning_effort, "max");
});
