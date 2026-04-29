import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { Model } from "@mariozechner/pi-ai";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export type ReasoningModel = Pick<Model<any>, "api" | "id" | "name" | "provider" | "reasoning" | "maxTokens" | "compat" | "baseUrl">;

type JsonRecord = Record<string, unknown>;

export type ReasoningDirective =
	| { kind: "directive"; level: ThinkingLevel; rest: string; syntax: "slash" | "colon" | "bracket" }
	| { kind: "invalid"; token?: string; syntax: "slash" | "bracket" };

interface ModelRef {
	provider: string;
	id: string;
}

interface PendingReasoningLevel {
	text: string;
	level: ThinkingLevel;
	explicit: boolean;
	model?: ModelRef;
}

type FieldFocus = "prompt" | "model" | "reasoning";

const LEVEL_ALIASES: Record<string, ThinkingLevel> = {
	"0": "off",
	"false": "off",
	"no": "off",
	none: "off",
	off: "off",
	min: "minimal",
	minimal: "minimal",
	lo: "low",
	low: "low",
	m: "medium",
	med: "medium",
	medium: "medium",
	h: "high",
	hi: "high",
	high: "high",
	x: "xhigh",
	xh: "xhigh",
	xhi: "xhigh",
	xhigh: "xhigh",
	max: "xhigh",
};

const SLASH_DIRECTIVE_PATTERN = /^\/(?:r|reason|reasoning|think|thinking)(?:\s+(\S+))?(?:\s+([\s\S]*))?$/iu;
const COLON_DIRECTIVE_PATTERN = /^:(\S+)(?:\s+([\s\S]*))?$/iu;
const BRACKET_DIRECTIVE_PATTERN = /^\[(?:r|reason|reasoning|think|thinking):\s*([^\]\s]+)\s*\](?:\s*([\s\S]*))?$/iu;

const DEFAULT_ANTHROPIC_BUDGETS: Record<Exclude<ThinkingLevel, "off">, number> = {
	minimal: 1024,
	low: 2048,
	medium: 8192,
	high: 16384,
	xhigh: 16384,
};

const DEFAULT_GENERIC_BUDGETS: Record<Exclude<ThinkingLevel, "off">, number> = {
	minimal: 1024,
	low: 4096,
	medium: 10240,
	high: 32768,
	xhigh: 32768,
};

export function normalizeThinkingLevel(value: string | undefined): ThinkingLevel | undefined {
	if (!value) return undefined;
	return LEVEL_ALIASES[value.trim().toLowerCase()];
}

export function parseReasoningDirective(text: string): ReasoningDirective | undefined {
	const trimmed = text.trimStart();

	const slash = trimmed.match(SLASH_DIRECTIVE_PATTERN);
	if (slash) {
		const token = slash[1];
		const level = normalizeThinkingLevel(token);
		if (!level) return { kind: "invalid", token, syntax: "slash" };
		return { kind: "directive", level, rest: slash[2]?.trimStart() ?? "", syntax: "slash" };
	}

	const bracket = trimmed.match(BRACKET_DIRECTIVE_PATTERN);
	if (bracket) {
		const token = bracket[1];
		const level = normalizeThinkingLevel(token);
		if (!level) return { kind: "invalid", token, syntax: "bracket" };
		return { kind: "directive", level, rest: bracket[2]?.trimStart() ?? "", syntax: "bracket" };
	}

	const colon = trimmed.match(COLON_DIRECTIVE_PATTERN);
	if (colon) {
		const level = normalizeThinkingLevel(colon[1]);
		if (!level) return undefined;
		return { kind: "directive", level, rest: colon[2]?.trimStart() ?? "", syntax: "colon" };
	}

	return undefined;
}

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clonePlain<T>(value: T): T {
	if (Array.isArray(value)) return value.map((item) => clonePlain(item)) as T;
	if (!isRecord(value)) return value;
	const result: JsonRecord = {};
	for (const [key, item] of Object.entries(value)) {
		result[key] = clonePlain(item);
	}
	return result as T;
}

function modelSupportsXhigh(model: ReasoningModel | undefined): boolean {
	const id = model?.id ?? "";
	return (
		id.includes("gpt-5.2") ||
		id.includes("gpt-5.3") ||
		id.includes("gpt-5.4") ||
		id.includes("gpt-5.5") ||
		id.includes("deepseek-v4-pro") ||
		id.includes("opus-4-6") ||
		id.includes("opus-4.6") ||
		id.includes("opus-4-7") ||
		id.includes("opus-4.7")
	);
}

function normalizeSupportedLevels(levels: ThinkingLevel[]): ThinkingLevel[] {
	const supported = new Set<ThinkingLevel>(["off", ...levels]);
	return THINKING_LEVELS.filter((level) => supported.has(level));
}

function parseSupportedLevels(value: unknown): ThinkingLevel[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const levels = value.flatMap((item) => {
		if (typeof item !== "string") return [];
		const level = normalizeThinkingLevel(item);
		return level ? [level] : [];
	});
	return levels.length > 0 ? normalizeSupportedLevels(levels) : undefined;
}

function getExplicitSupportedLevels(model: ReasoningModel | undefined): ThinkingLevel[] | undefined {
	const compat = isRecord(model?.compat) ? model.compat : undefined;
	return (
		parseSupportedLevels(compat?.supportedThinkingLevels) ??
		parseSupportedLevels(compat?.supportedReasoningLevels) ??
		parseSupportedLevels(compat?.thinkingLevels) ??
		parseSupportedLevels(compat?.reasoningLevels)
	);
}

function isBooleanThinkingFormat(model: ReasoningModel | undefined): boolean {
	const thinkingFormat = isRecord(model?.compat) && typeof model.compat.thinkingFormat === "string" ? model.compat.thinkingFormat : undefined;
	return thinkingFormat === "zai" || thinkingFormat === "qwen" || thinkingFormat === "qwen-chat-template";
}

function getCodexModelFamily(model: ReasoningModel | undefined): string {
	const id = (model?.id ?? "").toLowerCase();
	return id.includes("/") ? id.split("/").pop()! : id;
}

export function getSupportedReasoningLevels(model: ReasoningModel | undefined): ThinkingLevel[] {
	if (model?.reasoning === false) return ["off"];

	const explicit = getExplicitSupportedLevels(model);
	if (explicit) return explicit;

	if (isBooleanThinkingFormat(model) || (model?.api ?? "").includes("mistral")) return ["off", "high"];
	if (getCodexModelFamily(model) === "gpt-5.1-codex-mini") return ["off", "medium", "high"];
	if (modelSupportsXhigh(model)) return [...THINKING_LEVELS];
	return THINKING_LEVELS.filter((level) => level !== "xhigh");
}

export function clampReasoningLevel(level: ThinkingLevel, model: ReasoningModel | undefined): ThinkingLevel {
	const supported = getSupportedReasoningLevels(model);
	if (supported.includes(level)) return level;

	const supportedSet = new Set(supported);
	const requestedIndex = THINKING_LEVELS.indexOf(level);
	if (requestedIndex === -1) return supported[0] ?? "off";

	for (let i = requestedIndex; i < THINKING_LEVELS.length; i++) {
		const candidate = THINKING_LEVELS[i];
		if (supportedSet.has(candidate)) return candidate;
	}
	for (let i = requestedIndex - 1; i >= 0; i--) {
		const candidate = THINKING_LEVELS[i];
		if (supportedSet.has(candidate)) return candidate;
	}
	return supported[0] ?? "off";
}

function getModelRef(model: Pick<ReasoningModel, "provider" | "id"> | undefined): ModelRef | undefined {
	if (!model) return undefined;
	return { provider: model.provider, id: model.id };
}

function modelRefsEqual(a: ModelRef | undefined, b: ModelRef | undefined): boolean {
	return !!a && !!b && a.provider === b.provider && a.id === b.id;
}

function formatModelRef(model: Pick<ReasoningModel, "provider" | "id"> | ModelRef | undefined): string {
	if (!model) return "no model";
	return `${model.provider}/${model.id}`;
}

function isTabKey(data: string): boolean {
	return data === "\t" || /^\x1b\[9(?:;1(?::[12])?)?u$/.test(data);
}

function isShiftTabKey(data: string): boolean {
	return data === "\x1b[Z" || data === "\x1b[27;2;9~" || /^\x1b\[9;2(?::[12])?u$/.test(data);
}

function isForwardKey(data: string): boolean {
	return data === "\x1b[C" || data === "\x1b[B" || data === " ";
}

function isBackwardKey(data: string): boolean {
	return data === "\x1b[D" || data === "\x1b[A";
}

function isEnterKey(data: string): boolean {
	return data === "\r" || data === "\n";
}

function isEscapeKey(data: string): boolean {
	return data === "\x1b";
}

function isCtrlCOrD(data: string): boolean {
	return data === "\x03" || data === "\x04";
}

function isPrintableInput(data: string): boolean {
	return data.length === 1 && data >= " " && data !== "\x7f";
}

function getReasoningEffort(level: ThinkingLevel, model: ReasoningModel | undefined): string | undefined {
	if (level === "off") return undefined;
	const clamped = clampReasoningLevel(level, model);
	const map = isRecord(model?.compat?.reasoningEffortMap) ? model.compat.reasoningEffortMap : undefined;
	const mapped = map?.[clamped];
	return typeof mapped === "string" ? mapped : clamped;
}

function withReasoningInclude(payload: JsonRecord): void {
	const include = Array.isArray(payload.include) ? [...payload.include] : [];
	if (!include.includes("reasoning.encrypted_content")) include.push("reasoning.encrypted_content");
	payload.include = include;
}

function applyResponsesPayload(payload: JsonRecord, level: ThinkingLevel, model: ReasoningModel | undefined): JsonRecord {
	if (model?.reasoning === false) {
		delete payload.reasoning;
		return payload;
	}

	const isCodex = model?.api === "openai-codex-responses";
	if (level === "off") {
		if (isCodex) delete payload.reasoning;
		else payload.reasoning = { effort: "none" };
		return payload;
	}

	const effort = isCodex ? clampCodexReasoningEffort(clampReasoningLevel(level, model), model?.id) : getReasoningEffort(level, model);
	payload.reasoning = {
		...(isRecord(payload.reasoning) ? payload.reasoning : {}),
		effort,
		summary: isRecord(payload.reasoning) && typeof payload.reasoning.summary === "string" ? payload.reasoning.summary : "auto",
	};
	withReasoningInclude(payload);
	return payload;
}

function clampCodexReasoningEffort(level: Exclude<ThinkingLevel, "off">, modelId = ""): string {
	const id = modelId.includes("/") ? modelId.split("/").pop()! : modelId;
	if ((id.startsWith("gpt-5.2") || id.startsWith("gpt-5.3") || id.startsWith("gpt-5.4") || id.startsWith("gpt-5.5")) && level === "minimal") {
		return "low";
	}
	if (id === "gpt-5.1" && level === "xhigh") return "high";
	if (id === "gpt-5.1-codex-mini") return level === "high" || level === "xhigh" ? "high" : "medium";
	return level;
}

function applyOpenAICompletionsPayload(payload: JsonRecord, level: ThinkingLevel, model: ReasoningModel | undefined): JsonRecord {
	const enabled = level !== "off" && model?.reasoning !== false;
	const effort = getReasoningEffort(level, model);
	const thinkingFormat = typeof model?.compat?.thinkingFormat === "string" ? model.compat.thinkingFormat : undefined;

	if ("enable_thinking" in payload || thinkingFormat === "zai" || thinkingFormat === "qwen") {
		payload.enable_thinking = enabled;
	}

	if (isRecord(payload.chat_template_kwargs) || thinkingFormat === "qwen-chat-template") {
		payload.chat_template_kwargs = {
			...(isRecord(payload.chat_template_kwargs) ? payload.chat_template_kwargs : {}),
			enable_thinking: enabled,
			preserve_thinking: true,
		};
	}

	if (isRecord(payload.thinking) || thinkingFormat === "deepseek") {
		payload.thinking = {
			...(isRecord(payload.thinking) ? payload.thinking : {}),
			type: enabled ? "enabled" : "disabled",
		};
		if (enabled && effort) payload.reasoning_effort = effort;
		else delete payload.reasoning_effort;
	}

	if (isRecord(payload.reasoning) || thinkingFormat === "openrouter") {
		payload.reasoning = {
			...(isRecord(payload.reasoning) ? payload.reasoning : {}),
			effort: enabled && effort ? effort : "none",
		};
	}

	const supportsReasoningEffort = model?.compat?.supportsReasoningEffort !== false;
	const shouldUseOpenAIReasoningEffort =
		!thinkingFormat || thinkingFormat === "openai" || "reasoning_effort" in payload || "reasoningEffort" in payload;
	if (supportsReasoningEffort && shouldUseOpenAIReasoningEffort) {
		if (enabled && effort) payload.reasoning_effort = effort;
		else delete payload.reasoning_effort;
	}

	return payload;
}

function supportsAdaptiveAnthropic(model: ReasoningModel | undefined): boolean {
	const value = `${model?.id ?? ""} ${model?.name ?? ""}`.toLowerCase();
	return (
		value.includes("opus-4-6") ||
		value.includes("opus-4.6") ||
		value.includes("opus-4-7") ||
		value.includes("opus-4.7") ||
		value.includes("sonnet-4-6") ||
		value.includes("sonnet-4.6") ||
		value.includes("sonnet-4-7") ||
		value.includes("sonnet-4.7")
	);
}

function mapAnthropicEffort(level: Exclude<ThinkingLevel, "off">, model: ReasoningModel | undefined): string {
	const modelId = (model?.id ?? "").toLowerCase();
	switch (level) {
		case "minimal":
		case "low":
			return "low";
		case "medium":
			return "medium";
		case "high":
			return "high";
		case "xhigh":
			if (modelId.includes("opus-4-6") || modelId.includes("opus-4.6")) return "max";
			if (modelId.includes("opus-4-7") || modelId.includes("opus-4.7")) return "xhigh";
			return "high";
	}
}

function applyAnthropicLikeFields(payload: JsonRecord, level: ThinkingLevel, model: ReasoningModel | undefined): void {
	if (level === "off" || model?.reasoning === false) {
		payload.thinking = { type: "disabled" };
		delete payload.output_config;
		return;
	}

	const clamped = clampReasoningLevel(level, model) as Exclude<ThinkingLevel, "off">;
	const display = isRecord(payload.thinking) && typeof payload.thinking.display === "string" ? payload.thinking.display : "summarized";
	if (supportsAdaptiveAnthropic(model)) {
		payload.thinking = { type: "adaptive", display };
		payload.output_config = {
			...(isRecord(payload.output_config) ? payload.output_config : {}),
			effort: mapAnthropicEffort(clamped, model),
		};
		return;
	}

	const budget = DEFAULT_ANTHROPIC_BUDGETS[clamped];
	payload.thinking = { type: "enabled", budget_tokens: budget, display };
	const maxTokens = typeof payload.max_tokens === "number" ? payload.max_tokens : undefined;
	const modelMaxTokens = typeof model?.maxTokens === "number" && model.maxTokens > 0 ? model.maxTokens : undefined;
	const minimumUsefulMaxTokens = budget + 1024;
	if (maxTokens === undefined || maxTokens <= budget) {
		payload.max_tokens = modelMaxTokens ? Math.min(modelMaxTokens, minimumUsefulMaxTokens) : minimumUsefulMaxTokens;
	}
}

function applyAnthropicPayload(payload: JsonRecord, level: ThinkingLevel, model: ReasoningModel | undefined): JsonRecord {
	applyAnthropicLikeFields(payload, level, model);
	return payload;
}

function isGemma4Model(model: ReasoningModel | undefined): boolean {
	return /gemma-?4/.test((model?.id ?? "").toLowerCase());
}

function isGemini3ProModel(model: ReasoningModel | undefined): boolean {
	return /gemini-3(?:\.\d+)?-pro/.test((model?.id ?? "").toLowerCase());
}

function isGemini3FlashModel(model: ReasoningModel | undefined): boolean {
	return /gemini-3(?:\.\d+)?-flash/.test((model?.id ?? "").toLowerCase());
}

function getDisabledGoogleThinkingConfig(model: ReasoningModel | undefined): JsonRecord {
	if (isGemini3ProModel(model)) return { thinkingLevel: "LOW" };
	if (isGemini3FlashModel(model)) return { thinkingLevel: "MINIMAL" };
	if (isGemma4Model(model)) return { thinkingLevel: "MINIMAL" };
	return { thinkingBudget: 0 };
}

function getGoogleThinkingLevel(level: Exclude<ThinkingLevel, "off">, model: ReasoningModel | undefined): string {
	if (isGemini3ProModel(model)) return level === "minimal" || level === "low" ? "LOW" : "HIGH";
	if (isGemma4Model(model)) return level === "minimal" || level === "low" ? "MINIMAL" : "HIGH";
	switch (level) {
		case "minimal":
			return "MINIMAL";
		case "low":
			return "LOW";
		case "medium":
			return "MEDIUM";
		case "high":
		case "xhigh":
			return "HIGH";
	}
}

function getGoogleBudget(model: ReasoningModel | undefined, level: Exclude<ThinkingLevel, "off">): number {
	const id = model?.id ?? "";
	if (id.includes("2.5-pro")) {
		return { minimal: 128, low: 2048, medium: 8192, high: 32768, xhigh: 32768 }[level];
	}
	if (id.includes("2.5-flash-lite")) {
		return { minimal: 512, low: 2048, medium: 8192, high: 24576, xhigh: 24576 }[level];
	}
	if (id.includes("2.5-flash")) {
		return { minimal: 128, low: 2048, medium: 8192, high: 24576, xhigh: 24576 }[level];
	}
	return DEFAULT_GENERIC_BUDGETS[level] ?? -1;
}

function getGoogleThinkingConfig(model: ReasoningModel | undefined, level: ThinkingLevel): JsonRecord {
	if (level === "off" || model?.reasoning === false) return getDisabledGoogleThinkingConfig(model);
	const clamped = clampReasoningLevel(level, model) as Exclude<ThinkingLevel, "off">;
	if (isGemini3ProModel(model) || isGemini3FlashModel(model) || isGemma4Model(model)) {
		return { includeThoughts: true, thinkingLevel: getGoogleThinkingLevel(clamped, model) };
	}
	return { includeThoughts: true, thinkingBudget: getGoogleBudget(model, clamped) };
}

function applyGooglePayload(payload: JsonRecord, level: ThinkingLevel, model: ReasoningModel | undefined): JsonRecord {
	const target = isRecord(payload.config)
		? payload.config
		: isRecord(payload.generationConfig)
			? payload.generationConfig
			: undefined;
	if (target) {
		target.thinkingConfig = getGoogleThinkingConfig(model, level);
	} else {
		payload.config = { thinkingConfig: getGoogleThinkingConfig(model, level) };
	}
	return payload;
}

function applyBedrockPayload(payload: JsonRecord, level: ThinkingLevel, model: ReasoningModel | undefined): JsonRecord {
	if (level === "off" || model?.reasoning === false) {
		delete payload.additionalModelRequestFields;
		return payload;
	}
	const fields = clonePlain(isRecord(payload.additionalModelRequestFields) ? payload.additionalModelRequestFields : {});
	applyAnthropicLikeFields(fields, level, model);
	if (level !== "off" && !supportsAdaptiveAnthropic(model)) fields.anthropic_beta = ["interleaved-thinking-2025-05-14"];
	payload.additionalModelRequestFields = fields;
	return payload;
}

function applyMistralPayload(payload: JsonRecord, level: ThinkingLevel, model: ReasoningModel | undefined): JsonRecord {
	const enabled = level !== "off" && model?.reasoning !== false;
	const effort = getReasoningEffort(level, model);
	if (enabled && effort) {
		payload.reasoningEffort = effort;
		if ("promptMode" in payload) payload.promptMode = "reasoning";
	} else {
		delete payload.reasoningEffort;
		delete payload.promptMode;
	}
	return payload;
}

function applyGenericExistingFields(payload: JsonRecord, level: ThinkingLevel, model: ReasoningModel | undefined): JsonRecord {
	const enabled = level !== "off" && model?.reasoning !== false;
	const effort = getReasoningEffort(level, model);
	if ("reasoning_effort" in payload) {
		if (enabled && effort) payload.reasoning_effort = effort;
		else delete payload.reasoning_effort;
	}
	if ("reasoningEffort" in payload) {
		if (enabled && effort) payload.reasoningEffort = effort;
		else delete payload.reasoningEffort;
	}
	if ("enable_thinking" in payload) payload.enable_thinking = enabled;
	if (isRecord(payload.reasoning) && "effort" in payload.reasoning) {
		payload.reasoning = { ...payload.reasoning, effort: enabled && effort ? effort : "none" };
	}
	if (isRecord(payload.thinking) && "type" in payload.thinking) {
		payload.thinking = { ...payload.thinking, type: enabled ? "enabled" : "disabled" };
	}
	if (isRecord(payload.config) && "thinkingConfig" in payload.config) {
		payload.config.thinkingConfig = getGoogleThinkingConfig(model, level);
	}
	if (isRecord(payload.generationConfig) && "thinkingConfig" in payload.generationConfig) {
		payload.generationConfig.thinkingConfig = getGoogleThinkingConfig(model, level);
	}
	return payload;
}

export function rewriteProviderPayload(payload: unknown, level: ThinkingLevel, model?: ReasoningModel): unknown {
	if (!isRecord(payload)) return payload;
	const next = clonePlain(payload);
	const api = model?.api ?? "";

	if (api.includes("anthropic")) return applyAnthropicPayload(next, level, model);
	if (api.includes("bedrock")) return applyBedrockPayload(next, level, model);
	if (api.includes("google")) return applyGooglePayload(next, level, model);
	if (api.includes("responses")) return applyResponsesPayload(next, level, model);
	if (api.includes("openai-completions")) return applyOpenAICompletionsPayload(next, level, model);
	if (api.includes("mistral")) return applyMistralPayload(next, level, model);
	return applyGenericExistingFields(next, level, model);
}

function getUserMessageText(message: unknown): string | undefined {
	if (!isRecord(message) || message.role !== "user") return undefined;
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return undefined;
	const textBlocks = content.filter((block): block is { type: "text"; text: string } => {
		return isRecord(block) && block.type === "text" && typeof block.text === "string";
	});
	if (textBlocks.length === 0) return undefined;
	return textBlocks.map((block) => block.text).join("\n");
}

function formatValidLevels(): string {
	return THINKING_LEVELS.join(", ");
}

export default function reasoningQueueExtension(pi: ExtensionAPI): void {
	let defaultLevel: ThinkingLevel = "medium";
	let activeLevel: ThinkingLevel = defaultLevel;
	let pendingLevels: PendingReasoningLevel[] = [];
	let selectedModelRef: ModelRef | undefined;
	let fieldFocus: FieldFocus = "prompt";
	let unsubscribeTerminalInput: (() => void) | undefined;
	let pickerOpen = false;
	let modelChangeSequence = 0;

	function getAvailableModels(ctx: ExtensionContext): Model<any>[] {
		const models = ctx.modelRegistry.getAvailable();
		const current = ctx.model;
		if (!current || models.some((model) => model.provider === current.provider && model.id === current.id)) return models;
		return [current, ...models];
	}

	function resolveModelRef(ctx: ExtensionContext, ref: ModelRef | undefined): Model<any> | undefined {
		if (!ref) return ctx.model;
		const resolved = ctx.modelRegistry.find(ref.provider, ref.id);
		if (resolved) return resolved;
		const current = ctx.model;
		return current?.provider === ref.provider && current.id === ref.id ? current : undefined;
	}

	function getSelectedModel(ctx: ExtensionContext): Model<any> | undefined {
		return resolveModelRef(ctx, selectedModelRef) ?? ctx.model;
	}

	function getPendingModelRef(ctx: ExtensionContext): ModelRef | undefined {
		return selectedModelRef ?? getModelRef(ctx.model as ReasoningModel | undefined);
	}

	function getSelectedSupportedLevels(ctx: ExtensionContext): ThinkingLevel[] {
		return getSupportedReasoningLevels(getSelectedModel(ctx) as ReasoningModel | undefined);
	}

	function currentModelMatchesSelected(ctx: ExtensionContext): boolean {
		const currentRef = getModelRef(ctx.model as ReasoningModel | undefined);
		return !selectedModelRef || modelRefsEqual(selectedModelRef, currentRef);
	}

	function clampDefaultLevelToSelectedModel(ctx: ExtensionContext): ThinkingLevel {
		const effective = clampReasoningLevel(defaultLevel, getSelectedModel(ctx) as ReasoningModel | undefined);
		defaultLevel = effective;
		if (ctx.isIdle()) activeLevel = effective;
		return effective;
	}

	function fieldLabel(ctx: ExtensionContext, field: FieldFocus, label: string): string {
		const text = fieldFocus === field ? `[${label}]` : ` ${label} `;
		return fieldFocus === field ? ctx.ui.theme.fg("accent", text) : ctx.ui.theme.fg("dim", text);
	}

	function formatQueuedEntry(ctx: ExtensionContext, pending: PendingReasoningLevel): string {
		const model = pending.model ? formatModelRef(pending.model) : formatModelRef(ctx.model as ReasoningModel | undefined);
		return `${pending.explicit ? "*" : ""}${model}:${pending.level}`;
	}

	function updateStatus(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		const selectedModel = getSelectedModel(ctx) as ReasoningModel | undefined;
		const effectiveLevel = clampReasoningLevel(defaultLevel, selectedModel);
		if (effectiveLevel !== defaultLevel) {
			defaultLevel = effectiveLevel;
			if (ctx.isIdle()) activeLevel = effectiveLevel;
		}

		ctx.ui.setStatus("reasoning-queue", ctx.ui.theme.fg("dim", `reasoning:${defaultLevel}`));
		const controls = [
			fieldLabel(ctx, "prompt", "prompt"),
			fieldLabel(ctx, "model", `model: ${formatModelRef(selectedModel)}`),
			fieldLabel(ctx, "reasoning", `reasoning: ${defaultLevel}`),
		].join(" ");
		const levels = getSupportedReasoningLevels(selectedModel).join("/");
		const lines = [
			controls,
			ctx.ui.theme.fg("dim", `Tab/Shift+Tab fields • ←/→ change • Enter pick/focus prompt • valid reasoning: ${levels}`),
		];
		if (pendingLevels.length > 0) {
			lines.push(ctx.ui.theme.fg("dim", `Queued: ${pendingLevels.map((pending) => formatQueuedEntry(ctx, pending)).join(" → ")}`));
		}
		ctx.ui.setWidget("reasoning-queue", lines, { placement: "belowEditor" });
	}

	function setEffectiveThinkingLevel(level: ThinkingLevel, ctx: ExtensionContext): ThinkingLevel {
		const model = ctx.model as ReasoningModel | undefined;
		pi.setThinkingLevel(clampReasoningLevel(level, model));
		let effectiveLevel = pi.getThinkingLevel();
		const modelEffectiveLevel = clampReasoningLevel(effectiveLevel, model);
		if (modelEffectiveLevel !== effectiveLevel) {
			pi.setThinkingLevel(modelEffectiveLevel);
			effectiveLevel = pi.getThinkingLevel();
		}
		return clampReasoningLevel(effectiveLevel, model);
	}

	function setDefaultLevel(level: ThinkingLevel, ctx: ExtensionContext): ThinkingLevel {
		const effectiveLevel = setEffectiveThinkingLevel(level, ctx);
		defaultLevel = effectiveLevel;
		if (ctx.isIdle()) activeLevel = effectiveLevel;
		updateStatus(ctx);
		return effectiveLevel;
	}

	function setSelectedDefaultLevel(level: ThinkingLevel, ctx: ExtensionContext): ThinkingLevel {
		const selectedModel = getSelectedModel(ctx) as ReasoningModel | undefined;
		const effectiveLevel = clampReasoningLevel(level, selectedModel);
		defaultLevel = effectiveLevel;
		if (ctx.isIdle()) activeLevel = effectiveLevel;
		if (currentModelMatchesSelected(ctx)) {
			return setDefaultLevel(effectiveLevel, ctx);
		}
		updateStatus(ctx);
		return effectiveLevel;
	}

	function applyActiveLevel(level: ThinkingLevel, ctx: ExtensionContext): void {
		activeLevel = setEffectiveThinkingLevel(level, ctx);
		updateStatus(ctx);
	}

	async function applyModelRef(ref: ModelRef | undefined, ctx: ExtensionContext): Promise<void> {
		const model = resolveModelRef(ctx, ref);
		if (!model) return;
		if (ctx.model?.provider === model.provider && ctx.model.id === model.id) return;
		try {
			const result = await pi.setModel(model);
			if (result === false) ctx.ui.notify(`Could not switch to ${formatModelRef(model)}`, "error");
		} catch (error) {
			ctx.ui.notify(`Could not switch to ${formatModelRef(model)}: ${error instanceof Error ? error.message : String(error)}`, "error");
		}
	}

	function takePendingLevel(messageText: string | undefined): PendingReasoningLevel | undefined {
		if (pendingLevels.length === 0) return undefined;
		if (messageText) {
			const exactIndex = pendingLevels.findIndex((pending) => pending.text === messageText);
			if (exactIndex !== -1) return pendingLevels.splice(exactIndex, 1)[0];
		}
		// Prompt templates and skills expand after the input hook, so exact text can differ.
		return pendingLevels.shift();
	}

	function moveFieldFocus(direction: 1 | -1, ctx: ExtensionContext): void {
		const fields: FieldFocus[] = ["prompt", "model", "reasoning"];
		const index = fields.indexOf(fieldFocus);
		fieldFocus = fields[(index + direction + fields.length) % fields.length];
		updateStatus(ctx);
	}

	function cycleSelectedModel(direction: 1 | -1, ctx: ExtensionContext): void {
		const models = getAvailableModels(ctx);
		if (models.length === 0) return;
		const current = getSelectedModel(ctx) ?? ctx.model;
		let index = current ? models.findIndex((model) => model.provider === current.provider && model.id === current.id) : -1;
		if (index === -1) index = 0;
		const next = models[(index + direction + models.length) % models.length];
		selectedModelRef = getModelRef(next as ReasoningModel);
		clampDefaultLevelToSelectedModel(ctx);
		updateStatus(ctx);

		const sequence = ++modelChangeSequence;
		void (async () => {
			await applyModelRef(selectedModelRef, ctx);
			if (sequence !== modelChangeSequence) return;
			defaultLevel = setEffectiveThinkingLevel(defaultLevel, ctx);
			if (ctx.isIdle()) activeLevel = defaultLevel;
			updateStatus(ctx);
		})();
	}

	function cycleSelectedReasoning(direction: 1 | -1, ctx: ExtensionContext): void {
		const levels = getSelectedSupportedLevels(ctx);
		if (levels.length === 0) return;
		const current = clampReasoningLevel(defaultLevel, getSelectedModel(ctx) as ReasoningModel | undefined);
		const index = Math.max(0, levels.indexOf(current));
		const next = levels[(index + direction + levels.length) % levels.length];
		setSelectedDefaultLevel(next, ctx);
	}

	function openModelPicker(ctx: ExtensionContext): void {
		if (pickerOpen) return;
		const models = getAvailableModels(ctx);
		if (models.length === 0) return;
		pickerOpen = true;
		void (async () => {
			try {
				const options = models.map((model) => formatModelRef(model as ReasoningModel));
				const selected = await ctx.ui.select("Select model", options);
				const model = selected ? models.find((candidate) => formatModelRef(candidate as ReasoningModel) === selected) : undefined;
				if (!model) return;
				selectedModelRef = getModelRef(model as ReasoningModel);
				clampDefaultLevelToSelectedModel(ctx);
				await applyModelRef(selectedModelRef, ctx);
				defaultLevel = setEffectiveThinkingLevel(defaultLevel, ctx);
				if (ctx.isIdle()) activeLevel = defaultLevel;
			} finally {
				pickerOpen = false;
				updateStatus(ctx);
			}
		})();
	}

	function openReasoningPicker(ctx: ExtensionContext): void {
		if (pickerOpen) return;
		const levels = getSelectedSupportedLevels(ctx);
		if (levels.length === 0) return;
		pickerOpen = true;
		void (async () => {
			try {
				const selected = await ctx.ui.select("Select reasoning level", levels);
				const level = normalizeThinkingLevel(selected);
				if (level) setSelectedDefaultLevel(level, ctx);
			} finally {
				pickerOpen = false;
				updateStatus(ctx);
			}
		})();
	}

	function handleFieldInput(data: string, ctx: ExtensionContext): { consume?: boolean; data?: string } | undefined {
		if (pickerOpen) return undefined;
		if (isTabKey(data) || isShiftTabKey(data)) {
			if (fieldFocus === "prompt" && ctx.ui.getEditorText().trim().length > 0) return undefined;
			moveFieldFocus(isShiftTabKey(data) ? -1 : 1, ctx);
			return { consume: true };
		}

		if (fieldFocus === "prompt") return undefined;
		if (isCtrlCOrD(data)) {
			fieldFocus = "prompt";
			updateStatus(ctx);
			return undefined;
		}
		if (isEscapeKey(data)) {
			fieldFocus = "prompt";
			updateStatus(ctx);
			return { consume: true };
		}
		if (isPrintableInput(data) && data !== " ") {
			fieldFocus = "prompt";
			updateStatus(ctx);
			return { data };
		}

		if (fieldFocus === "model") {
			if (isEnterKey(data)) {
				openModelPicker(ctx);
				return { consume: true };
			}
			if (isForwardKey(data) || isBackwardKey(data)) {
				cycleSelectedModel(isBackwardKey(data) ? -1 : 1, ctx);
				return { consume: true };
			}
		}

		if (fieldFocus === "reasoning") {
			if (isEnterKey(data)) {
				openReasoningPicker(ctx);
				return { consume: true };
			}
			if (isForwardKey(data) || isBackwardKey(data)) {
				cycleSelectedReasoning(isBackwardKey(data) ? -1 : 1, ctx);
				return { consume: true };
			}
		}

		return { consume: true };
	}

	pi.on("session_start", (_event, ctx) => {
		selectedModelRef = getModelRef(ctx.model as ReasoningModel | undefined);
		defaultLevel = setEffectiveThinkingLevel(pi.getThinkingLevel(), ctx);
		activeLevel = defaultLevel;
		pendingLevels = [];
		fieldFocus = "prompt";
		updateStatus(ctx);

		if (ctx.hasUI) {
			unsubscribeTerminalInput?.();
			unsubscribeTerminalInput = ctx.ui.onTerminalInput((data) => handleFieldInput(data, ctx));
			ctx.ui.addAutocompleteProvider((current) => ({
				async getSuggestions(lines, line, col, options) {
					const beforeCursor = (lines[line] ?? "").slice(0, col);
					const match = beforeCursor.match(/(?:^|\s)\/(?:r|reason|reasoning|think|thinking)\s+(\S*)$/iu);
					if (!match) return current.getSuggestions(lines, line, col, options);
					const prefix = match[1] ?? "";
					const items = THINKING_LEVELS.filter((level) => level.startsWith(prefix.toLowerCase())).map((level) => ({
						value: level,
						label: level,
						description: "message reasoning level",
					}));
					return items.length > 0 ? { prefix, items } : null;
				},
				applyCompletion(lines, line, col, item, prefix) {
					return current.applyCompletion(lines, line, col, item, prefix);
				},
				shouldTriggerFileCompletion(lines, line, col) {
					return current.shouldTriggerFileCompletion?.(lines, line, col) ?? true;
				},
			}));
		}
	});

	pi.on("model_select", (_event, ctx) => {
		selectedModelRef = getModelRef(ctx.model as ReasoningModel | undefined);
		defaultLevel = setEffectiveThinkingLevel(pi.getThinkingLevel(), ctx);
		activeLevel = defaultLevel;
		pendingLevels = pendingLevels.map((pending) => {
			const pendingModel = resolveModelRef(ctx, pending.model) ?? (ctx.model as ReasoningModel | undefined);
			return { ...pending, level: clampReasoningLevel(pending.level, pendingModel as ReasoningModel | undefined) };
		});
		updateStatus(ctx);
	});

	pi.on("input", async (event, ctx) => {
		if (event.source === "extension") return { action: "continue" as const };
		fieldFocus = "prompt";
		if (ctx.isIdle() && pendingLevels.length > 0) pendingLevels = [];

		const parsed = parseReasoningDirective(event.text);
		if (parsed?.kind === "invalid") {
			ctx.ui.notify(`Invalid reasoning level${parsed.token ? ` "${parsed.token}"` : ""}. Valid levels: ${formatValidLevels()}`, "error");
			return { action: "handled" as const };
		}

		if (!parsed) {
			if (ctx.isIdle() && pendingLevels.length === 0 && currentModelMatchesSelected(ctx)) {
				defaultLevel = setEffectiveThinkingLevel(pi.getThinkingLevel(), ctx);
				activeLevel = defaultLevel;
				selectedModelRef = getModelRef(ctx.model as ReasoningModel | undefined);
			}
			pendingLevels.push({ text: event.text, level: defaultLevel, explicit: false, model: getPendingModelRef(ctx) });
			updateStatus(ctx);
			return { action: "continue" as const };
		}

		const effectiveLevel = setDefaultLevel(parsed.level, ctx);
		if (!parsed.rest.trim()) {
			activeLevel = effectiveLevel;
			ctx.ui.notify(`Reasoning level set to ${effectiveLevel}`, "info");
			updateStatus(ctx);
			return { action: "handled" as const };
		}

		pendingLevels.push({ text: parsed.rest, level: effectiveLevel, explicit: true, model: getPendingModelRef(ctx) });
		updateStatus(ctx);
		return { action: "transform" as const, text: parsed.rest, images: event.images };
	});

	pi.on("message_start", async (event, ctx) => {
		const messageText = getUserMessageText(event.message);
		if (messageText === undefined) return;
		const pending = takePendingLevel(messageText);
		await applyModelRef(pending?.model, ctx);
		applyActiveLevel(pending?.level ?? defaultLevel, ctx);
	});

	pi.on("before_provider_request", (event, ctx) => {
		const model = ctx.model as ReasoningModel | undefined;
		const level = ctx.model?.reasoning ? clampReasoningLevel(activeLevel, model) : "off";
		return rewriteProviderPayload(event.payload, level, model);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		unsubscribeTerminalInput?.();
		unsubscribeTerminalInput = undefined;
		if (!ctx.hasUI) return;
		ctx.ui.setStatus("reasoning-queue", undefined);
		ctx.ui.setWidget("reasoning-queue", undefined);
	});
}
