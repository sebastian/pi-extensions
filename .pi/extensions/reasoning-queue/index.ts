import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export type ReasoningModel = Pick<Model<any>, "api" | "id" | "name" | "provider" | "reasoning" | "compat" | "thinkingLevelMap" | "samplingParamsByThinkingLevel">;

export type ReasoningDirective =
	| { kind: "directive"; level: ThinkingLevel; rest: string; syntax: "slash" | "colon" | "bracket" }
	| { kind: "invalid"; token?: string; syntax: "slash" | "bracket" };

interface PendingReasoningLevel {
	text: string;
	level: ThinkingLevel;
}

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
	max: "max",
};

const SLASH_DIRECTIVE_PATTERN = /^\/(?:r|reason|reasoning|think|thinking)(?:\s+(\S+))?(?:\s+([\s\S]*))?$/iu;
const COLON_DIRECTIVE_PATTERN = /^:(\S+)(?:\s+([\s\S]*))?$/iu;
const BRACKET_DIRECTIVE_PATTERN = /^\[(?:r|reason|reasoning|think|thinking):\s*([^\]\s]+)\s*\](?:\s*([\s\S]*))?$/iu;

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

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function modelSupportsXhigh(model: ReasoningModel | undefined): boolean {
	const value = `${model?.id ?? ""} ${model?.name ?? ""}`.toLowerCase();
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
		value.includes("opus-5") ||
		value.includes("opus 5") ||
		value.includes("fable-5")
	);
}

function parseSupportedLevels(value: unknown): ThinkingLevel[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const levels = value.flatMap((item) => {
		if (typeof item !== "string") return [];
		const level = normalizeThinkingLevel(item);
		return level ? [level] : [];
	});
	return levels.length > 0 ? THINKING_LEVELS.filter((level) => level === "off" || levels.includes(level)) : undefined;
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

	// Standard levels default to supported; extended xhigh/max require explicit mappings.
	const offered = THINKING_LEVELS.filter((level) => {
		const mapped = map[level];
		if (mapped === null) return false;
		if (level === "xhigh" || level === "max") return mapped !== undefined;
		return true;
	});

	if (model?.samplingParamsByThinkingLevel) return offered;

	// ponytail: keep only the highest-ranked level per explicit provider value; levels
	// left to provider defaults remain distinct. Use pi's native choices if aliases matter.
	const claimed = new Set<string>();
	const kept: ThinkingLevel[] = [];
	for (let i = offered.length - 1; i >= 0; i--) {
		const level = offered[i];
		const mapped = map[level];
		if (typeof mapped !== "string") {
			kept.push(level);
			continue;
		}
		if (claimed.has(mapped)) continue;
		claimed.add(mapped);
		kept.push(level);
	}
	return kept.reverse();
}

export function getSupportedReasoningLevels(model: ReasoningModel | undefined): ThinkingLevel[] {
	if (model?.reasoning === false) return ["off"];

	const thinkingLevelMapLevels = getThinkingLevelMapSupportedLevels(model);
	if (thinkingLevelMapLevels) return thinkingLevelMapLevels;

	const explicit = getExplicitSupportedLevels(model);
	if (explicit) return explicit;

	const thinkingFormat = model?.compat?.thinkingFormat;
	if (thinkingFormat === "zai" || thinkingFormat === "qwen" || thinkingFormat === "qwen-chat-template" || (model?.api ?? "").includes("mistral")) return ["off", "high"];
	if ((model?.id ?? "").toLowerCase().split("/").pop() === "gpt-5.1-codex-mini") return ["off", "medium", "high"];
	if (modelSupportsXhigh(model)) return THINKING_LEVELS.filter((level) => level !== "max");
	return THINKING_LEVELS.filter((level) => level !== "xhigh" && level !== "max");
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

function getUserMessageText(message: unknown): string | undefined {
	if (!isRecord(message) || message.role !== "user") return undefined;
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return undefined;
	const textBlocks = content.filter((block): block is { type: "text"; text: string } => isRecord(block) && block.type === "text" && typeof block.text === "string");
	return textBlocks.length > 0 ? textBlocks.map((block) => block.text).join("\n") : undefined;
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

export default function reasoningQueueExtension(pi: ExtensionAPI): void {
	let defaultLevel: ThinkingLevel = "medium";
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
		pendingLevels = pendingLevels.map((pending) => ({ ...pending, level: clampReasoningLevel(pending.level, ctx.model as ReasoningModel | undefined) }));
		updateStatus(ctx);
	});

	pi.on("thinking_level_select", (event, ctx) => {
		const selected = normalizeThinkingLevel(event.level);
		if (!selected) return;
		defaultLevel = clampReasoningLevel(selected, ctx.model as ReasoningModel | undefined);
		updateStatus(ctx);
	});

	pi.on("input", async (event, ctx) => {
		if (event.source === "extension") return { action: "continue" as const };
		const queuedInput = inputIsQueued(event);
		const idleInput = !queuedInput && contextIsIdle(ctx);
		if ((idleInput || (queuedInput && !ctx.hasPendingMessages())) && pendingLevels.length > 0) pendingLevels = [];

		const parsed = parseReasoningDirective(event.text);
		if (parsed?.kind === "invalid") {
			ctx.ui.notify(`Invalid reasoning level${parsed.token ? ` "${parsed.token}"` : ""}. Valid levels: ${THINKING_LEVELS.join(", ")}`, "error");
			return { action: "handled" as const };
		}

		if (!parsed) {
			if (idleInput && pendingLevels.length === 0) defaultLevel = setEffectiveThinkingLevel(pi.getThinkingLevel(), ctx);
			pendingLevels.push({ text: event.text, level: defaultLevel });
			updateStatus(ctx);
			return { action: "continue" as const };
		}

		const effectiveLevel = queuedInput
			? clampReasoningLevel(parsed.level, ctx.model as ReasoningModel | undefined)
			: setEffectiveThinkingLevel(parsed.level, ctx);
		defaultLevel = effectiveLevel;
		if (!parsed.rest.trim()) {
			ctx.ui.notify(`Reasoning level ${queuedInput ? "queued" : "set"} to ${effectiveLevel}`, "info");
			updateStatus(ctx);
			return { action: "handled" as const };
		}

		pendingLevels.push({ text: parsed.rest, level: effectiveLevel });
		updateStatus(ctx);
		return { action: "transform" as const, text: parsed.rest, images: event.images };
	});

	pi.on("message_start", (event, ctx) => {
		const messageText = getUserMessageText(event.message);
		if (messageText === undefined) return;
		const pending = takePendingLevel(messageText);
		// Pi refreshes request options after this event, including native reasoning and sampling.
		setEffectiveThinkingLevel(pending?.level ?? defaultLevel, ctx);
		updateStatus(ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		if (ctx.hasUI) ctx.ui.setStatus("reasoning-queue", undefined);
	});
}
