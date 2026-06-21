import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export type ReasoningModel = Pick<Model<any>, "api" | "id" | "name" | "provider" | "reasoning" | "maxTokens" | "compat" | "baseUrl"> & {
	thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>>;
};

export type ReasoningDirective =
	| { kind: "directive"; level: ThinkingLevel; rest: string; syntax: "slash" | "colon" | "bracket" }
	| { kind: "invalid"; token?: string; syntax: "slash" | "bracket" };

interface PendingReasoningLevel {
	text: string;
	level: ThinkingLevel;
	explicit: boolean;
	streamingBehavior?: "steer" | "followUp";
}

type JsonRecord = Record<string, unknown>;

const LEVEL_ALIASES: Record<string, ThinkingLevel> = {
	"0": "off",
	false: "off",
	no: "off",
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

function isPlainRecord(value: unknown): value is JsonRecord {
	if (!isRecord(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function clonePlain<T>(value: T): T {
	if (Array.isArray(value)) return value.map((item) => clonePlain(item)) as T;
	if (!isPlainRecord(value)) return value;
	const result: JsonRecord = {};
	for (const [key, item] of Object.entries(value)) result[key] = clonePlain(item);
	return result as T;
}

function modelSearchText(model: ReasoningModel | undefined): string {
	return `${model?.id ?? ""} ${model?.name ?? ""}`.toLowerCase();
}

function modelSupportsXhigh(model: ReasoningModel | undefined): boolean {
	const value = modelSearchText(model);
	return (
		value.includes("gpt-5.2") ||
		value.includes("gpt-5.3") ||
		value.includes("gpt-5.4") ||
		value.includes("gpt-5.5") ||
		value.includes("deepseek-v4-pro") ||
		value.includes("opus-4-6") ||
		value.includes("opus-4.6") ||
		value.includes("opus-4-7") ||
		value.includes("opus-4.7") ||
		value.includes("opus-4-8") ||
		value.includes("opus-4.8") ||
		value.includes("fable-5")
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

function getThinkingLevelMapSupportedLevels(model: ReasoningModel | undefined): ThinkingLevel[] | undefined {
	const map = model?.thinkingLevelMap;
	if (!isRecord(map)) return undefined;
	return THINKING_LEVELS.filter((level) => {
		const mapped = map[level];
		if (mapped === null) return false;
		if (level === "xhigh") return mapped !== undefined;
		return true;
	});
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

	const thinkingLevelMapLevels = getThinkingLevelMapSupportedLevels(model);
	if (thinkingLevelMapLevels) return thinkingLevelMapLevels;

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

function getReasoningEffort(level: ThinkingLevel, model: ReasoningModel | undefined): string | undefined {
	if (level === "off") return undefined;
	const clamped = clampReasoningLevel(level, model);
	const tlm = model?.thinkingLevelMap;
	if (tlm && clamped in tlm) {
		const mapped = tlm[clamped];
		return typeof mapped === "string" ? mapped : clamped;
	}
	const map = isRecord(model?.compat?.reasoningEffortMap) ? model.compat.reasoningEffortMap : undefined;
	const mapped = map?.[clamped];
	return typeof mapped === "string" ? mapped : clamped;
}

function getOffReasoningEffort(model: ReasoningModel | undefined, fallback = "none"): string | undefined {
	const mapped = model?.thinkingLevelMap?.off;
	if (mapped === null) return undefined;
	return typeof mapped === "string" ? mapped : fallback;
}

function withReasoningInclude(payload: JsonRecord): void {
	const include = Array.isArray(payload.include) ? [...payload.include] : [];
	if (!include.includes("reasoning.encrypted_content")) include.push("reasoning.encrypted_content");
	payload.include = include;
}

function clampCodexReasoningEffort(level: Exclude<ThinkingLevel, "off">, modelId = ""): string {
	const id = modelId.includes("/") ? modelId.split("/").pop()! : modelId;
	if ((id.startsWith("gpt-5.2") || id.startsWith("gpt-5.3") || id.startsWith("gpt-5.4") || id.startsWith("gpt-5.5")) && level === "minimal") return "low";
	if (id === "gpt-5.1" && level === "xhigh") return "high";
	if (id === "gpt-5.1-codex-mini") return level === "high" || level === "xhigh" ? "high" : "medium";
	return level;
}

function applyResponsesPayload(payload: JsonRecord, level: ThinkingLevel, model: ReasoningModel | undefined): JsonRecord {
	if (model?.reasoning === false) {
		delete payload.reasoning;
		return payload;
	}

	const isCodex = model?.api === "openai-codex-responses";
	if (level === "off") {
		const offEffort = getOffReasoningEffort(model);
		if (isCodex || offEffort === undefined) delete payload.reasoning;
		else payload.reasoning = { effort: offEffort };
		return payload;
	}

	const effort = isCodex ? clampCodexReasoningEffort(clampReasoningLevel(level, model) as Exclude<ThinkingLevel, "off">, model?.id) : getReasoningEffort(level, model);
	payload.reasoning = {
		...(isRecord(payload.reasoning) ? payload.reasoning : {}),
		effort,
		summary: isRecord(payload.reasoning) && typeof payload.reasoning.summary === "string" ? payload.reasoning.summary : "auto",
	};
	withReasoningInclude(payload);
	return payload;
}

function applyOpenAICompletionsPayload(payload: JsonRecord, level: ThinkingLevel, model: ReasoningModel | undefined): JsonRecord {
	const enabled = level !== "off" && model?.reasoning !== false;
	const effort = getReasoningEffort(level, model);
	const thinkingFormat = typeof model?.compat?.thinkingFormat === "string" ? model.compat.thinkingFormat : undefined;

	if ("enable_thinking" in payload || thinkingFormat === "zai" || thinkingFormat === "qwen") payload.enable_thinking = enabled;
	// qwen-chat-template owns its own enable_thinking kwarg; pi 0.79.9+ chat-template models
	// drive chat_template_kwargs entirely from compat.chatTemplateKwargs + the active thinking
	// level, so leave them untouched rather than overwriting with the qwen shape.
	if ((isRecord(payload.chat_template_kwargs) && thinkingFormat !== "chat-template") || thinkingFormat === "qwen-chat-template") {
		payload.chat_template_kwargs = { ...(isRecord(payload.chat_template_kwargs) ? payload.chat_template_kwargs : {}), enable_thinking: enabled, preserve_thinking: true };
	}
	if (isRecord(payload.thinking) || thinkingFormat === "deepseek") {
		payload.thinking = { ...(isRecord(payload.thinking) ? payload.thinking : {}), type: enabled ? "enabled" : "disabled" };
		if (enabled && effort) payload.reasoning_effort = effort;
		else delete payload.reasoning_effort;
	}

	const supportsReasoningEffort = model?.compat?.supportsReasoningEffort !== false;
	if (thinkingFormat === "together") {
		payload.reasoning = { ...(isRecord(payload.reasoning) ? payload.reasoning : {}), enabled };
		if (enabled && effort && supportsReasoningEffort) payload.reasoning_effort = effort;
		else delete payload.reasoning_effort;
	} else if (isRecord(payload.reasoning) || thinkingFormat === "openrouter") {
		const offEffort = getOffReasoningEffort(model);
		if (enabled && effort) payload.reasoning = { ...(isRecord(payload.reasoning) ? payload.reasoning : {}), effort };
		else if (offEffort !== undefined) payload.reasoning = { ...(isRecord(payload.reasoning) ? payload.reasoning : {}), effort: offEffort };
		else delete payload.reasoning;
	}

	const shouldUseOpenAIReasoningEffort = !thinkingFormat || thinkingFormat === "openai" || "reasoning_effort" in payload || "reasoningEffort" in payload;
	if (supportsReasoningEffort && shouldUseOpenAIReasoningEffort) {
		if (enabled && effort) payload.reasoning_effort = effort;
		else delete payload.reasoning_effort;
	}
	return payload;
}

function getForceAdaptiveThinking(model: ReasoningModel | undefined): boolean | undefined {
	const compat = isRecord(model?.compat) ? model.compat : undefined;
	return typeof compat?.forceAdaptiveThinking === "boolean" ? compat.forceAdaptiveThinking : undefined;
}

function supportsAdaptiveAnthropic(model: ReasoningModel | undefined): boolean {
	const forced = getForceAdaptiveThinking(model);
	if (forced !== undefined) return forced;
	const value = modelSearchText(model);
	return (
		value.includes("opus-4-6") ||
		value.includes("opus-4.6") ||
		value.includes("opus-4-7") ||
		value.includes("opus-4.7") ||
		value.includes("opus-4-8") ||
		value.includes("opus-4.8") ||
		value.includes("sonnet-4-6") ||
		value.includes("sonnet-4.6") ||
		value.includes("sonnet-4-7") ||
		value.includes("sonnet-4.7") ||
		value.includes("fable-5")
	);
}

function mapAnthropicEffort(level: Exclude<ThinkingLevel, "off">, model: ReasoningModel | undefined): string {
	const mapped = model?.thinkingLevelMap?.[level];
	if (typeof mapped === "string") return mapped;
	const modelId = modelSearchText(model);
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
			if (modelId.includes("opus-4-7") || modelId.includes("opus-4.7") || modelId.includes("opus-4-8") || modelId.includes("opus-4.8") || modelId.includes("fable-5")) return "xhigh";
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
		payload.output_config = { ...(isRecord(payload.output_config) ? payload.output_config : {}), effort: mapAnthropicEffort(clamped, model) };
		return;
	}

	const budget = DEFAULT_ANTHROPIC_BUDGETS[clamped];
	payload.thinking = { type: "enabled", budget_tokens: budget, display };
	const maxTokens = typeof payload.max_tokens === "number" ? payload.max_tokens : undefined;
	const modelMaxTokens = typeof model?.maxTokens === "number" && model.maxTokens > 0 ? model.maxTokens : undefined;
	const minimumUsefulMaxTokens = budget + 1024;
	if (maxTokens === undefined || maxTokens <= budget) payload.max_tokens = modelMaxTokens ? Math.min(modelMaxTokens, minimumUsefulMaxTokens) : minimumUsefulMaxTokens;
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
	if (isGemini3FlashModel(model) || isGemma4Model(model)) return { thinkingLevel: "MINIMAL" };
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
	if (id.includes("2.5-pro")) return { minimal: 128, low: 2048, medium: 8192, high: 32768, xhigh: 32768 }[level];
	if (id.includes("2.5-flash-lite")) return { minimal: 512, low: 2048, medium: 8192, high: 24576, xhigh: 24576 }[level];
	if (id.includes("2.5-flash")) return { minimal: 128, low: 2048, medium: 8192, high: 24576, xhigh: 24576 }[level];
	return DEFAULT_GENERIC_BUDGETS[level] ?? -1;
}

function getGoogleThinkingConfig(model: ReasoningModel | undefined, level: ThinkingLevel): JsonRecord {
	if (level === "off" || model?.reasoning === false) return getDisabledGoogleThinkingConfig(model);
	const clamped = clampReasoningLevel(level, model) as Exclude<ThinkingLevel, "off">;
	if (isGemini3ProModel(model) || isGemini3FlashModel(model) || isGemma4Model(model)) return { includeThoughts: true, thinkingLevel: getGoogleThinkingLevel(clamped, model) };
	return { includeThoughts: true, thinkingBudget: getGoogleBudget(model, clamped) };
}

function applyGooglePayload(payload: JsonRecord, level: ThinkingLevel, model: ReasoningModel | undefined): JsonRecord {
	const target = isRecord(payload.config) ? payload.config : isRecord(payload.generationConfig) ? payload.generationConfig : undefined;
	if (target) target.thinkingConfig = getGoogleThinkingConfig(model, level);
	else payload.config = { thinkingConfig: getGoogleThinkingConfig(model, level) };
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
	const offEffort = getOffReasoningEffort(model);
	if ("reasoning_effort" in payload) {
		if (enabled && effort) payload.reasoning_effort = effort;
		else delete payload.reasoning_effort;
	}
	if ("reasoningEffort" in payload) {
		if (enabled && effort) payload.reasoningEffort = effort;
		else delete payload.reasoningEffort;
	}
	if ("enable_thinking" in payload) payload.enable_thinking = enabled;
	if (isRecord(payload.reasoning) && "enabled" in payload.reasoning) payload.reasoning = { ...payload.reasoning, enabled };
	if (isRecord(payload.reasoning) && "effort" in payload.reasoning) {
		if (enabled && effort) payload.reasoning = { ...payload.reasoning, effort };
		else if (offEffort !== undefined) payload.reasoning = { ...payload.reasoning, effort: offEffort };
		else delete payload.reasoning;
	}
	if (isRecord(payload.thinking) && "type" in payload.thinking) payload.thinking = { ...payload.thinking, type: enabled ? "enabled" : "disabled" };
	if (isRecord(payload.config) && "thinkingConfig" in payload.config) payload.config.thinkingConfig = getGoogleThinkingConfig(model, level);
	if (isRecord(payload.generationConfig) && "thinkingConfig" in payload.generationConfig) payload.generationConfig.thinkingConfig = getGoogleThinkingConfig(model, level);
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
	const textBlocks = content.filter((block): block is { type: "text"; text: string } => isRecord(block) && block.type === "text" && typeof block.text === "string");
	return textBlocks.length > 0 ? textBlocks.map((block) => block.text).join("\n") : undefined;
}

function formatValidLevels(): string {
	return THINKING_LEVELS.join(", ");
}

function contextIsIdle(ctx: ExtensionContext): boolean {
	const isIdle = (ctx as unknown as { isIdle?: unknown }).isIdle;
	return typeof isIdle === "function" ? Boolean(isIdle.call(ctx)) : true;
}

function contextIsTui(ctx: ExtensionContext): boolean {
	const mode = (ctx as unknown as { mode?: unknown }).mode;
	return mode === "tui" || (mode === undefined && ctx.hasUI);
}

function inputIsQueued(event: { streamingBehavior?: unknown }): event is { streamingBehavior: "steer" | "followUp" } {
	return event.streamingBehavior === "steer" || event.streamingBehavior === "followUp";
}

function modelMatchesReference(model: Pick<ReasoningModel, "provider" | "id"> | undefined, value: string | undefined): boolean {
	if (!model || !value) return false;
	const normalized = value.trim().toLowerCase();
	return model.id.toLowerCase() === normalized || `${model.provider}/${model.id}`.toLowerCase() === normalized;
}

function uniqueModels(models: Model<any>[]): Model<any>[] {
	const seen = new Set<string>();
	const result: Model<any>[] = [];
	for (const model of models) {
		const key = `${model.provider}/${model.id}`.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		result.push(model);
	}
	return result;
}

function findExactModelReferenceMatch(modelReference: string, models: Model<any>[]): Model<any> | undefined {
	const normalized = modelReference.trim().toLowerCase();
	if (!normalized) return undefined;
	const canonicalMatches = models.filter((model) => `${model.provider}/${model.id}`.toLowerCase() === normalized);
	if (canonicalMatches.length === 1) return canonicalMatches[0];
	if (canonicalMatches.length > 1) return undefined;

	const slashIndex = modelReference.indexOf("/");
	if (slashIndex !== -1) {
		const provider = modelReference.slice(0, slashIndex).trim().toLowerCase();
		const id = modelReference.slice(slashIndex + 1).trim().toLowerCase();
		const providerMatches = models.filter((model) => model.provider.toLowerCase() === provider && model.id.toLowerCase() === id);
		if (providerMatches.length === 1) return providerMatches[0];
		if (providerMatches.length > 1) return undefined;
	}

	const idMatches = models.filter((model) => model.id.toLowerCase() === normalized);
	return idMatches.length === 1 ? idMatches[0] : undefined;
}

function getRegistryModels(ctx: ExtensionContext): Model<any>[] {
	const models: Model<any>[] = [];
	try {
		models.push(...ctx.modelRegistry.getAvailable());
	} catch {}
	try {
		models.push(...(ctx.modelRegistry.getAll?.() ?? []));
	} catch {}
	if (ctx.model) models.push(ctx.model);
	return uniqueModels(models);
}

function getPayloadModelReference(payload: unknown): string | undefined {
	if (!isRecord(payload)) return undefined;
	if (typeof payload.model === "string") return payload.model;
	if (typeof payload.modelId === "string") return payload.modelId;
	return undefined;
}

function resolvePayloadModel(payload: unknown, ctx: ExtensionContext): Model<any> | undefined {
	const payloadModel = getPayloadModelReference(payload);
	if (!payloadModel) return ctx.model;
	if (modelMatchesReference(ctx.model as ReasoningModel | undefined, payloadModel)) return ctx.model;
	return findExactModelReferenceMatch(payloadModel, getRegistryModels(ctx));
}

export default function reasoningQueueExtension(pi: ExtensionAPI): void {
	let defaultLevel: ThinkingLevel = "medium";
	let activeLevel: ThinkingLevel = defaultLevel;
	let pendingLevels: PendingReasoningLevel[] = [];

	function updateStatus(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		ctx.ui.setStatus("reasoning-queue", ctx.ui.theme.fg("dim", `reasoning:${defaultLevel}`));
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
		if (contextIsIdle(ctx)) activeLevel = effectiveLevel;
		updateStatus(ctx);
		return effectiveLevel;
	}

	function setQueuedDefaultLevel(level: ThinkingLevel, ctx: ExtensionContext): ThinkingLevel {
		const effectiveLevel = clampReasoningLevel(level, ctx.model as ReasoningModel | undefined);
		defaultLevel = effectiveLevel;
		updateStatus(ctx);
		return effectiveLevel;
	}

	function applyActiveLevel(level: ThinkingLevel, ctx: ExtensionContext): void {
		activeLevel = setEffectiveThinkingLevel(level, ctx);
		updateStatus(ctx);
	}

	function takePendingLevel(messageText: string | undefined): PendingReasoningLevel | undefined {
		if (pendingLevels.length === 0) return undefined;
		if (messageText) {
			const exactIndex = pendingLevels.findIndex((pending) => pending.text === messageText);
			if (exactIndex !== -1) return pendingLevels.splice(exactIndex, 1)[0];
		}
		return pendingLevels.shift();
	}

	pi.on("session_start", (_event, ctx) => {
		defaultLevel = setEffectiveThinkingLevel(pi.getThinkingLevel(), ctx);
		activeLevel = defaultLevel;
		pendingLevels = [];
		updateStatus(ctx);

		if (contextIsTui(ctx)) {
			ctx.ui.addAutocompleteProvider((current) => ({
				triggerCharacters: ["/", ":", "["],
				async getSuggestions(lines, line, col, options) {
					const beforeCursor = (lines[line] ?? "").slice(0, col);
					const slash = beforeCursor.match(/(?:^|\s)\/(?:r|reason|reasoning|think|thinking)\s+(\S*)$/iu);
					const colon = beforeCursor.match(/(?:^|\s):([^\s:]*)$/iu);
					const bracket = beforeCursor.match(/\[(?:r|reason|reasoning|think|thinking):\s*([^\]\s]*)$/iu);

					let prefix: string | undefined;
					let valuePrefix = "";
					if (slash) prefix = slash[1] ?? "";
					else if (colon) {
						prefix = `:${colon[1] ?? ""}`;
						valuePrefix = ":";
					} else if (bracket) prefix = bracket[1] ?? "";
					if (prefix === undefined) return current.getSuggestions(lines, line, col, options);

					const query = valuePrefix ? prefix.slice(valuePrefix.length).toLowerCase() : prefix.toLowerCase();
					const items = THINKING_LEVELS.filter((level) => level.startsWith(query)).map((level) => ({ value: `${valuePrefix}${level}`, label: level, description: "message reasoning level" }));
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
		defaultLevel = setEffectiveThinkingLevel(pi.getThinkingLevel(), ctx);
		if (contextIsIdle(ctx)) activeLevel = defaultLevel;
		pendingLevels = pendingLevels.map((pending) => ({ ...pending, level: clampReasoningLevel(pending.level, ctx.model as ReasoningModel | undefined) }));
		updateStatus(ctx);
	});

	pi.on("thinking_level_select", (event, ctx) => {
		const selected = normalizeThinkingLevel(event.level);
		if (!selected) return;
		const effective = clampReasoningLevel(selected, ctx.model as ReasoningModel | undefined);
		defaultLevel = effective;
		if (contextIsIdle(ctx)) activeLevel = effective;
		updateStatus(ctx);
	});

	pi.on("input", async (event, ctx) => {
		if (event.source === "extension") return { action: "continue" as const };
		const queuedInput = inputIsQueued(event);
		const idleInput = !queuedInput && contextIsIdle(ctx);
		if (idleInput && pendingLevels.length > 0) pendingLevels = [];

		const parsed = parseReasoningDirective(event.text);
		if (parsed?.kind === "invalid") {
			ctx.ui.notify(`Invalid reasoning level${parsed.token ? ` "${parsed.token}"` : ""}. Valid levels: ${formatValidLevels()}`, "error");
			return { action: "handled" as const };
		}

		if (!parsed) {
			if (idleInput && pendingLevels.length === 0) {
				defaultLevel = setEffectiveThinkingLevel(pi.getThinkingLevel(), ctx);
				activeLevel = defaultLevel;
			}
			pendingLevels.push({ text: event.text, level: defaultLevel, explicit: false, streamingBehavior: event.streamingBehavior });
			updateStatus(ctx);
			return { action: "continue" as const };
		}

		const effectiveLevel = queuedInput ? setQueuedDefaultLevel(parsed.level, ctx) : setDefaultLevel(parsed.level, ctx);
		if (!parsed.rest.trim()) {
			if (!queuedInput) activeLevel = effectiveLevel;
			ctx.ui.notify(`Reasoning level ${queuedInput ? "queued" : "set"} to ${effectiveLevel}`, "info");
			updateStatus(ctx);
			return { action: "handled" as const };
		}

		pendingLevels.push({ text: parsed.rest, level: effectiveLevel, explicit: true, streamingBehavior: event.streamingBehavior });
		updateStatus(ctx);
		return { action: "transform" as const, text: parsed.rest, images: event.images };
	});

	pi.on("message_start", async (event, ctx) => {
		const messageText = getUserMessageText(event.message);
		if (messageText === undefined) return;
		const pending = takePendingLevel(messageText);
		applyActiveLevel(pending?.level ?? defaultLevel, ctx);
	});

	pi.on("before_provider_request", (event, ctx) => {
		const model = resolvePayloadModel(event.payload, ctx) as ReasoningModel | undefined;
		const level = model?.reasoning ? clampReasoningLevel(activeLevel, model) : "off";
		return rewriteProviderPayload(event.payload, level, model);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		if (ctx.hasUI) ctx.ui.setStatus("reasoning-queue", undefined);
	});
}
