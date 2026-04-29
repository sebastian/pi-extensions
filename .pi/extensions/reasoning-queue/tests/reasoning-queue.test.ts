import test from "node:test";
import assert from "node:assert/strict";
import reasoningQueueExtension, { parseReasoningDirective, rewriteProviderPayload } from "../index.ts";

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
	assert.deepEqual(registeredEvents, ["session_start", "model_select", "input", "message_start", "before_provider_request", "session_shutdown"]);
});

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

test("parses slash, colon, and bracket reasoning directives", () => {
	assert.deepEqual(parseReasoningDirective("/think high fix the tests"), {
		kind: "directive",
		level: "high",
		rest: "fix the tests",
		syntax: "slash",
	});
	assert.deepEqual(parseReasoningDirective(":xh plan carefully"), {
		kind: "directive",
		level: "xhigh",
		rest: "plan carefully",
		syntax: "colon",
	});
	assert.deepEqual(parseReasoningDirective("[r:low] do the cheap thing"), {
		kind: "directive",
		level: "low",
		rest: "do the cheap thing",
		syntax: "bracket",
	});
});

test("handles standalone and invalid slash directives", () => {
	assert.deepEqual(parseReasoningDirective("/reason off"), {
		kind: "directive",
		level: "off",
		rest: "",
		syntax: "slash",
	});
	assert.deepEqual(parseReasoningDirective("/thinking nope"), {
		kind: "invalid",
		token: "nope",
		syntax: "slash",
	});
	assert.equal(parseReasoningDirective(":not-a-level keep literal"), undefined);
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
	const enabled = rewriteProviderPayload({ model: model.id, max_tokens: 4096, thinking: { type: "disabled" } }, "high", model) as {
		thinking: { type: string; budget_tokens: number };
		max_tokens: number;
	};
	assert.equal(enabled.thinking.type, "enabled");
	assert.equal(enabled.thinking.budget_tokens, 16384);
	assert.ok(enabled.max_tokens > enabled.thinking.budget_tokens);

	const disabled = rewriteProviderPayload(enabled, "off", model) as { thinking: { type: string }; output_config?: unknown };
	assert.deepEqual(disabled.thinking, { type: "disabled" });
	assert.equal(disabled.output_config, undefined);
});

test("rewrites Google thinking config", () => {
	const model = { ...reasoningModel, api: "google", id: "gemini-2.5-pro", provider: "google" };
	const payload = rewriteProviderPayload({ model: model.id, contents: [], config: {} }, "medium", model) as {
		config: { thinkingConfig: { includeThoughts: boolean; thinkingBudget: number } };
	};

	assert.equal(payload.config.thinkingConfig.includeThoughts, true);
	assert.equal(payload.config.thinkingConfig.thinkingBudget, 8192);
});

test("rewrites OpenAI-compatible provider shapes based on existing fields", () => {
	const deepseek = {
		...reasoningModel,
		api: "openai-completions",
		provider: "deepseek",
		id: "deepseek-v4-pro",
		compat: { thinkingFormat: "deepseek", reasoningEffortMap: { high: "high", xhigh: "max" } },
	};
	const payload = rewriteProviderPayload({ model: deepseek.id, messages: [], thinking: { type: "disabled" } }, "xhigh", deepseek) as {
		thinking: { type: string };
		reasoning_effort: string;
	};

	assert.equal(payload.thinking.type, "enabled");
	assert.equal(payload.reasoning_effort, "max");
});
