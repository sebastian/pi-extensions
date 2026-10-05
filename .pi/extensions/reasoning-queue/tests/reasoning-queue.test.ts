import test from "node:test";
import assert from "node:assert/strict";
import reasoningQueueExtension, { type ReasoningModel, clampReasoningLevel, getSupportedReasoningLevels, parseReasoningDirective } from "../index.ts";

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
	id: "gpt-5.6-sol",
	name: "GPT-5.6 Sol",
	provider: "openai",
	reasoning: true,
	thinkingLevelMap: { off: "none", minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
} as ReasoningModel;

const glmReasoningModel = {
	api: "openai-completions",
	id: "glm-5.2",
	name: "GLM-5.2",
	provider: "zai",
	reasoning: true,
	thinkingLevelMap: { off: "none", minimal: null, low: null, medium: null, high: "high", xhigh: null, max: "max" },
	compat: { thinkingFormat: "zai", supportsReasoningEffort: true },
} as ReasoningModel;

function ctx(overrides: Record<string, unknown> = {}) {
	return {
		hasUI: false,
		model: reasoningModel,
		isIdle() {
			return true;
		},
		hasPendingMessages() {
			return false;
		},
		ui: { notify() {}, theme: { fg: (_color: string, text: string) => text }, setStatus() {}, addAutocompleteProvider() {} },
		...overrides,
	};
}

test("registers lifecycle hooks without invoking runtime actions or rewriting provider payloads", () => {
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
	assert.deepEqual(registeredEvents, ["session_start", "model_select", "thinking_level_select", "input", "message_start", "session_shutdown"]);
});

test("parses slash, colon, and bracket reasoning directives", () => {
	assert.deepEqual(parseReasoningDirective("/think high fix the tests"), { kind: "directive", level: "high", rest: "fix the tests", syntax: "slash" });
	assert.deepEqual(parseReasoningDirective(":xh plan carefully"), { kind: "directive", level: "xhigh", rest: "plan carefully", syntax: "colon" });
	assert.deepEqual(parseReasoningDirective(":max inspect everything"), { kind: "directive", level: "max", rest: "inspect everything", syntax: "colon" });
	assert.deepEqual(parseReasoningDirective("[r:low] do the cheap thing"), { kind: "directive", level: "low", rest: "do the cheap thing", syntax: "bracket" });
});

test("handles standalone and invalid slash directives", () => {
	assert.deepEqual(parseReasoningDirective("/reason off"), { kind: "directive", level: "off", rest: "", syntax: "slash" });
	assert.deepEqual(parseReasoningDirective("/thinking nope"), { kind: "invalid", token: "nope", syntax: "slash" });
	assert.equal(parseReasoningDirective(":not-a-level keep literal"), undefined);
});

test("clamps to the provider-verified reasoning levels", () => {
	assert.deepEqual(getSupportedReasoningLevels(glmReasoningModel), ["off", "high", "max"]);
	assert.equal(clampReasoningLevel("xhigh", glmReasoningModel), "max");
	assert.equal(clampReasoningLevel("medium", glmReasoningModel), "high");
	assert.equal(clampReasoningLevel("off", glmReasoningModel), "off");

	const mappedModel = { ...reasoningModel, thinkingLevelMap: { off: null, minimal: "low", low: null, medium: null, xhigh: "xhigh", max: "max" } } as ReasoningModel;
	assert.deepEqual(getSupportedReasoningLevels(mappedModel), ["minimal", "high", "xhigh", "max"]);
	assert.equal(clampReasoningLevel("off", mappedModel), "minimal");
});

test("keeps effort aliases distinct when per-level sampling can distinguish them", () => {
	const aliases = { ...glmReasoningModel, thinkingLevelMap: { minimal: null, low: "high", medium: "high", high: "high", max: "max" } } as ReasoningModel;
	assert.deepEqual(getSupportedReasoningLevels(aliases), ["off", "high", "max"]);
	const sampled = { ...aliases, samplingParamsByThinkingLevel: { low: { temperature: 0.3 }, high: { temperature: 0.9 } } };
	assert.deepEqual(getSupportedReasoningLevels(sampled), ["off", "low", "medium", "high", "max"]);
	assert.equal(clampReasoningLevel("low", sampled), "low");
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

test("streamingBehavior defers thinking-level changes until the queued message starts", async () => {
	const runtime = registerExtension("medium");
	const testCtx = ctx();
	await runtime.handlers.get("session_start")![0]({}, testCtx as never);
	const inputResult = await runtime.handlers.get("input")![0]({ text: "/r xhigh queued task", source: "interactive", streamingBehavior: "followUp" }, testCtx as never);
	assert.deepEqual(inputResult, { action: "transform", text: "queued task", images: undefined });
	assert.equal(runtime.thinkingLevel, "medium");
	assert.deepEqual(runtime.setCalls, ["medium"]);

	await runtime.handlers.get("message_start")![0]({ message: { role: "user", content: "queued task" } }, testCtx as never);
	assert.equal(runtime.thinkingLevel, "xhigh");
});

test("dequeueing a message also discards its pending reasoning metadata", async () => {
	const runtime = registerExtension("medium");
	const testCtx = ctx({ isIdle: () => false });
	await runtime.handlers.get("session_start")![0]({}, testCtx as never);
	await runtime.handlers.get("input")![0]({ text: ":low original", source: "interactive", streamingBehavior: "followUp" }, testCtx as never);

	// Pi's dequeue action clears the real queue before the corrected input event.
	await runtime.handlers.get("input")![0]({ text: ":high corrected", source: "interactive", streamingBehavior: "steer" }, testCtx as never);
	await runtime.handlers.get("message_start")![0]({ message: { role: "user", content: "corrected" } }, testCtx as never);
	await runtime.handlers.get("message_start")![0]({ message: { role: "user", content: "untracked" } }, testCtx as never);
	assert.equal(runtime.thinkingLevel, "high");
});
